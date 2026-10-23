'use strict';

const {
  TANK_AUDIT_REMINDER_DAYS,
  FLOW_TYPES,
  PAYMENT_MEDIA,
  DEDUPE_STATUS
} = require('../config/constants');
const { updateSettings } = require('../repositories/settingsRepo');
const {
  getEntryById,
  insertEntry,
  updateEntryFields,
  deleteEntryById
} = require('../repositories/ledgerRepo');
const {
  getSplitById,
  getSplitByLedgerEntryId,
  upsertSplitBill,
  markSplitBillRepaid,
  unmarkSplitsByRepaidEntryId,
  deleteSplitByLedgerEntryId,
  listAllSplitBills
} = require('../repositories/splitBillRepo');
const {
  getWalletTank,
  applyTankDelta,
  setTankBalancesAudit,
  listWalletTankLogs,
  insertBalanceSyncLog
} = require('../repositories/walletTankRepo');
const { getTaipeiNowParts, ensureCurrentBudgetCycle, getBudgetOverviewMetrics } = require('./budgetEngine');
const { normalizeMerchant, classifyMerchantAndFlow } = require('./merchantClassifier');

/**
 * 1. 取得實體水庫 (皮包現金 + 悠遊卡) 完整狀態與 3 天盤點提醒
 */
async function getWalletTankStatus(db, referenceNowIso = null) {
  const tank = await getWalletTank(db);
  const logs = await listWalletTankLogs(db, 20);
  const nowMs = referenceNowIso ? new Date(referenceNowIso).getTime() : Date.now();
  const lastAuditMs = new Date(tank.last_audit_at).getTime();
  const daysSinceAudit = Number(((nowMs - lastAuditMs) / 86400000).toFixed(1));
  const needsAuditAlert = daysSinceAudit >= TANK_AUDIT_REMINDER_DAYS;

  const cashBalance = Number(tank.cash_balance) || 0;
  const easycardBalance = Number(tank.easycard_balance) || 0;

  return {
    cashBalance,
    easycardBalance,
    physicalTankTotal: cashBalance + easycardBalance,
    lastAuditAt: tank.last_audit_at,
    daysSinceAudit,
    needsAuditAlert,
    auditAlertText: needsAuditAlert
      ? `📋 水庫盤點提醒：距離上次盤點皮包現金與悠遊卡已過 ${daysSinceAudit} 天，建議核對實際零錢餘額！`
      : null,
    logs
  };
}

/**
 * 2. 手動快捷調整水庫餘額 (加值或扣款)
 */
async function quickAdjustWalletTank(db, { tankType, deltaAmount, note }) {
  const type = tankType === 'EASYCARD' ? 'EASYCARD' : 'CASH';
  const delta = Math.round(Number(deltaAmount) || 0);
  if (delta === 0) throw new Error('調整金額不可為 0');

  const label = type === 'EASYCARD' ? '悠遊卡' : '皮包現金';
  const defaultNote = delta > 0 ? `手動加值${label}` : `手動扣減${label}`;
  await applyTankDelta(db, {
    tankType: type,
    deltaAmount: delta,
    note: String(note || defaultNote).trim()
  });
  return await getWalletTankStatus(db);
}

/**
 * 3. 直接輸入實際餘額盤點校正水庫
 */
async function auditWalletTankBalances(db, { cashBalance, easycardBalance }) {
  await setTankBalancesAudit(db, { cashBalance, easycardBalance });
  return await getWalletTankStatus(db);
}

/**
 * 4. 朋友聚餐一鍵拆帳 / 代墊沖銷
 */
