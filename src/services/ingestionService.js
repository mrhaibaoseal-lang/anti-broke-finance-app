'use strict';

const {
  EXACT_BLOCK_WINDOW_SECONDS,
  FLOW_TYPES,
  PAYMENT_MEDIA,
  DEDUPE_STATUS
} = require('../config/constants');
const { TW_BANK_CODES } = require('../config/merchantRules');
const { getSettings, updateSettings } = require('../repositories/settingsRepo');
const {
  getEntryById,
  insertEntry,
  updateEntryFields
} = require('../repositories/ledgerRepo');
const {
  getRecentLedgerCandidates,
  insertIngestionLog
} = require('../repositories/dedupeRepo');
const {
  upsertSplitBill,
  markSplitBillRepaid,
  listAllSplitBills
} = require('../repositories/splitBillRepo');
const { applyTankDelta } = require('../repositories/walletTankRepo');
const { getTaipeiNowParts, ensureCurrentBudgetCycle } = require('./budgetEngine');
const { toHalfWidth, normalizeMerchant, classifyMerchantAndFlow } = require('./merchantClassifier');
const { deleteAndRollbackLedgerEntry } = require('./splitAndTankService');

/**
 * 產生標準化去重指紋：{Direction}|{Amount}|{IdentityKey}
 */
function buildDedupeFingerprint({ direction = 'OUT', amount = 0, normalizedMerchant = '', cardLast4 = '' }) {
  const dir = String(direction || 'OUT').toUpperCase() === 'IN' ? 'IN' : 'OUT';
  const amt = Math.round(Number(amount) || 0);
  const identity = String(cardLast4 || normalizedMerchant || 'UNKNOWN').trim().toUpperCase();
  return `${dir}|${amt}|${identity}`;
}

/**
 * 雙層 10 分鐘防重複入帳檢查器 (Deduplication Engine)
 * - 第一層 (2 分鐘內同來源通道 + 同指紋，或完全相同原始 payload) ➔ 自動攔截 BLOCKED_DUPLICATE
 * - 第二層 (10 分鐘內同指紋，或同方向+同金額跨通道/相近通知) ➔ 標記 SUSPECTED_DUPLICATE 待使用者確認 (暫不扣預算)
 */
async function evaluateDeduplication(db, {
  direction = 'OUT',
  amount,
  normalizedMerchant,
  cardLast4 = '',
  sourceChannel = 'manual',
  rawPayload = '',
  nowIso
}) {
  const settings = await getSettings(db);
  const windowMinutes = Math.max(1, Number(settings.dedupe_window_minutes) || 10);
  const windowMs = windowMinutes * 60 * 1000;
  // 5 秒內視為「同一次刷卡觸發雙捷徑或網路瞬間重試」直接攔截；
  // 超過 5 秒 ~ 10 分鐘內之同金額交易則進入 SUSPECTED_DUPLICATE，讓使用者在首頁一鍵點「✅ 真的買兩次」確認入帳，絕不吃帳！
  const instantMergeMs = 5 * 1000;

  const nowMs = new Date(nowIso || Date.now()).getTime();
  const primaryFingerprint = buildDedupeFingerprint({ direction, amount, normalizedMerchant, cardLast4 });
  const dirPrefix = `${String(direction || 'OUT').toUpperCase() === 'IN' ? 'IN' : 'OUT'}|${Math.round(Number(amount) || 0)}|`;

  const candidates = await getRecentLedgerCandidates(db, 40);

  for (const prev of candidates) {
    const prevMs = new Date(prev.tx_timestamp || prev.created_at).getTime();
    const diffMs = Math.abs(nowMs - prevMs);
    if (diffMs > windowMs) continue;

    const isSameExactPayload = Boolean(
      rawPayload &&
      prev.raw_payload &&
      String(rawPayload).trim() === String(prev.raw_payload).trim()
    );
    const isSamePrimaryFingerprint = prev.dedupe_fingerprint === primaryFingerprint;
    const isSameDirectionAndAmount = Boolean(
      prev.dedupe_fingerprint &&
      String(prev.dedupe_fingerprint).startsWith(dirPrefix) &&
      Number(prev.amount) === Math.round(Number(amount) || 0)
    );

    // 層級 1：5 秒內雙捷徑同時觸發或瞬間網路重送 ➔ 自動攔截不重複寫入
    const isInstantDualTrigger = diffMs <= instantMergeMs && (isSameExactPayload || isSamePrimaryFingerprint || isSameDirectionAndAmount);
    if (isInstantDualTrigger) {
      return {
        decision: 'BLOCKED_DUPLICATE',
        fingerprint: primaryFingerprint,
        matchedEntry: prev,
        diffSeconds: Math.round(diffMs / 1000)
      };
    }

    // 層級 2：5 秒 ~ 10 分鐘內相同金額與方向/商家 (例如隔了 15 秒真的連刷第二筆同價商品) ➔ 絕不吃帳，標記為疑似重複待確認！
    if (isSamePrimaryFingerprint || isSameDirectionAndAmount) {
      return {
        decision: 'FLAGGED_SUSPECTED',
        fingerprint: primaryFingerprint,
        matchedEntry: prev,
        diffSeconds: Math.round(diffMs / 1000)
      };
    }
  }

  return {
    decision: 'ACCEPTED',
    fingerprint: primaryFingerprint,
    matchedEntry: null,
    diffSeconds: null
  };
}

