'use strict';

const {
  parseEsunNotification,
  computeMerchantSimilarity,
  normalizeMerchant,
  isBankCardNotification,
  classifyTransaction
} = require('./esunParser');
const { ensureCurrentCycle, applyActualSalaryDeposit } = require('./survivalEngine');

const TRANSFER_IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000; // 5 分鐘轉帳/收帳防重複鎖 (300,000 ms)

function daysBetween(dateA, dateB) {
  const a = new Date(`${String(dateA).slice(0, 10)}T00:00:00`).getTime();
  const b = new Date(`${String(dateB).slice(0, 10)}T00:00:00`).getTime();
  return Math.round((b - a) / 86400000);
}

function creditWalletTankFromTx(db, tankType, amount, note, txId, nowIso) {
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  if (!tank) return;
  const col = tankType === 'CASH' ? 'cash_balance' : 'easycard_balance';
  const newBalance = (Number(tank[col]) || 0) + Number(amount);

  db.prepare(`UPDATE wallet_tank SET ${col} = ?, updated_at = ? WHERE id = 1`).run(newBalance, nowIso);
  db.prepare(`
    INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tankType, Number(amount), newBalance, note, txId, nowIso);
}

/**
 * 【步驟 3：轉帳與收帳 5 分鐘內相同金額與方向的防重複鎖 (Idempotency Check)】
 * 若 5 分鐘 (300,000 ms) 內已有相同金額與相同方向 (IN / OUT) 的轉帳或收帳紀錄，直接忽略不寫入
 */
function checkTransferIdempotencyLock(db, amount, direction, nowIso, emailUid = null) {
  const nowMs = new Date(nowIso).getTime();
  const normDir = String(direction || 'OUT').toUpperCase() === 'IN' ? 'IN' : 'OUT';
  const targetHash = `TRANSFER_${normDir}|${Number(amount)}`;

  const logs = db.prepare('SELECT * FROM notification_logs ORDER BY id DESC LIMIT 100').all();

  if (emailUid) {
    const uidTag = `[UID:${emailUid}]`;
    const hitUid = logs.find(l => String(l.action_taken || '').includes(uidTag) || String(l.raw_text || '').includes(uidTag));
    if (hitUid) {
      return {
        isDuplicate: true,
        diffSeconds: 0,
        originalTxId: hitUid.linked_tx_id,
        reason: 'SAME_EMAIL_UID'
      };
    }
  }

  for (const log of logs) {
    if (log.channel_type === 'IGNORED_DEBOUNCE' || log.channel_type === 'IGNORED_CARD_TX') continue;

    const logTimeMs = new Date(log.received_at).getTime();
    const diffMs = Math.abs(nowMs - logTimeMs);
    if (diffMs > TRANSFER_IDEMPOTENCY_WINDOW_MS) continue;

    const isSameHash = log.dedupe_hash === targetHash;
    const logDir = (log.channel_type === 'DEPOSIT_IN' || log.channel_type === 'SALARY_IN' || log.channel_type === 'TRANSFER_IN' || String(log.dedupe_hash || '').startsWith('TRANSFER_IN|'))
      ? 'IN'
      : ((log.channel_type === 'TRANSFER_OUT' || String(log.dedupe_hash || '').startsWith('TRANSFER_OUT|')) ? 'OUT' : null);

    if (isSameHash || (logDir === normDir && Number(log.amount) === Number(amount))) {
      return {
        isDuplicate: true,
        diffSeconds: Math.round(diffMs / 1000),
        originalTxId: log.linked_tx_id,
        reason: 'IDEMPOTENCY_5MIN_SAME_AMOUNT_DIRECTION'
      };
    }
  }

  return { isDuplicate: false };
}

/**
 * 已停用舊版銀行雙通道 PENDING -> SETTLED 核銷演算法（保留空殼維持介面相容）
 */
function findBestPendingMatch() {
  return null;
}

/**
 * 【步驟 2：乾淨的 Apple Pay 專用接收處理】
 * 接收來自 iOS Apple Pay 捷徑的 JSON：{ source: "apple_pay", amount, merchant, card_name, timestamp }
 * 進來時直接視為已確認交易 (SETTLED) 並直接扣減當日與當月安全預算
 */
function processApplePayTransaction(db, payload = {}, options = {}) {
  const rawTimestamp = payload.timestamp || options.timestamp || new Date().toISOString();
  const parsedDt = new Date(rawTimestamp);
  const nowIso = Number.isNaN(parsedDt.getTime()) ? new Date().toISOString() : parsedDt.toISOString();
  const refDate = (options.referenceDate || payload.referenceDate || nowIso.slice(0, 10)).slice(0, 10);

  const rawAmtStr = String(payload.amount ?? payload.money ?? payload.price ?? '').replace(/,/g, '').trim();
  const amtMatch = rawAmtStr.match(/(\d+(?:\.\d+)?)/);
  const amount = amtMatch ? Math.round(Number(amtMatch[1])) : 0;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Apple Pay 交易金額必須大於 0');
  }

  const rawMerchant = String(payload.merchant || payload.store || payload.shop || payload.name || '未知商店').trim() || '未知商店';
  const cardName = String(payload.card_name || payload.cardName || payload.card || 'Apple Pay').trim() || 'Apple Pay';
  const normalizedMerchant = normalizeMerchant(rawMerchant);
  const classification = classifyTransaction(rawMerchant, normalizedMerchant, amount, `Apple Pay ${cardName} ${rawMerchant}`, 'APPLE_PAY');

  const cycle = ensureCurrentCycle(db, refDate);
  const dedupeHash = `APPLE_PAY|${normalizedMerchant}|${amount}`;
  const reconcileNote = `🍎 Apple Pay 即時確認入帳（${cardName} · 已直接確認 SETTLED 並扣減安全預算 $${amount.toLocaleString()}）`;
  const rawSummary = JSON.stringify({
    source: 'apple_pay',
    amount,
    merchant: rawMerchant,
    card_name: cardName,
    timestamp: nowIso
  });

  const insertRes = db.prepare(`
    INSERT INTO transactions (
      cycle_key, status, raw_merchant, normalized_merchant, category,
      auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
      tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
      reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
      channel_a_raw, channel_b_raw, created_at
    ) VALUES (?, 'SETTLED', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, 1, 100, ?, ?, 0, ?, NULL, ?)
  `).run(
    cycle.cycle_key,
    rawMerchant,
    normalizedMerchant,
    classification.category,
    amount,
    amount,
    amount,
    amount,
    refDate,
    nowIso,
    nowIso,
    reconcileNote,
    classification.isForeignTx ? 1 : 0,
    rawSummary,
    nowIso
  );

  const txId = Number(insertRes.lastInsertRowid);

  // 保護區連動：若 Apple Pay 為悠遊卡自動加值，自動注入電子票證水庫
  if (classification.walletTankType) {
    creditWalletTankFromTx(
      db,
      classification.walletTankType,
      amount,
      `Apple Pay 自動轉入水庫：${normalizedMerchant} +$${amount}`,
      txId,
      nowIso
    );
  }

  db.prepare(`
    INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
    VALUES (?, 'APPLE_PAY_SETTLED', ?, ?, ?, ?, ?, ?, ?)
  `).run('apple_pay', normalizedMerchant, amount, dedupeHash, reconcileNote, txId, rawSummary, nowIso);

  return {
    resultType: 'APPLE_PAY_SETTLED',
    channelType: 'APPLE_PAY_SETTLED',
    source: 'apple_pay',
    cardName,
    message: reconcileNote,
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId),
    parsed: {
      source: 'apple_pay',
      rawMerchant,
      normalizedMerchant,
      cardName,
      amount,
      txDate: refDate,
      category: classification.category,
      isForeignTx: classification.isForeignTx,
      walletTankType: classification.walletTankType
    }
  };
}

function processBankNotification(db, rawInput, options = {}) {
  const isObjInput = rawInput && typeof rawInput === 'object';
  const payloadObj = isObjInput ? rawInput : {};
  const rawTimestamp = payloadObj.timestamp || options.timestamp || new Date().toISOString();
  const parsedDt = new Date(rawTimestamp);
  const nowIso = Number.isNaN(parsedDt.getTime()) ? new Date().toISOString() : parsedDt.toISOString();
  const refDate = (options.referenceDate || payloadObj.referenceDate || nowIso.slice(0, 10)).slice(0, 10);
  const source = String(payloadObj.source || options.source || 'manual').trim();

  // 【步驟 2：若為 iOS Apple Pay 捷徑專用來源，直接走 Apple Pay 乾淨入帳流程】
  if (source === 'apple_pay' || source === 'apple_pay_auto') {
    if (isObjInput && (payloadObj.amount !== undefined || payloadObj.merchant !== undefined)) {
      return processApplePayTransaction(db, payloadObj, { ...options, timestamp: nowIso, referenceDate: refDate });
    }
    if (options.merchant !== undefined && options.amount !== undefined) {
      return processApplePayTransaction(db, {
        source: 'apple_pay',
        amount: options.amount,
        merchant: options.merchant,
        card_name: options.card_name || options.cardName || options.card,
        timestamp: nowIso
      }, { ...options, referenceDate: refDate });
    }
  }

  const rawText = isObjInput
    ? String(payloadObj.raw_text || payloadObj.rawText || payloadObj.text || '')
    : String(rawInput || '');
  const categoryTag = String(
    payloadObj.category || options.category || payloadObj.categoryTag || options.categoryTag || ''
  ).trim().toUpperCase();
  const explicitDirection = payloadObj.direction || options.direction || null;
  const overrideAmount = payloadObj.amount || options.amount || null;
  const customMerchant = payloadObj.merchant || payloadObj.debtor_name || payloadObj.debtorName || options.merchant || options.debtorName || null;

  // 【步驟 1：徹底攔截銀行刷卡／簽帳卡消費／授權圈存／商店請款通知】
  if (isBankCardNotification(rawText)) {
    const ignoreNote = '🛡️ 已攔截忽略銀行刷卡/簽帳/授權/請款通知（日常刷卡改由 Apple Pay 捷徑原生觸發，避免重複記帳）';
    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'IGNORED_CARD_TX', '銀行刷卡通知(已攔截)', 0, 'BLOCKED_BANK_CARD', ?, NULL, ?, ?)
    `).run(source, ignoreNote, rawText, nowIso);

    return {
      ignored: true,
      resultType: 'IGNORED_BANK_CARD',
      channelType: 'IGNORED_CARD_TX',
      message: ignoreNote
    };
  }

  const parsed = parseEsunNotification(rawText, {
    referenceDate: refDate,
    source,
    categoryTag,
    direction: explicitDirection,
    overrideAmount,
    merchant: customMerchant
  });

  if (options.emailUid || payloadObj.emailUid) {
    parsed.emailUid = String(options.emailUid || payloadObj.emailUid);
  }
  const uidSuffix = parsed.emailUid ? ` [UID:${parsed.emailUid}]` : '';

  if (!parsed.amount || parsed.amount <= 0) {
    return {
      ignored: true,
      resultType: 'IGNORED_NO_AMOUNT',
      channelType: parsed.channelType,
      message: '未偵測到有效金額，已忽略該通知',
      parsed
    };
  }

  // 【步驟 3：轉帳與收帳寫入前，執行「5 分鐘內相同金額與方向的防重複鎖 (Idempotency Check)」】
  const idempotency = checkTransferIdempotencyLock(db, parsed.amount, parsed.direction, nowIso, parsed.emailUid);
  const dedupeHash = `TRANSFER_${parsed.direction}|${parsed.amount}`;

  if (idempotency.isDuplicate) {
    const dirLabel = parsed.direction === 'IN' ? '收帳/轉入' : '轉帳/轉出';
    const ignoreMsg = `🛡️ 5分鐘防重複鎖觸發：5 分鐘內已有相同金額 ($${parsed.amount.toLocaleString()}) 與相同方向 (${dirLabel}) 的紀錄，已自動忽略！${uidSuffix}`;
    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'IGNORED_DEBOUNCE', ?, ?, ?, ?, ?, ?, ?)
    `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, ignoreMsg, idempotency.originalTxId, rawText, nowIso);

    return {
      ignored: true,
      isDuplicate: true,
      resultType: 'IDEMPOTENCY_IGNORED',
      channelType: parsed.channelType,
      direction: parsed.direction,
      amount: parsed.amount,
      message: ignoreMsg,
      originalTxId: idempotency.originalTxId,
      parsed
    };
  }

  const cycle = ensureCurrentCycle(db, parsed.txDate || refDate);

  // 情境 1：玉山薪資入帳通知 -> 自動以真實入帳金額覆蓋當月預估值，並同步寫入存款紀錄
  if (parsed.channelType === 'SALARY_IN') {
    const updatedCycle = applyActualSalaryDeposit(db, parsed.amount, refDate);
    const actionMsg = `💰 薪資入帳自動校正：以真實薪資 $${parsed.amount} 覆蓋原預估實領 ($${cycle.estimated_net_pay})`;
    const salTxRes = db.prepare(`
      INSERT INTO transactions (
        cycle_key, status, raw_merchant, normalized_merchant, category,
        auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
        tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
        reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
        channel_a_raw, channel_b_raw, created_at
      ) VALUES (?, 'DEPOSIT', ?, ?, '薪資入帳', ?, ?, 0, ?, 0, ?, ?, ?, NULL, 1, 100, ?, 0, 0, ?, NULL, ?)
    `).run(
      cycle.cycle_key, parsed.rawMerchant, parsed.normalizedMerchant,
      parsed.amount, parsed.amount, parsed.amount,
      parsed.txDate, nowIso, nowIso, actionMsg, rawText, nowIso
    );
    const salTxId = Number(salTxRes.lastInsertRowid);
    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'SALARY_IN', ?, ?, ?, ?, ?, ?, ?)
    `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, actionMsg, salTxId, rawText, nowIso);

    return {
      resultType: 'SALARY_CALIBRATED',
      channelType: 'SALARY_IN',
      message: actionMsg,
      cycle: updatedCycle,
      transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(salTxId),
      parsed
    };
  }

  // 情境 1.5：收帳／轉帳入帳／ATM 存款通知 (direction === 'IN')
  if (parsed.direction === 'IN') {
    if (parsed.reportedAvailableBalance !== null && Number.isFinite(parsed.reportedAvailableBalance)) {
      db.prepare('UPDATE user_settings SET last_known_bank_balance = ?, updated_at = ? WHERE id = 1')
        .run(parsed.reportedAvailableBalance, nowIso);
    }

    if (categoryTag === 'ADVANCE') {
      const openSplits = db.prepare(`
        SELECT s.*, t.normalized_merchant, t.tx_date, t.status AS tx_status
        FROM split_bills s
        LEFT JOIN transactions t ON t.id = s.transaction_id
        ORDER BY s.is_repaid ASC, s.id DESC
      `).all();
      const matchedSplit = openSplits.find(s => !s.is_repaid && Number(s.receivable_amount) === Number(parsed.amount));
      if (matchedSplit) {
        db.prepare('UPDATE split_bills SET is_repaid = 1, repaid_at = ? WHERE id = ?').run(nowIso, matchedSplit.id);
      }
      const advanceInNote = matchedSplit
        ? `🤝 代墊款收帳自動沖銷 +$${parsed.amount.toLocaleString()}（已自動結清「${matchedSplit.debtor_name}」之應收代墊款）${uidSuffix}`
        : `🤝 代墊款收帳入帳 +$${parsed.amount.toLocaleString()}（朋友還款收回，不重複計入薪資預算）${uidSuffix}`;

      const advInRes = db.prepare(`
        INSERT INTO transactions (
          cycle_key, status, raw_merchant, normalized_merchant, category,
          auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
          tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
          reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
          channel_a_raw, channel_b_raw, created_at
        ) VALUES (?, 'SETTLED', ?, ?, '代墊款收回', ?, ?, 0, ?, 0, ?, ?, ?, NULL, 1, 100, ?, 0, 0, ?, NULL, ?)
      `).run(
        cycle.cycle_key, parsed.rawMerchant, parsed.normalizedMerchant,
        parsed.amount, parsed.amount, parsed.amount,
        parsed.txDate, nowIso, nowIso, advanceInNote, rawText, nowIso
      );
      const advInTxId = Number(advInRes.lastInsertRowid);
      db.prepare(`
        INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
        VALUES (?, 'TRANSFER_IN', ?, ?, ?, ?, ?, ?, ?)
      `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, advanceInNote, advInTxId, rawText, nowIso);

      return {
        resultType: 'ADVANCE_REPAID_IN',
        channelType: 'TRANSFER_IN',
        direction: 'IN',
        category: 'ADVANCE',
        settledSplitBillId: matchedSplit ? matchedSplit.id : null,
        message: advanceInNote,
        transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(advInTxId),
        parsed
      };
    }

    let depositNote = `🏧 金融卡存款/轉帳入帳 +$${parsed.amount.toLocaleString()}（已直接計入本月可用預算池）${uidSuffix}`;
    if (options.deductFromWalletCash || payloadObj.deductFromWalletCash) {
      const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
      if (tank) {
        const curCash = Number(tank.cash_balance) || 0;
        const newCash = Math.max(0, curCash - Number(parsed.amount));
        const actualDeducted = curCash - newCash;
        db.prepare('UPDATE wallet_tank SET cash_balance = ?, updated_at = ? WHERE id = 1').run(newCash, nowIso);
        db.prepare(`
          INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
          VALUES ('CASH', ?, ?, ?, NULL, ?)
        `).run(-actualDeducted, newCash, `🏧 拿皮包現金去 ATM 存入金融卡 -$${parsed.amount}`, nowIso);
        depositNote = `🏧 領現轉存金融卡 +$${parsed.amount.toLocaleString()}（已同步從皮包現金扣除並轉入金融卡可用預算）${uidSuffix}`;
      }
    }

    const depRes = db.prepare(`
      INSERT INTO transactions (
        cycle_key, status, raw_merchant, normalized_merchant, category,
        auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
        tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
        reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
        channel_a_raw, channel_b_raw, created_at
      ) VALUES (?, 'DEPOSIT', ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, 1, 100, ?, 0, 0, ?, NULL, ?)
    `).run(
      cycle.cycle_key, parsed.rawMerchant, parsed.normalizedMerchant, parsed.category || 'ATM存款',
      parsed.amount, parsed.amount, parsed.amount,
      parsed.txDate, nowIso, nowIso, parsed.authCode, depositNote, rawText, nowIso
    );

    const depTxId = Number(depRes.lastInsertRowid);
    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'DEPOSIT_IN', ?, ?, ?, ?, ?, ?, ?)
    `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, depositNote, depTxId, rawText, nowIso);

    return {
      resultType: 'DEPOSIT_RECORDED',
      channelType: 'DEPOSIT_IN',
      direction: 'IN',
      message: depositNote,
      transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(depTxId),
      parsed
    };
  }

  // 情境 3：轉帳轉出 (direction === 'OUT') —— 支援 OCR 文字解析搭配分類標籤 (EXPENSE / ADVANCE / TRANSFER) 或銀行轉帳通知
  if (parsed.reportedAvailableBalance !== null && Number.isFinite(parsed.reportedAvailableBalance)) {
    db.prepare('UPDATE user_settings SET last_known_bank_balance = ?, updated_at = ? WHERE id = 1')
      .run(parsed.reportedAvailableBalance, nowIso);
  }

  const effectiveTag = ['EXPENSE', 'ADVANCE', 'TRANSFER'].includes(categoryTag)
    ? categoryTag
    : (['EXPENSE', 'ADVANCE', 'TRANSFER'].includes(parsed.categoryTag) ? parsed.categoryTag : 'EXPENSE');

  let personalAmount = parsed.amount;
  let finalCategory = parsed.category || '一般支出';
  let reconcileNote = `💸 轉帳支出（已直接確認 SETTLED 並從安全預算扣除 $${parsed.amount.toLocaleString()}）${uidSuffix}`;
  let resultType = 'TRANSFER_EXPENSE_RECORDED';

  if (effectiveTag === 'ADVANCE') {
    personalAmount = 0; // 代墊款不扣個人預算
    finalCategory = '代墊款';
    reconcileNote = `🤝 轉帳代墊款 $${parsed.amount.toLocaleString()}（不扣個人預算，已自動移入應收代墊款池 Advance Pool）${uidSuffix}`;
    resultType = 'TRANSFER_ADVANCE_RECORDED';
  } else if (effectiveTag === 'TRANSFER') {
    personalAmount = 0; // 內部互轉不扣個人預算
    finalCategory = '內部互轉';
    reconcileNote = `🔄 帳戶內部互轉 $${parsed.amount.toLocaleString()}（自己帳戶調度，不計入個人消費預算）${uidSuffix}`;
    resultType = 'INTERNAL_TRANSFER_RECORDED';
  }

  const insertRes = db.prepare(`
    INSERT INTO transactions (
      cycle_key, status, raw_merchant, normalized_merchant, category,
      auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
      tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
      reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
      channel_a_raw, channel_b_raw, created_at
    ) VALUES (?, 'SETTLED', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, 1, 100, ?, 0, 0, ?, NULL, ?)
  `).run(
    cycle.cycle_key,
    parsed.rawMerchant,
    parsed.normalizedMerchant,
    finalCategory,
    parsed.amount,
    parsed.amount,
    parsed.amount,
    personalAmount,
    parsed.txDate,
    nowIso,
    nowIso,
    reconcileNote,
    rawText,
    nowIso
  );

  const txId = Number(insertRes.lastInsertRowid);

  // 若分類為 ADVANCE（代墊款），自動寫入保護區「應收代墊款池 (split_bills)」
  let splitBill = null;
  if (effectiveTag === 'ADVANCE') {
    const debtorName = String(customMerchant || parsed.noteText || parsed.rawMerchant || '朋友代墊').trim() || '朋友代墊';
    const splitRes = db.prepare(`
      INSERT INTO split_bills (transaction_id, total_amount, self_amount, receivable_amount, debtor_name, is_repaid, created_at)
      VALUES (?, ?, 0, ?, ?, 0, ?)
    `).run(txId, parsed.amount, parsed.amount, debtorName, nowIso);
    const splitId = Number(splitRes.lastInsertRowid);
    splitBill = db.prepare('SELECT * FROM split_bills WHERE id = ?').get(splitId);
  }

  // 若為 ATM 提款領現，同步注入現金水庫 (Wallet Tank)
  if (parsed.walletTankType) {
    creditWalletTankFromTx(
      db,
      parsed.walletTankType,
      parsed.amount,
      `轉帳/提款自動轉入水庫：${parsed.normalizedMerchant} +$${parsed.amount}`,
      txId,
      nowIso
    );
  }

  db.prepare(`
    INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
    VALUES (?, 'TRANSFER_OUT', ?, ?, ?, ?, ?, ?, ?)
  `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, reconcileNote, txId, rawText, nowIso);

  return {
    resultType,
    channelType: 'TRANSFER_OUT',
    direction: 'OUT',
    category: effectiveTag,
    message: reconcileNote,
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId),
    splitBill,
    parsed
  };
}

/**
 * 相容保留：手動調整加油金額（直接設為 SETTLED）
 */
function resolveGasTempHoldManually(db, txId, actualGasAmount) {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(txId));
  if (!tx) throw new Error('找不到該筆交易');
  const amt = Math.max(0, Math.round(Number(actualGasAmount) || 0));
  const note = `⛽ 手動確認實際加油金額 $${amt}`;

  db.prepare(`
    UPDATE transactions
    SET status = 'SETTLED',
        effective_amount = ?,
        personal_amount = ?,
        reconcile_note = ?
    WHERE id = ?
  `).run(amt, amt, note, tx.id);

  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
}

/**
 * 相容保留：手動將某筆交易標記為 CANCELED
 */
function markTransactionCanceled(db, txId, reason = '取消交易') {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(txId));
  if (!tx) throw new Error('找不到該筆交易');
  const note = `❄️ 已標記取消交易：${reason}`;

  db.prepare(`
    UPDATE transactions
    SET status = 'CANCELED',
        personal_amount = 0,
        reconcile_note = ?
    WHERE id = ?
  `).run(note, tx.id);

  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
}

/**
 * 相容保留：因為所有消費進系統皆直接確認為 SETTLED，不再產生幽靈圈存
 */
function scanGhostHolds() {
  return [];
}

module.exports = {
  findBestPendingMatch,
  checkTransferIdempotencyLock,
  processApplePayTransaction,
  processBankNotification,
  resolveGasTempHoldManually,
  markTransactionCanceled,
  scanGhostHolds
};