async function splitLedgerEntryBill(db, { entryId, selfAmount, debtorName = '朋友' }) {
  const entry = await getEntryById(db, entryId);
  if (!entry) throw new Error('找不到該筆消費明細');

  const totalAmount = Number(entry.amount) || 0;
  const selfAmt = Math.max(0, Math.min(totalAmount, Math.round(Number(selfAmount) || 0)));
  const receivableAmount = Math.max(0, totalAmount - selfAmt);
  const debtor = String(debtorName || '朋友').trim() || '朋友';

  const note = `🤝 聚餐拆帳：總額 $${totalAmount.toLocaleString()}（自己負擔 $${selfAmt.toLocaleString()}，代墊應收 $${receivableAmount.toLocaleString()} · 對象：${debtor}）`;

  const updatedEntry = await updateEntryFields(db, entry.id, {
    flowType: selfAmt === 0 ? FLOW_TYPES.ADVANCE_OUT : FLOW_TYPES.EXPENSE,
    paymentMedium: entry.payment_medium,
    dedupeStatus: entry.dedupe_status,
    rawMerchant: entry.raw_merchant,
    normalizedMerchant: entry.normalized_merchant,
    category: entry.category,
    amount: totalAmount,
    budgetImpactAmount: entry.payment_medium === PAYMENT_MEDIA.DIGITAL_BANK ? selfAmt : 0,
    cashDelta: entry.cash_delta,
    easycardDelta: entry.easycard_delta,
    txDate: entry.tx_date,
    note
  });

  const splitBill = await upsertSplitBill(db, {
    ledgerEntryId: entry.id,
    debtorName: debtor,
    totalAmount,
    selfAmount: selfAmt,
    receivableAmount
  });

  return { splitBill, entry: updatedEntry };
}

async function settleSplitBillManually(db, splitBillId) {
  const record = await getSplitById(db, splitBillId);
  if (!record) throw new Error('找不到該筆應收代墊單');
  return await markSplitBillRepaid(db, record.id, null);
}

async function getSplitBillsSummary(db) {
  const items = await listAllSplitBills(db);
  const pendingReceivableTotal = items
    .filter(r => !r.is_repaid)
    .reduce((sum, r) => sum + (Number(r.receivable_amount) || 0), 0);

  return {
    pendingReceivableTotal,
    unpaidCount: items.filter(r => !r.is_repaid).length,
    items
  };
}

/**
 * 5. 首頁快速登記「使用皮包現金消費」
 * 預設僅扣減「💵 皮包現金水庫」，不重複扣減「💳 數位可用預算」（但 💰 最終總可用剩餘會自動減少）
 */
async function recordCashExpense(db, { itemName = '現金消費', amount, category = '餐飲外食', deductDigitalBudgetToo = false, referenceDateStr = null }) {
  const amt = Math.max(1, Math.round(Number(amount) || 0));
  const cleanName = String(itemName || '現金消費').trim() || '現金消費';
  const norm = normalizeMerchant(cleanName);
  const tp = getTaipeiNowParts();
  const txDate = (referenceDateStr || tp.dateStr).slice(0, 10);
  const cycle = await ensureCurrentBudgetCycle(db, txDate);

  const budgetImpact = deductDigitalBudgetToo ? amt : 0;
  const cashDelta = -amt;
  const note = `💵 皮包現金消費 -$${amt.toLocaleString()}（已扣減皮包現金水庫）`;

  const entry = await insertEntry(db, {
    cycleKey: cycle.cycle_key,
    flowType: FLOW_TYPES.EXPENSE,
    paymentMedium: PAYMENT_MEDIA.CASH,
    dedupeStatus: DEDUPE_STATUS.CONFIRMED,
    rawMerchant: cleanName,
    normalizedMerchant: norm,
    category: category || '餐飲外食',
    amount: amt,
    budgetImpactAmount: budgetImpact,
    cashDelta,
    easycardDelta: 0,
    txDate,
    sourceChannel: 'manual_cash',
    note
  });

  await applyTankDelta(db, {
    tankType: 'CASH',
    deltaAmount: cashDelta,
    note: `💵 現金消費：${norm}`,
    linkedEntryId: entry.id
  });

  return {
    entry,
    walletTank: await getWalletTankStatus(db)
  };
}