async function resolveSuspectedDuplicateEntry(db, entryId, decision = 'DELETE') {
  const entry = await getEntryById(db, entryId);
  if (!entry) throw new Error('找不到該筆疑似重複紀錄');

  if (decision === 'DELETE') {
    return await deleteAndRollbackLedgerEntry(db, entry.id);
  }

  let budgetImpact = 0;
  let cashDelta = 0;
  let easyDelta = 0;
  const cls = classifyMerchantAndFlow(entry.raw_merchant, entry.normalized_merchant, entry.note);

  if (entry.flow_type === FLOW_TYPES.EXPENSE) {
    budgetImpact = entry.payment_medium === PAYMENT_MEDIA.DIGITAL_BANK ? Number(entry.amount) : 0;
  } else if (entry.flow_type === FLOW_TYPES.INTERNAL_TRANSFER) {
    if (cls.autoTankTransferType === 'EASYCARD') {
      budgetImpact = Number(entry.amount);
      easyDelta = Number(entry.amount);
      await applyTankDelta(db, {
        tankType: 'EASYCARD',
        deltaAmount: easyDelta,
        note: `✅ 確認入帳加值悠遊卡：${entry.normalized_merchant}`,
        linkedEntryId: entry.id
      });
    } else if (cls.autoTankTransferType === 'CASH') {
      budgetImpact = Number(entry.amount);
      cashDelta = Number(entry.amount);
      await applyTankDelta(db, {
        tankType: 'CASH',
        deltaAmount: cashDelta,
        note: `✅ 確認入帳 ATM 提款：${entry.normalized_merchant}`,
        linkedEntryId: entry.id
      });
    }
  } else if (entry.flow_type === FLOW_TYPES.ADVANCE_OUT) {
    await upsertSplitBill(db, {
      ledgerEntryId: entry.id,
      debtorName: entry.raw_merchant || '朋友',
      totalAmount: Number(entry.amount),
      selfAmount: 0,
      receivableAmount: Number(entry.amount)
    });
  }

  const cleanNote = String(entry.note || '').replace(/^⚠️\s*\[疑似重複待確認\]\s*/, '✅ [已確認第2筆] ');
  const updated = await updateEntryFields(db, entry.id, {
    flowType: entry.flow_type,
    paymentMedium: entry.payment_medium,
    dedupeStatus: DEDUPE_STATUS.CONFIRMED,
    rawMerchant: entry.raw_merchant,
    normalizedMerchant: entry.normalized_merchant,
    category: entry.category,
    amount: entry.amount,
    budgetImpactAmount: budgetImpact,
    cashDelta,
    easycardDelta: easyDelta,
    txDate: entry.tx_date,
    note: cleanNote
  });

  return { confirmedEntry: updated };
}

async function ingestApplePayTransaction(db, payload = {}) {
  const rawTimestamp = payload.timestamp || new Date().toISOString();
  const parsedDt = new Date(rawTimestamp);
  const nowIso = Number.isNaN(parsedDt.getTime()) ? new Date().toISOString() : parsedDt.toISOString();
  const tp = getTaipeiNowParts(nowIso);
  const txDate = (payload.referenceDate || tp.dateStr).slice(0, 10);

  const rawAmtStr = toHalfWidth(String(payload.amount ?? payload.money ?? payload.price ?? '')).replace(/,/g, '').trim();
  const amtMatch = rawAmtStr.match(/(\d+(?:\.\d+)?)/);
  const amount = amtMatch ? Math.round(Number(amtMatch[1])) : 0;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Apple Pay 交易金額必須大於 0');
  }

  const rawMerchant = String(payload.merchant || payload.store || payload.shop || payload.name || '未知商店').trim() || '未知商店';
  const cardName = String(payload.card_name || payload.cardName || payload.card || 'Apple Pay').trim() || 'Apple Pay';
  const last4Match = cardName.match(/(\d{4})\b/);
  const cardLast4 = payload.card_last4 || (last4Match ? last4Match[1] : null);

  const normalizedMerchant = normalizeMerchant(rawMerchant);
  const cls = classifyMerchantAndFlow(rawMerchant, normalizedMerchant, cardName);
  const rawPayloadStr = JSON.stringify({ amount, merchant: rawMerchant, card_name: cardName });

  const dedupe = await evaluateDeduplication(db, {
    direction: 'OUT',
    amount,
    normalizedMerchant,
    cardLast4: cardLast4 || normalizedMerchant,
    sourceChannel: 'apple_pay_webhook',
    rawPayload: rawPayloadStr,
    nowIso
  });

  if (dedupe.decision === 'BLOCKED_DUPLICATE') {
    await insertIngestionLog(db, {
      sourceChannel: 'apple_pay_webhook',
      dedupeFingerprint: dedupe.fingerprint,
      amount,
      normalizedMerchant,
      actionTaken: 'BLOCKED_DUPLICATE',
      linkedEntryId: dedupe.matchedEntry?.id || null,
      rawText: rawPayloadStr,
      receivedAt: nowIso
    });
    return {
      status: 'BLOCKED_DUPLICATE',
      ignored: true,
      message: `🛡️ 防重複攔截：${dedupe.diffSeconds} 秒前已有相同 Apple Pay 交易（${normalizedMerchant} $${amount.toLocaleString()}），已自動阻擋！`,
      entry: dedupe.matchedEntry
    };
  }

  const cycle = await ensureCurrentBudgetCycle(db, txDate);
  const isSuspected = dedupe.decision === 'FLAGGED_SUSPECTED';
  const flowType = cls.autoTankTransferType ? FLOW_TYPES.INTERNAL_TRANSFER : FLOW_TYPES.EXPENSE;
  const budgetImpactAmount = isSuspected ? 0 : amount;
  const easycardDelta = (!isSuspected && cls.autoTankTransferType === 'EASYCARD') ? amount : 0;
  const cashDelta = (!isSuspected && cls.autoTankTransferType === 'CASH') ? amount : 0;

  const baseNote = cls.autoTankTransferType === 'EASYCARD'
    ? `🍎 Apple Pay 自動加值 $${amount.toLocaleString()}（轉入悠遊卡水庫）`
    : `🍎 Apple Pay 消費（${cardName} · 扣減數位預算 -$${amount.toLocaleString()}）`;
  const finalNote = isSuspected
    ? `⚠️ [疑似重複待確認] ${dedupe.diffSeconds} 秒內有同金額同商家交易，請確認是否為第 2 筆消費（暫不扣預算）`
    : baseNote;

  const entry = await insertEntry(db, {
    cycleKey: cycle.cycle_key,
    flowType,
    paymentMedium: PAYMENT_MEDIA.DIGITAL_BANK,
    dedupeStatus: isSuspected ? DEDUPE_STATUS.SUSPECTED_DUPLICATE : DEDUPE_STATUS.CONFIRMED,
    dedupeFingerprint: dedupe.fingerprint,
    rawMerchant,
    normalizedMerchant,
    category: cls.category,
    cardLast4,
    amount,
    budgetImpactAmount,
    cashDelta,
    easycardDelta,
    txDate,
    txTimestamp: nowIso,
    sourceChannel: 'apple_pay_webhook',
    note: finalNote,
    rawPayload: rawPayloadStr,
    createdAt: nowIso
  });

  if (easycardDelta !== 0) {
    await applyTankDelta(db, {
      tankType: 'EASYCARD',
      deltaAmount: easycardDelta,
      note: `🍎 Apple Pay 自動加值：${normalizedMerchant}`,
      linkedEntryId: entry.id
    });
  }

  await insertIngestionLog(db, {
    sourceChannel: 'apple_pay_webhook',
    dedupeFingerprint: dedupe.fingerprint,
    amount,
    normalizedMerchant,
    actionTaken: isSuspected ? 'FLAGGED_SUSPECTED' : 'ACCEPTED',
    linkedEntryId: entry.id,
    rawText: rawPayloadStr,
    receivedAt: nowIso
  });

  return {
    status: isSuspected ? 'FLAGGED_SUSPECTED' : 'ACCEPTED',
    ignored: false,
    message: finalNote,
    entry
  };
}