/**
 * 6. 登記「拿現金去 ATM 存入金融卡」
 * 歸類為 INTERNAL_TRANSFER（內部資產轉換）：
 *  - 增加「💳 本月數位可用預算」 (`budget_impact_amount = -amt`)
 *  - 若勾選 deductFromWalletCash，同步從「💵 皮包現金水庫」扣除 (`cash_delta = -amt`)
 *  - 嚴禁覆蓋 `base_budget` 每月起始預算！且支援 100% 反悔撤銷與隨時改金額！
 */
async function recordAtmDepositToCard(db, { amount, merchant = '玉山 ATM 存款', deductFromWalletCash = true, referenceDateStr = null }) {
  const amt = Math.max(1, Math.round(Number(amount) || 0));
  const cleanMerchant = String(merchant || '玉山 ATM 存款').trim() || '玉山 ATM 存款';
  const norm = normalizeMerchant(cleanMerchant);
  const tp = getTaipeiNowParts();
  const txDate = (referenceDateStr || tp.dateStr).slice(0, 10);
  const cycle = await ensureCurrentBudgetCycle(db, txDate);

  const cashDelta = deductFromWalletCash ? -amt : 0;
  const budgetImpact = -amt; // 負數代表增加數位可用額度
  const note = deductFromWalletCash
    ? `🏧 拿皮包現金存入金融卡 +$${amt.toLocaleString()}（已從皮包現金扣除並轉入數位可用額度）`
    : `🏧 ATM 現金存入金融卡 +$${amt.toLocaleString()}（已轉入本月數位可用額度）`;

  const entry = await insertEntry(db, {
    cycleKey: cycle.cycle_key,
    flowType: FLOW_TYPES.INTERNAL_TRANSFER,
    paymentMedium: PAYMENT_MEDIA.DIGITAL_BANK,
    dedupeStatus: DEDUPE_STATUS.CONFIRMED,
    rawMerchant: cleanMerchant,
    normalizedMerchant: norm,
    category: 'ATM存款',
    amount: amt,
    budgetImpactAmount: budgetImpact,
    cashDelta,
    easycardDelta: 0,
    txDate,
    sourceChannel: 'manual_atm_deposit',
    note
  });

  if (cashDelta !== 0) {
    await applyTankDelta(db, {
      tankType: 'CASH',
      deltaAmount: cashDelta,
      note: `🏧 拿皮包現金存入 ATM 金融卡`,
      linkedEntryId: entry.id
    });
  }

  return {
    entry,
    walletTank: await getWalletTankStatus(db)
  };
}

/**
 * 7. 玉山可用餘額一鍵校正 & 未知漏帳黑洞 (`UNKNOWN_GAP`) 事後拆分明細
 */