function isPureBankCardSwipeNotification(cleanText) {
  const hasTransferOrDepositSignal = /轉帳|轉出|轉入|存入|存款|匯款|提款|收款|入帳通知|無卡存款|跨行|轉給/i.test(cleanText);
  if (hasTransferOrDepositSignal) return false;
  return /(?:信用卡|簽帳金融卡|簽帳卡).*(?:一般消費|刷卡|授權|圈存|請款|預授權|刷退)/i.test(cleanText) ||
         /一般消費.*(?:授權碼|實際請款|簽帳卡)/i.test(cleanText);
}

function parseTransferOcrText(rawText, options = {}) {
  const cleanText = toHalfWidth(String(rawText || '')).replace(/\r\n/g, '\n').trim();
  const tp = getTaipeiNowParts(options.timestamp);
  const txDate = (options.referenceDate || tp.dateStr).slice(0, 10);

  let reportedBalance = null;
  const balMatch = cleanText.match(/(?:可用餘額|帳戶可用餘額|帳戶餘額|台幣餘額|臺幣餘額)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?/i);
  if (balMatch && balMatch[1]) {
    reportedBalance = parseInt(balMatch[1].replace(/,/g, ''), 10);
  }

  const bankCodeRegex = new RegExp(`\\b(?:${TW_BANK_CODES.join('|')})\\b(?=\\s*[\\u4e00-\\u9fa5(（]|\\s*銀行)`, 'g');
  const textWithoutNoise = cleanText
    .replace(/(?:可用餘額|帳戶可用餘額|帳戶餘額|台幣餘額|臺幣餘額|剩餘額度)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*[0-9,]+(?:\.[0-9]+)?\s*元?/gi, ' ')
    .replace(/(?:手續費|跨行手續費|優惠減免|手續費減免|減免)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*[0-9,]+(?:\.[0-9]+)?\s*元?/gi, ' ')
    .replace(/(?:轉出帳號|轉入帳號|入帳帳號|扣款帳號|收款帳號|帳號|卡號|交易序號|序號|授權碼|末四碼)[：:\s]*[0-9\-\*＊xX\s]+/gi, ' ')
    .replace(bankCodeRegex, ' ')
    .replace(/\b\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?\b/g, ' ')
    .replace(/\b\d{1,2}[\/\-月]\d{1,2}日\b/g, ' ')
    .replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g, ' ')
    .replace(/\b\d{1,3}%\b/g, ' ');

  let amount = Number(options.amount) > 0 ? Math.round(Number(options.amount)) : 0;
  if (!amount) {
    const weightedAmountPatterns = [
      /(?:轉帳金額|交易金額|轉出金額|轉入金額|匯款金額|付款金額|存入金額|存款金額|入帳金額|收款金額|實付金額|扣款金額|金額)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)(?:\.[0-9]{1,2})?/i,
      /(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)\s*([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)(?:\.[0-9]{1,2})?/i,
      /(?<![0-9.,])([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)(?:\.[0-9]{1,2})?\s*元/
    ];
    for (const pat of weightedAmountPatterns) {
      const m = textWithoutNoise.match(pat);
      if (m && m[1]) {
        const parsedNum = parseInt(m[1].replace(/,/g, ''), 10);
        if (parsedNum > 0) {
          amount = parsedNum;
          break;
        }
      }
    }
  }

  const rawTag = String(options.flowType || options.categoryTag || options.category || '').trim().toUpperCase();
  const explicitDir = String(options.direction || '').trim().toUpperCase();

  let direction = (explicitDir === 'IN' || explicitDir === 'OUT') ? explicitDir : null;
  if (!direction) {
    if (rawTag === 'ADVANCE_IN' || rawTag === 'INCOME_DEPOSIT' || rawTag === 'DEPOSIT') {
      direction = 'IN';
    } else if (rawTag === 'EXPENSE' || rawTag === 'ADVANCE_OUT' || rawTag === 'ADVANCE') {
      direction = 'OUT';
    } else {
      const inHeaderRegex = /轉入成功|收到轉帳|轉帳入帳|轉帳存入|匯款入帳|存入通知|存款通知|入帳通知|帳戶入帳|無卡存款|現金存入|ATM\s*現金存入|ATM\s*存款|薪資入帳|薪水入帳/i;
      const outHeaderRegex = /轉帳成功|轉出成功|匯款成功|付款成功|轉帳給|轉出金額|付款金額|ATM\s*提款|無卡提款/i;
      if (inHeaderRegex.test(cleanText) && !/轉帳給|付款成功/.test(cleanText)) {
        direction = 'IN';
      } else if (outHeaderRegex.test(cleanText)) {
        direction = 'OUT';
      } else {
        direction = 'OUT';
      }
    }
  }

  let flowType;
  if (rawTag === 'ADVANCE_OUT' || (rawTag === 'ADVANCE' && direction === 'OUT')) {
    flowType = FLOW_TYPES.ADVANCE_OUT;
  } else if (rawTag === 'ADVANCE_IN' || (rawTag === 'ADVANCE' && direction === 'IN')) {
    flowType = FLOW_TYPES.ADVANCE_IN;
  } else if (rawTag === 'INTERNAL_TRANSFER' || rawTag === 'TRANSFER') {
    flowType = FLOW_TYPES.INTERNAL_TRANSFER;
  } else if (rawTag === 'INCOME_DEPOSIT' || rawTag === 'DEPOSIT') {
    flowType = FLOW_TYPES.INCOME_DEPOSIT;
  } else if (rawTag === 'EXPENSE') {
    flowType = FLOW_TYPES.EXPENSE;
  } else {
    flowType = direction === 'IN' ? FLOW_TYPES.INCOME_DEPOSIT : FLOW_TYPES.EXPENSE;
  }

  let noteText = '';
  const noteMatch = cleanText.match(/(?:備註|交易備註|附言|說明|用途|留言)[：:\s]*([^\n，,。；;]+)/i);
  if (noteMatch && noteMatch[1]) {
    noteText = noteMatch[1].trim();
  }

  let rawMerchant = String(options.merchant || options.debtorName || '').trim();
  if (!rawMerchant && noteText) rawMerchant = noteText;
  if (!rawMerchant) {
    const targetMatch = cleanText.match(/(?:轉入戶名|收款人|轉帳對象|轉給)[：:\s]*([^\n，,。；;]+)/i);
    if (targetMatch && targetMatch[1]) {
      rawMerchant = `轉帳 (${targetMatch[1].trim().slice(0, 16)})`;
    }
  }
  if (!rawMerchant) {
    if (flowType === FLOW_TYPES.ADVANCE_OUT) rawMerchant = '轉帳幫朋友代墊';
    else if (flowType === FLOW_TYPES.ADVANCE_IN) rawMerchant = '朋友轉帳還款';
    else if (flowType === FLOW_TYPES.INTERNAL_TRANSFER) rawMerchant = '帳戶內部互轉';
    else if (direction === 'IN') {
      rawMerchant = /薪資|薪水/.test(cleanText) ? '玉山薪資入帳' : (/無卡存款/.test(cleanText) ? '玉山 ATM 無卡存款' : '銀行轉帳/ATM入帳');
    } else {
      rawMerchant = '銀行轉帳支出';
    }
  }

  const normalizedMerchant = normalizeMerchant(rawMerchant);
  const accLast4Match = cleanText.match(/(?:轉入帳號|收款帳號|帳號|末四碼)[^0-9]*([0-9]{4})\b/i);
  const cardLast4 = accLast4Match ? accLast4Match[1] : null;

  return {
    direction,
    flowType,
    rawMerchant,
    normalizedMerchant,
    noteText,
    amount,
    cardLast4,
    reportedBalance,
    txDate,
    cleanText
  };
}