async function syncEsunAvailableBalance(db, { actualBankBalance, referenceDateStr = null }) {
  const actual = Math.max(0, Math.round(Number(actualBankBalance) || 0));
  const tp = getTaipeiNowParts();
  const txDate = (referenceDateStr || tp.dateStr).slice(0, 10);
  const overview = await getBudgetOverviewMetrics(db, txDate);
  const expected = overview.metrics.digitalRemainingBudget;
  const discrepancy = expected - actual;

  await updateSettings(db, { lastKnownBankBalance: actual });

  let gapEntry = null;
  let note = '✅ 玉山可用餘額與系統數位可用額度完全吻合！';

  if (discrepancy > 0) {
    const cycle = await ensureCurrentBudgetCycle(db, txDate);
    note = `🕳️ 餘額校正抓漏：實際餘額 ($${actual.toLocaleString()}) 少於系統推算 ($${expected.toLocaleString()})，自動生成待查黑洞 -$${discrepancy.toLocaleString()}`;
    gapEntry = await insertEntry(db, {
      cycleKey: cycle.cycle_key,
      flowType: FLOW_TYPES.UNKNOWN_GAP,
      paymentMedium: PAYMENT_MEDIA.DIGITAL_BANK,
      dedupeStatus: DEDUPE_STATUS.CONFIRMED,
      rawMerchant: '未知漏帳（待查黑洞）',
      normalizedMerchant: '未知漏帳（待查黑洞）',
      category: '待查漏帳',
      amount: discrepancy,
      budgetImpactAmount: discrepancy,
      cashDelta: 0,
      easycardDelta: 0,
      txDate,
      sourceChannel: 'balance_sync',
      note
    });
  } else if (discrepancy < 0) {
    note = `💡 實際銀行餘額 ($${actual.toLocaleString()}) 高於目前數位預算剩餘 ($${expected.toLocaleString()})，已更新參考餘額（不自動覆蓋預算）。`;
  }

  await insertBalanceSyncLog(db, {
    expectedDigitalBalance: expected,
    actualBankBalance: actual,
    discrepancyAmount: discrepancy,
    generatedGapEntryId: gapEntry ? gapEntry.id : null,
    note
  });

  return {
    expectedDigitalBalance: expected,
    actualBankBalance: actual,
    discrepancyAmount: discrepancy,
    gapEntry,
    message: note
  };
}

async function splitUnknownGapEntry(db, gapEntryId, items = []) {
  const gapEntry = await getEntryById(db, gapEntryId);
  if (!gapEntry || gapEntry.flow_type !== FLOW_TYPES.UNKNOWN_GAP) {
    throw new Error('找不到該筆待查黑洞紀錄');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('請至少輸入一筆拆分明細');
  }

  const createdEntries = [];
  let sumSplit = 0;

  for (const rawItem of items) {
    const amt = Math.max(1, Math.round(Number(rawItem.amount) || 0));
    const name = String(rawItem.merchant || rawItem.itemName || '補登消費').trim() || '補登消費';
    const norm = normalizeMerchant(name);
    const cls = classifyMerchantAndFlow(name, norm);
    sumSplit += amt;

    const e = await insertEntry(db, {
      cycleKey: gapEntry.cycle_key,
      flowType: FLOW_TYPES.EXPENSE,
      paymentMedium: PAYMENT_MEDIA.DIGITAL_BANK,
      dedupeStatus: DEDUPE_STATUS.CONFIRMED,
      rawMerchant: name,
      normalizedMerchant: norm,
      category: rawItem.category || cls.category,
      amount: amt,
      budgetImpactAmount: amt,
      cashDelta: 0,
      easycardDelta: 0,
      txDate: gapEntry.tx_date,
      sourceChannel: 'gap_split',
      note: `🔍 由待查黑洞 (#${gapEntry.id}) 拆分補登`
    });
    createdEntries.push(e);
  }

  const remainingGap = (Number(gapEntry.amount) || 0) - sumSplit;
  if (remainingGap <= 0) {
    await deleteEntryById(db, gapEntry.id);
  } else {
    await updateEntryFields(db, gapEntry.id, {
      flowType: FLOW_TYPES.UNKNOWN_GAP,
      paymentMedium: gapEntry.payment_medium,
      dedupeStatus: gapEntry.dedupe_status,
      rawMerchant: gapEntry.raw_merchant,
      normalizedMerchant: gapEntry.normalized_merchant,
      category: gapEntry.category,
      amount: remainingGap,
      budgetImpactAmount: remainingGap,
      cashDelta: 0,
      easycardDelta: 0,
      txDate: gapEntry.tx_date,
      note: `🕳️ 待查黑洞剩餘未拆分額度 $${remainingGap.toLocaleString()}`
    });
  }

  return { createdEntries, remainingGap: Math.max(0, remainingGap) };
}

/**
 * 8. 【100% 原子化雙向回滾】刪除/反悔撤銷任何一筆帳務或 ATM 存款紀錄
 */