async function settleMatchingSplitBillsOnRepayment(db, entry, repayAmount) {
  const allSplits = await listAllSplitBills(db);
  const unpaid = allSplits.filter(s => !s.is_repaid);
  const settledSplitBills = [];

  const exactHit = unpaid.find(s => Number(s.receivable_amount) === Number(repayAmount));
  if (exactHit) {
    const s = await markSplitBillRepaid(db, exactHit.id, entry.id);
    settledSplitBills.push(s);
  } else {
    const totalUnpaidSum = unpaid.reduce((sum, s) => sum + (Number(s.receivable_amount) || 0), 0);
    if (unpaid.length > 1 && totalUnpaidSum === Number(repayAmount)) {
      for (const u of unpaid) {
        const s = await markSplitBillRepaid(db, u.id, entry.id);
        settledSplitBills.push(s);
      }
    }
  }

  if (settledSplitBills.length > 0) {
    const names = settledSplitBills.map(s => s.debtor_name).join('、');
    const updatedNote = `💰 收到朋友還款 +$${repayAmount.toLocaleString()}（已自動沖銷結清「${names}」之代墊款，不影響個人預算）`;
    await updateEntryFields(db, entry.id, {
      flowType: entry.flow_type,
      paymentMedium: entry.payment_medium,
      dedupeStatus: entry.dedupe_status,
      rawMerchant: entry.raw_merchant,
      normalizedMerchant: entry.normalized_merchant,
      category: entry.category,
      amount: entry.amount,
      budgetImpactAmount: 0,
      cashDelta: 0,
      easycardDelta: 0,
      txDate: entry.tx_date,
      note: updatedNote
    });
    entry.note = updatedNote;
  }

  return settledSplitBills;
}