async function deleteAndRollbackLedgerEntry(db, entryId) {
  const entry = await getEntryById(db, entryId);
  if (!entry) throw new Error('找不到該筆帳務紀錄');

  const cashDelta = Number(entry.cash_delta) || 0;
  const easyDelta = Number(entry.easycard_delta) || 0;

  if (cashDelta !== 0) {
    await applyTankDelta(db, {
      tankType: 'CASH',
      deltaAmount: -cashDelta,
      note: `↩️ 反悔撤銷/刪除紀錄回滾現金：${entry.normalized_merchant}`,
      linkedEntryId: null
    });
  }
  if (easyDelta !== 0) {
    await applyTankDelta(db, {
      tankType: 'EASYCARD',
      deltaAmount: -easyDelta,
      note: `↩️ 反悔撤銷/刪除紀錄回滾悠遊卡：${entry.normalized_merchant}`,
      linkedEntryId: null
    });
  }

  if (entry.flow_type === FLOW_TYPES.ADVANCE_IN) {
    await unmarkSplitsByRepaidEntryId(db, entry.id);
  }
  await deleteSplitByLedgerEntryId(db, entry.id);
  await deleteEntryById(db, entry.id);

  return {
    deletedId: entry.id,
    rolledBackCashDelta: -cashDelta,
    rolledBackEasycardDelta: -easyDelta
  };
}

/**
 * 9. 【自由編輯修改】隨時修改任何一筆紀錄（包含 ATM 存款改金額、改是否扣皮包現金、改轉帳分類）
 */