function computeFlowImpactAndNote(parsed, cls, isSuspected, dedupeDiffSeconds) {
  let finalFlowType = parsed.flowType;
  let finalCategory = cls.category;
  let budgetImpactAmount = 0;
  let cashDelta = 0;
  let easycardDelta = 0;
  let baseNote = '';

  if (finalFlowType === FLOW_TYPES.EXPENSE && cls.autoTankTransferType) {
    finalFlowType = FLOW_TYPES.INTERNAL_TRANSFER;
  }

  if (finalFlowType === FLOW_TYPES.EXPENSE) {
    budgetImpactAmount = isSuspected ? 0 : parsed.amount;
    if (finalCategory === '一般消費') finalCategory = '轉帳消費';
    baseNote = `💸 轉帳消費支出 -$${parsed.amount.toLocaleString()}（已扣減本月數位可用預算）`;
  } else if (finalFlowType === FLOW_TYPES.INTERNAL_TRANSFER) {
    if (cls.autoTankTransferType === 'CASH') {
      finalCategory = 'ATM提款領現';
      budgetImpactAmount = isSuspected ? 0 : parsed.amount;
      cashDelta = isSuspected ? 0 : parsed.amount;
      baseNote = `🏧 ATM 提款領現 $${parsed.amount.toLocaleString()}（數位轉移至皮包現金水庫，總可用剩餘不變）`;
    } else if (cls.autoTankTransferType === 'EASYCARD') {
      finalCategory = '自動加值/儲值';
      budgetImpactAmount = isSuspected ? 0 : parsed.amount;
      easycardDelta = isSuspected ? 0 : parsed.amount;
      baseNote = `💳 儲值悠遊卡/電支 $${parsed.amount.toLocaleString()}（數位轉移至悠遊卡水庫）`;
    } else {
      finalCategory = '內部互轉';
      budgetImpactAmount = 0;
      baseNote = `🔄 帳戶內部互轉 $${parsed.amount.toLocaleString()}（自己帳戶調度，不扣減消費預算）`;
    }
  } else if (finalFlowType === FLOW_TYPES.ADVANCE_OUT) {
    finalCategory = '朋友代墊';
    budgetImpactAmount = 0;
    baseNote = `🤝 轉帳幫朋友代墊 $${parsed.amount.toLocaleString()}（不扣個人預算，已轉入應收代墊池）`;
  } else if (finalFlowType === FLOW_TYPES.ADVANCE_IN) {
    finalCategory = '代墊還款收回';
    budgetImpactAmount = 0;
    baseNote = `💰 收到朋友轉帳還款 +$${parsed.amount.toLocaleString()}（不重複計入預算）`;
  } else if (finalFlowType === FLOW_TYPES.INCOME_DEPOSIT) {
    finalCategory = /薪資|薪水/.test(parsed.cleanText) ? '薪資入帳' : '外部存款/轉入';
    budgetImpactAmount = 0;
    baseNote = `🏦 銀行轉入/存款紀錄 +$${parsed.amount.toLocaleString()}（已記錄入帳，不自動覆蓋每月起始預算）`;
  }

  const finalNote = isSuspected
    ? `⚠️ [疑似重複待確認] ${dedupeDiffSeconds} 秒內有同金額同方向紀錄，請確認是否為重複截圖（暫不影響預算）`
    : baseNote;

  return {
    finalFlowType,
    finalCategory,
    budgetImpactAmount,
    cashDelta,
    easycardDelta,
    finalNote
  };
}

async function ingestTransferOrOcr(db, payload = {}) {
  const rawTimestamp = payload.timestamp || new Date().toISOString();
  const parsedDt = new Date(rawTimestamp);
  const nowIso = Number.isNaN(parsedDt.getTime()) ? new Date().toISOString() : parsedDt.toISOString();

  const rawText = String(payload.raw_text || payload.rawText || payload.text || payload.message || payload.body || '').trim();
  const sourceChannel = String(payload.source || 'transfer_ocr').trim();

  if (rawText && isPureBankCardSwipeNotification(rawText)) {
    await insertIngestionLog(db, {
      sourceChannel,
      dedupeFingerprint: 'IGNORED_CARD_NOTIF',
      amount: 0,
      normalizedMerchant: '銀行刷卡推播(已攔截)',
      actionTaken: 'IGNORED_CARD_NOTIF',
      linkedEntryId: null,
      rawText,
      receivedAt: nowIso
    });
    return {
      status: 'IGNORED_CARD_NOTIF',
      ignored: true,
      message: '🛡️ 已攔截純銀行刷卡推播通知（日常刷卡統一由 Apple Pay 捷徑入帳，避免重複扣款）'
    };
  }

  const parsed = parseTransferOcrText(rawText, {
    timestamp: nowIso,
    referenceDate: payload.referenceDate,
    direction: payload.direction,
    flowType: payload.flowType || payload.categoryTag || payload.category,
    amount: payload.amount,
    merchant: payload.merchant || payload.debtorName
  });

  if (!parsed.amount || parsed.amount <= 0) {
    throw new Error('未能從截圖或文字中辨識出有效金額（請確認畫面包含轉帳金額）');
  }

  const dedupe = await evaluateDeduplication(db, {
    direction: parsed.direction,
    amount: parsed.amount,
    normalizedMerchant: parsed.normalizedMerchant,
    cardLast4: parsed.cardLast4 || parsed.normalizedMerchant,
    sourceChannel,
    rawPayload: rawText || JSON.stringify(payload),
    nowIso
  });

  if (dedupe.decision === 'BLOCKED_DUPLICATE') {
    await insertIngestionLog(db, {
      sourceChannel,
      dedupeFingerprint: dedupe.fingerprint,
      amount: parsed.amount,
      normalizedMerchant: parsed.normalizedMerchant,
      actionTaken: 'BLOCKED_DUPLICATE',
      linkedEntryId: dedupe.matchedEntry?.id || null,
      rawText: rawText || JSON.stringify(payload),
      receivedAt: nowIso
    });
    return {
      status: 'BLOCKED_DUPLICATE',
      ignored: true,
      message: `🛡️ 防重複攔截：${dedupe.diffSeconds} 秒前已有相同轉帳紀錄（${parsed.normalizedMerchant} $${parsed.amount.toLocaleString()}），已自動阻擋！`,
      entry: dedupe.matchedEntry
    };
  }

  if (parsed.reportedBalance !== null && Number.isFinite(parsed.reportedBalance)) {
    await updateSettings(db, { lastKnownBankBalance: parsed.reportedBalance });
  }

  const cycle = await ensureCurrentBudgetCycle(db, parsed.txDate);
  const isSuspected = dedupe.decision === 'FLAGGED_SUSPECTED';
  const cls = classifyMerchantAndFlow(parsed.rawMerchant, parsed.normalizedMerchant, parsed.cleanText);
  const {
    finalFlowType,
    finalCategory,
    budgetImpactAmount,
    cashDelta,
    easycardDelta,
    finalNote
  } = computeFlowImpactAndNote(parsed, cls, isSuspected, dedupe.diffSeconds);

  const entry = await insertEntry(db, {
    cycleKey: cycle.cycle_key,
    flowType: finalFlowType,
    paymentMedium: PAYMENT_MEDIA.DIGITAL_BANK,
    dedupeStatus: isSuspected ? DEDUPE_STATUS.SUSPECTED_DUPLICATE : DEDUPE_STATUS.CONFIRMED,
    dedupeFingerprint: dedupe.fingerprint,
    rawMerchant: parsed.rawMerchant,
    normalizedMerchant: parsed.normalizedMerchant,
    category: finalCategory,
    cardLast4: parsed.cardLast4,
    amount: parsed.amount,
    budgetImpactAmount,
    cashDelta,
    easycardDelta,
    txDate: parsed.txDate,
    txTimestamp: nowIso,
    sourceChannel,
    note: finalNote,
    rawPayload: rawText || JSON.stringify(payload),
    createdAt: nowIso
  });

  let settledSplitBills = [];
  if (!isSuspected) {
    if (cashDelta !== 0) {
      await applyTankDelta(db, { tankType: 'CASH', deltaAmount: cashDelta, note: `🏧 提款轉入皮包現金：${parsed.normalizedMerchant}`, linkedEntryId: entry.id });
    }
    if (easycardDelta !== 0) {
      await applyTankDelta(db, { tankType: 'EASYCARD', deltaAmount: easycardDelta, note: `💳 轉帳儲值悠遊卡：${parsed.normalizedMerchant}`, linkedEntryId: entry.id });
    }
    if (finalFlowType === FLOW_TYPES.ADVANCE_OUT) {
      await upsertSplitBill(db, { ledgerEntryId: entry.id, debtorName: parsed.rawMerchant || '朋友', totalAmount: parsed.amount, selfAmount: 0, receivableAmount: parsed.amount });
    } else if (finalFlowType === FLOW_TYPES.ADVANCE_IN) {
      settledSplitBills = await settleMatchingSplitBillsOnRepayment(db, entry, parsed.amount);
    }
  }

  await insertIngestionLog(db, {
    sourceChannel,
    dedupeFingerprint: dedupe.fingerprint,
    amount: parsed.amount,
    normalizedMerchant: parsed.normalizedMerchant,
    actionTaken: isSuspected ? 'FLAGGED_SUSPECTED' : 'ACCEPTED',
    linkedEntryId: entry.id,
    rawText: rawText || JSON.stringify(payload),
    receivedAt: nowIso
  });

  return {
    status: isSuspected ? 'FLAGGED_SUSPECTED' : 'ACCEPTED',
    ignored: false,
    direction: parsed.direction,
    flowType: finalFlowType,
    settledSplitBills,
    message: entry.note,
    entry,
    parsed
  };
}

module.exports = {
  buildDedupeFingerprint,
  evaluateDeduplication,
  resolveSuspectedDuplicateEntry,
  ingestApplePayTransaction,
  isPureBankCardSwipeNotification,
  parseTransferOcrText,
  settleMatchingSplitBillsOnRepayment,
  ingestTransferOrOcr
};