async function updateAndReconcileLedgerEntry(db, entryId, patch = {}) {
  const existing = await getEntryById(db, entryId);
  if (!existing) throw new Error('找不到要修改的紀錄');

  const oldCashDelta = Number(existing.cash_delta) || 0;
  const oldEasyDelta = Number(existing.easycard_delta) || 0;
  if (oldCashDelta !== 0) {
    await applyTankDelta(db, {
      tankType: 'CASH',
      deltaAmount: -oldCashDelta,
      note: `✏️ 修改紀錄前先回滾舊現金異動 (#${existing.id})`
    });
  }
  if (oldEasyDelta !== 0) {
    await applyTankDelta(db, {
      tankType: 'EASYCARD',
      deltaAmount: -oldEasyDelta,
      note: `✏️ 修改紀錄前先回滾舊悠遊卡異動 (#${existing.id})`
    });
  }

  const newAmount = patch.amount !== undefined
    ? Math.max(1, Math.round(Number(patch.amount) || 0))
    : Number(existing.amount);
  const newRawMerchant = patch.merchant !== undefined
    ? (String(patch.merchant).trim() || existing.raw_merchant)
    : existing.raw_merchant;
  const newNormalized = normalizeMerchant(newRawMerchant);
  const newFlowType = patch.flowType || existing.flow_type;
  const newPaymentMedium = patch.paymentMedium || existing.payment_medium;
  const newCategory = patch.category || existing.category;
  const newTxDate = patch.txDate ? String(patch.txDate).slice(0, 10) : existing.tx_date;

  const isAtmDepositToCard = newFlowType === FLOW_TYPES.INTERNAL_TRANSFER &&
    (newCategory === 'ATM存款' || /ATM\s*存款|存入金融卡/.test(newNormalized + ' ' + (patch.note || existing.note)));

  const deductFromWalletCash = patch.deductFromWalletCash !== undefined
    ? Boolean(patch.deductFromWalletCash)
    : (oldCashDelta < 0);

  let newBudgetImpact = 0;
  let newCashDelta = 0;
  let newEasyDelta = 0;
  let newNote = patch.note !== undefined ? String(patch.note).trim() : existing.note;

  if (isAtmDepositToCard) {
    newBudgetImpact = -newAmount;
    newCashDelta = deductFromWalletCash ? -newAmount : 0;
    newNote = deductFromWalletCash
      ? `🏧 拿皮包現金存入金融卡 +$${newAmount.toLocaleString()}（已修改確認 · 同步扣減皮包現金）`
      : `🏧 ATM 現金存入金融卡 +$${newAmount.toLocaleString()}（已修改確認 · 轉入數位可用額度）`;
  } else if (newFlowType === FLOW_TYPES.EXPENSE) {
    if (newPaymentMedium === PAYMENT_MEDIA.CASH) {
      newBudgetImpact = 0;
      newCashDelta = -newAmount;
    } else if (newPaymentMedium === PAYMENT_MEDIA.EASYCARD) {
      newBudgetImpact = 0;
      newEasyDelta = -newAmount;
    } else {
      newBudgetImpact = newAmount;
    }
  } else if (newFlowType === FLOW_TYPES.INTERNAL_TRANSFER) {
    const cls = classifyMerchantAndFlow(newRawMerchant, newNormalized, newNote);
    if (cls.autoTankTransferType === 'CASH') {
      newBudgetImpact = newAmount;
      newCashDelta = newAmount;
    } else if (cls.autoTankTransferType === 'EASYCARD') {
      newBudgetImpact = newAmount;
      newEasyDelta = newAmount;
    } else {
      newBudgetImpact = 0;
    }
  } else if (newFlowType === FLOW_TYPES.ADVANCE_OUT) {
    newBudgetImpact = 0;
    await upsertSplitBill(db, {
      ledgerEntryId: existing.id,
      debtorName: newRawMerchant || '朋友',
      totalAmount: newAmount,
      selfAmount: 0,
      receivableAmount: newAmount
    });
  } else if (newFlowType === FLOW_TYPES.ADVANCE_IN || newFlowType === FLOW_TYPES.INCOME_DEPOSIT) {
    newBudgetImpact = 0;
  } else if (newFlowType === FLOW_TYPES.UNKNOWN_GAP) {
    newBudgetImpact = newAmount;
  }

  if (newFlowType !== FLOW_TYPES.ADVANCE_OUT && newFlowType !== FLOW_TYPES.EXPENSE) {
    await deleteSplitByLedgerEntryId(db, existing.id);
  }

  if (newCashDelta !== 0) {
    await applyTankDelta(db, {
      tankType: 'CASH',
      deltaAmount: newCashDelta,
      note: `✏️ 修改後套用現金異動：${newNormalized}`,
      linkedEntryId: existing.id
    });
  }
  if (newEasyDelta !== 0) {
    await applyTankDelta(db, {
      tankType: 'EASYCARD',
      deltaAmount: newEasyDelta,
      note: `✏️ 修改後套用悠遊卡異動：${newNormalized}`,
      linkedEntryId: existing.id
    });
  }

  const updated = await updateEntryFields(db, existing.id, {
    flowType: newFlowType,
    paymentMedium: newPaymentMedium,
    dedupeStatus: DEDUPE_STATUS.CONFIRMED,
    rawMerchant: newRawMerchant,
    normalizedMerchant: newNormalized,
    category: newCategory,
    amount: newAmount,
    budgetImpactAmount: newBudgetImpact,
    cashDelta: newCashDelta,
    easycardDelta: newEasyDelta,
    txDate: newTxDate,
    note: newNote
  });

  return {
    entry: updated,
    walletTank: await getWalletTankStatus(db)
  };
}

module.exports = {
  getWalletTankStatus,
  quickAdjustWalletTank,
  auditWalletTankBalances,
  splitLedgerEntryBill,
  settleSplitBillManually,
  getSplitBillsSummary,
  recordCashExpense,
  recordAtmDepositToCard,
  syncEsunAvailableBalance,
  splitUnknownGapEntry,
  deleteAndRollbackLedgerEntry,
  updateAndReconcileLedgerEntry
};



