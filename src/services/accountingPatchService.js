'use strict';

const { ensureCurrentCycle, getSurvivalDashboardMetrics } = require('./survivalEngine');

/**
 * 4.1 朋友聚餐「一鍵拆帳 / 代墊沖銷」
 * 例如刷卡 $2,000，設定「自己僅負擔 $500」，系統只扣個人預算 $500；
 * 剩下的 $1,500 移入「應收代墊款池（不扣個人預算）」，並可記錄欠款人名單，收到轉帳後勾選結清。
 */
function splitTransactionBill(db, { transactionId, selfAmount, debtorName }) {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(transactionId));
  if (!tx) throw new Error('找不到該筆消費紀錄');

  const totalAmount = Number(tx.effective_amount) || Number(tx.auth_amount) || 0;
  const selfAmt = Math.max(0, Math.min(totalAmount, Math.round(Number(selfAmount) || 0)));
  const receivableAmount = Math.max(0, totalAmount - selfAmt);
  const debtor = String(debtorName || '朋友代墊').trim() || '朋友代墊';
  const nowIso = new Date().toISOString();

  // 更新原交易的個人實際負擔金額 personal_amount
  const note = `🤝 聚餐拆帳：刷卡總額 $${totalAmount}（自己負擔 $${selfAmt}，代墊應收 $${receivableAmount} 對象：${debtor}）`;
  db.prepare(`
    UPDATE transactions
    SET personal_amount = ?, reconcile_note = ?
    WHERE id = ?
  `).run(selfAmt, note, tx.id);

  // 檢查是否已有拆帳紀錄，若有則更新，若無則新增
  const existing = db.prepare('SELECT id FROM split_bills WHERE transaction_id = ?').get(tx.id);
  let splitId;
  if (existing) {
    db.prepare(`
      UPDATE split_bills
      SET total_amount = ?, self_amount = ?, receivable_amount = ?, debtor_name = ?, is_repaid = 0, repaid_at = NULL
      WHERE id = ?
    `).run(totalAmount, selfAmt, receivableAmount, debtor, existing.id);
    splitId = existing.id;
  } else {
    const res = db.prepare(`
      INSERT INTO split_bills (transaction_id, total_amount, self_amount, receivable_amount, debtor_name, is_repaid, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(tx.id, totalAmount, selfAmt, receivableAmount, debtor, nowIso);
    splitId = Number(res.lastInsertRowid);
  }

  return {
    splitBill: db.prepare('SELECT * FROM split_bills WHERE id = ?').get(splitId),
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id)
  };
}

function settleSplitBill(db, splitBillId) {
  const record = db.prepare('SELECT * FROM split_bills WHERE id = ?').get(Number(splitBillId));
  if (!record) throw new Error('找不到該筆應收代墊紀錄');

  const nowIso = new Date().toISOString();
  db.prepare('UPDATE split_bills SET is_repaid = 1, repaid_at = ? WHERE id = ?').run(nowIso, record.id);
  return db.prepare('SELECT * FROM split_bills WHERE id = ?').get(record.id);
}

function getSplitBillsSummary(db) {
  const rows = db.prepare(`
    SELECT s.*, t.normalized_merchant, t.tx_date, t.status AS tx_status
    FROM split_bills s
    LEFT JOIN transactions t ON t.id = s.transaction_id
    ORDER BY s.is_repaid ASC, s.id DESC
  `).all();

  const pendingReceivableTotal = rows
    .filter(r => !r.is_repaid)
    .reduce((sum, r) => sum + Number(r.receivable_amount || 0), 0);

  return {
    pendingReceivableTotal,
    unpaidCount: rows.filter(r => !r.is_repaid).length,
    items: rows
  };
}

function getWalletTankStatus(db, referenceNowIso) {
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  const logs = db.prepare('SELECT * FROM wallet_tank_logs ORDER BY id DESC LIMIT 20').all();

  const nowMs = referenceNowIso ? new Date(referenceNowIso).getTime() : Date.now();
  const lastAuditMs = new Date(tank.last_audit_at).getTime();
  const daysSinceAudit = Number(((nowMs - lastAuditMs) / 86400000).toFixed(1));
  const needsAuditAlert = daysSinceAudit >= 3;

  return {
    easycardBalance: Number(tank.easycard_balance) || 0,
    cashBalance: Number(tank.cash_balance) || 0,
    totalTankBalance: (Number(tank.easycard_balance) || 0) + (Number(tank.cash_balance) || 0),
    lastAuditAt: tank.last_audit_at,
    daysSinceAudit,
    needsAuditAlert,
    auditAlertText: needsAuditAlert
      ? `⏳ 水庫盤點提醒：距離上次盤點已過 ${daysSinceAudit} 天（滿 3 天），請清點皮包現金與悠遊卡餘額，消滅不知去向的銅板黑洞！`
      : null,
    logs
  };
}

function normalizeSignedInputStr(val) {
  return String(val ?? '')
    .trim()
    .replace(/[＋]/g, '+')
    .replace(/[－﹣—–]/g, '-')
    .replace(/[$,，\s元]/g, '');
}

function parseSignedInt(val) {
  const s = normalizeSignedInputStr(val);
  if (!s) return NaN;
  const isNeg = s.startsWith('-');
  const numPart = s.replace(/^[+-]+/, '');
  if (!numPart) return NaN;
  const n = Math.round(Number(numPart));
  if (!Number.isFinite(n)) return NaN;
  return isNeg ? -Math.abs(n) : Math.abs(n);
}

function quickAdjustWalletTank(db, { tankType = 'CASH', deltaAmount = -50, note = '快速扣水庫銅板消費' }) {
  const type = String(tankType).toUpperCase() === 'EASYCARD' ? 'EASYCARD' : 'CASH';
  const col = type === 'EASYCARD' ? 'easycard_balance' : 'cash_balance';
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  const parsed = parseSignedInt(deltaAmount);
  const delta = Number.isFinite(parsed) ? parsed : 0;
  const newBalance = Math.max(0, (Number(tank[col]) || 0) + delta);
  const nowIso = new Date().toISOString();

  db.prepare(`UPDATE wallet_tank SET ${col} = ?, updated_at = ? WHERE id = 1`).run(newBalance, nowIso);
  db.prepare(`
    INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(type, delta, newBalance, String(note || '水庫變動'), nowIso);

  return getWalletTankStatus(db, nowIso);
}

function auditWalletTank(db, { easycardBalance, cashBalance, easycardMode, cashMode }) {
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  const nowIso = new Date().toISOString();
  const curEasy = Number(tank.easycard_balance) || 0;
  const curCash = Number(tank.cash_balance) || 0;

  let newEasy = curEasy;
  let noteEasy = '3天定期盤點手動校正';
  if (easycardBalance !== undefined && easycardBalance !== null && String(easycardBalance).trim() !== '') {
    const strEasy = normalizeSignedInputStr(easycardBalance);
    const numEasy = parseSignedInt(strEasy);
    if (Number.isFinite(numEasy)) {
      if (numEasy < 0 || easycardMode === 'DELTA' || strEasy.startsWith('+')) {
        newEasy = Math.max(0, curEasy + numEasy);
        noteEasy = numEasy < 0 ? '自訂扣款消費' : '自訂加值存入';
      } else {
        newEasy = Math.max(0, numEasy);
      }
    }
  }

  let newCash = curCash;
  let noteCash = '3天定期盤點手動校正';
  if (cashBalance !== undefined && cashBalance !== null && String(cashBalance).trim() !== '') {
    const strCash = normalizeSignedInputStr(cashBalance);
    const numCash = parseSignedInt(strCash);
    if (Number.isFinite(numCash)) {
      if (numCash < 0 || cashMode === 'DELTA' || strCash.startsWith('+')) {
        newCash = Math.max(0, curCash + numCash);
        noteCash = numCash < 0 ? '自訂扣款消費' : '自訂加值存入';
      } else {
        newCash = Math.max(0, numCash);
      }
    }
  }

  const diffEasy = newEasy - curEasy;
  const diffCash = newCash - curCash;

  db.prepare(`
    UPDATE wallet_tank SET easycard_balance = ?, cash_balance = ?, last_audit_at = ?, updated_at = ? WHERE id = 1
  `).run(newEasy, newCash, nowIso, nowIso);

  if (diffEasy !== 0) {
    db.prepare(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
      VALUES ('EASYCARD', ?, ?, ?, NULL, ?)
    `).run(diffEasy, newEasy, noteEasy, nowIso);
  }
  if (diffCash !== 0) {
    db.prepare(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
      VALUES ('CASH', ?, ?, ?, NULL, ?)
    `).run(diffCash, newCash, noteCash, nowIso);
  }

  return getWalletTankStatus(db, nowIso);
}
function syncEsunAvailableBalance(db, { actualEsunBalance, referenceDateStr }) {
  const actual = Math.round(Number(actualEsunBalance));
  if (!Number.isFinite(actual) || actual < 0) {
    throw new Error('請輸入有效的玉山 Wallet 可用餘額數字');
  }

  const nowIso = new Date().toISOString();
  const refDate = (referenceDateStr || nowIso.slice(0, 10)).slice(0, 10);
  const metrics = getSurvivalDashboardMetrics(db, refDate);
  const systemExpected = Number(metrics.budget.remainingBudget);
  const discrepancy = actual - systemExpected;

  let generatedGapTx = null;
  let message = `✅ 餘額完全吻合（$${actual}），無任何漏帳黑洞！`;

  if (discrepancy < 0) {
    const missingAmount = Math.abs(discrepancy);
    const note = `🕳️ 玉山可用餘額一鍵校正自動生成：系統推算 $${systemExpected} vs 玉山真實餘額 $${actual}，少掉 $${missingAmount} 元已立即扣減安全額度，事後可拆分補齊明細！`;

    const res = db.prepare(`
      INSERT INTO transactions (
        cycle_key, status, raw_merchant, normalized_merchant, category,
        auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
        tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
        reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
        channel_a_raw, channel_b_raw, created_at
      ) VALUES (?, 'UNKNOWN_GAP', ?, ?, '未知黑洞', ?, ?, 0, ?, ?, ?, ?, ?, NULL, 1, 100, ?, 0, 0, ?, NULL, ?)
    `).run(
      metrics.cycle.cycleKey,
      `$${missingAmount} 未知漏帳（待查黑洞）`,
      '未知漏帳（待查黑洞）',
      missingAmount, missingAmount, missingAmount, missingAmount,
      refDate, nowIso, nowIso, note, note, nowIso
    );

    const gapTxId = Number(res.lastInsertRowid);
    generatedGapTx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(gapTxId);
    message = `🚨 偵測到帳目落差：玉山真實餘額比系統推算少了 $${missingAmount} 元！已自動生成一筆【$${missingAmount} 未知漏帳（待查黑洞）】立即扣減安全額度，確保月底絕不意外破產！`;
  } else if (discrepancy > 0) {
    message = `💡 玉山真實餘額 ($${actual}) 比系統推算安全預算 ($${systemExpected}) 多出 +$${discrepancy} 元。`;
  }

  db.prepare('UPDATE user_settings SET last_known_bank_balance = ?, updated_at = ? WHERE id = 1').run(actual, nowIso);
  db.prepare(`
    INSERT INTO balance_sync_logs (system_expected_balance, actual_esun_balance, discrepancy_amount, generated_gap_tx_id, note, synced_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(systemExpected, actual, discrepancy, generatedGapTx ? generatedGapTx.id : null, message, nowIso);

  return {
    systemExpectedBalance: systemExpected,
    actualEsunBalance: actual,
    discrepancyAmount: discrepancy,
    generatedGapTransaction: generatedGapTx,
    message,
    updatedMetrics: getSurvivalDashboardMetrics(db, refDate)
  };
}

function splitUnknownGapTransaction(db, gapTxId, items = []) {
  const gapTx = db.prepare("SELECT * FROM transactions WHERE id = ? AND status = 'UNKNOWN_GAP'").get(Number(gapTxId));
  if (!gapTx) throw new Error('找不到該筆未知漏帳黑洞紀錄');
  if (!Array.isArray(items) || items.length === 0) throw new Error('請提供至少一筆補齊明細');

  const nowIso = new Date().toISOString();
  let resolvedSum = 0;
  const createdTxs = [];

  for (const item of items) {
    const amt = Math.max(1, Math.round(Number(item.amount) || 0));
    const merchant = String(item.merchant || '補登消費').trim();
    const category = String(item.category || '一般消費').trim();
    resolvedSum += amt;

    const res = db.prepare(`
      INSERT INTO transactions (
        cycle_key, status, raw_merchant, normalized_merchant, category,
        auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
        tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
        reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
        channel_a_raw, channel_b_raw, created_at
      ) VALUES (?, 'SETTLED', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, 1, 100, ?, 0, 0, '黑洞拆分補齊', NULL, ?)
    `).run(
      gapTx.cycle_key, merchant, merchant, category,
      amt, amt, amt, amt, gapTx.tx_date, nowIso, nowIso,
      `✨ 由未知漏帳黑洞 (#${gapTx.id}) 拆分補齊明細`, nowIso
    );
    createdTxs.push(db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(res.lastInsertRowid)));
  }

  const remainingGap = Math.max(0, gapTx.personal_amount - resolvedSum);
  if (remainingGap === 0) {
    db.prepare("UPDATE transactions SET status = 'CANCELED', personal_amount = 0, reconcile_note = '✅ 未知黑洞已全數拆分補齊完畢' WHERE id = ?").run(gapTx.id);
  } else {
    db.prepare(`
      UPDATE transactions
      SET raw_merchant = ?, auth_amount = ?, effective_amount = ?, personal_amount = ?, reconcile_note = ?
      WHERE id = ?
    `).run(`$${remainingGap} 未知漏帳（待查黑洞）`, remainingGap, remainingGap, remainingGap, `尚餘 $${remainingGap} 待查黑洞（已拆分 $${resolvedSum}）`, gapTx.id);
  }

  return { remainingGap, createdTransactions: createdTxs };
}

/**
 * 4.4 首頁「使用現金直接登記」：同時扣減皮包現金水庫，並寫入交易明細（可選是否同步扣本月防剁手預算）
 */
function recordCashTransaction(db, { itemName, amount, category = '餐飲外食', countInBudget = true, txDate = null, referenceDateStr = null } = {}) {
  const amt = Math.round(Number(amount) || 0);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('請輸入大於 0 的現金消費金額');
  }
  const merchant = String(itemName || '現金消費').trim() || '現金消費';
  const cat = String(category || '餐飲外食').trim() || '餐飲外食';
  const nowIso = new Date().toISOString();
  const refDate = (referenceDateStr || txDate || nowIso.slice(0, 10)).slice(0, 10);
  const dateStr = (txDate || refDate).slice(0, 10);
  const cycle = ensureCurrentCycle(db, dateStr);

  // 1. 扣減皮包現金水庫
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  const curCash = Number(tank?.cash_balance) || 0;
  const newCash = Math.max(0, curCash - amt);
  db.prepare('UPDATE wallet_tank SET cash_balance = ?, updated_at = ? WHERE id = 1').run(newCash, nowIso);

  const personalAmt = countInBudget !== false ? amt : 0;
  const note = countInBudget !== false
    ? `💵 現金直接消費 -$${amt}（已扣減皮包現金，並計入本月總花費扣減防剁手預算）`
    : `💵 現金直接消費 -$${amt}（已從皮包現金水庫扣除，不重複扣減金融卡額度）`;

  // 2. 寫入 transactions 供「扣款紀錄」統一檢視
  const res = db.prepare(`
    INSERT INTO transactions (
      cycle_key, status, raw_merchant, normalized_merchant, category,
      auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
      tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
      reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
      channel_a_raw, channel_b_raw, created_at
    ) VALUES (?, 'CASH_SPENT', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, 1, 100, ?, 0, 0, 'CASH_DIRECT', NULL, ?)
  `).run(
    cycle.cycle_key, merchant, merchant, cat,
    amt, amt, amt, personalAmt,
    dateStr, nowIso, nowIso, note, nowIso
  );

  const txId = Number(res.lastInsertRowid);
  db.prepare(`
    INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
    VALUES ('CASH', ?, ?, ?, ?, ?)
  `).run(-amt, newCash, `💵 現金消費：${merchant}`, txId, nowIso);

  return {
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId),
    walletTank: getWalletTankStatus(db, nowIso)
  };
}

/**
 * 4.5 手動或從皮包現金轉存「金融卡 ATM 存款紀錄」
 */
function recordManualAtmDeposit(db, { amount, merchant = '玉山 ATM 存款', category = 'ATM存款', deductFromWalletCash = false, txDate = null, referenceDateStr = null } = {}) {
  const amt = Math.round(Number(amount) || 0);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('請輸入大於 0 的存款金額');
  }
  const cleanMerchant = String(merchant || '玉山 ATM 存款').trim() || '玉山 ATM 存款';
  const cat = String(category || 'ATM存款').trim() || 'ATM存款';
  const nowIso = new Date().toISOString();
  const refDate = (referenceDateStr || txDate || nowIso.slice(0, 10)).slice(0, 10);
  const dateStr = (txDate || refDate).slice(0, 10);
  const cycle = ensureCurrentCycle(db, dateStr);

  let note = `🏧 金融卡存款入帳 +$${amt.toLocaleString()}（已直接計入本月金融卡可用預算）`;
  if (deductFromWalletCash) {
    const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
    const curCash = Number(tank?.cash_balance) || 0;
    const newCash = Math.max(0, curCash - amt);
    db.prepare('UPDATE wallet_tank SET cash_balance = ?, updated_at = ? WHERE id = 1').run(newCash, nowIso);
    db.prepare(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
      VALUES ('CASH', ?, ?, ?, NULL, ?)
    `).run(-amt, newCash, `🏧 拿皮包現金去 ATM 存入金融卡 -$${amt}`, nowIso);
    note = `🏧 領現去 ATM 存入金融卡 +$${amt.toLocaleString()}（已同步扣減皮包現金並加入金融卡可用預算）`;
  }

  const res = db.prepare(`
    INSERT INTO transactions (
      cycle_key, status, raw_merchant, normalized_merchant, category,
      auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
      tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
      reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
      channel_a_raw, channel_b_raw, created_at
    ) VALUES (?, 'DEPOSIT', ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, NULL, 1, 100, ?, 0, 0, 'MANUAL_DEPOSIT', NULL, ?)
  `).run(
    cycle.cycle_key, cleanMerchant, cleanMerchant, cat,
    amt, amt, amt,
    dateStr, nowIso, nowIso, note, nowIso
  );

  const txId = Number(res.lastInsertRowid);
  return {
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId),
    walletTank: getWalletTankStatus(db, nowIso)
  };
}

/**
 * 4.6 刪除單筆交易或存款紀錄（若為現金消費則自動加回皮包現金）
 */
function deleteTransactionRecord(db, txId) {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(txId));
  if (!tx) throw new Error('找不到該筆紀錄');
  const nowIso = new Date().toISOString();

  if (tx.status === 'CASH_SPENT') {
    const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
    const curCash = Number(tank?.cash_balance) || 0;
    const refundAmt = Number(tx.effective_amount) || 0;
    const newCash = curCash + refundAmt;
    db.prepare('UPDATE wallet_tank SET cash_balance = ?, updated_at = ? WHERE id = 1').run(newCash, nowIso);
    db.prepare(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
      VALUES ('CASH', ?, ?, ?, NULL, ?)
    `).run(refundAmt, newCash, `↩️ 刪除現金消費退回：${tx.normalized_merchant}`, nowIso);
  }

  db.prepare('DELETE FROM transactions WHERE id = ?').run(tx.id);
  return { deletedId: tx.id };
}

module.exports = {
  splitTransactionBill, settleSplitBill, getSplitBillsSummary,
  getWalletTankStatus, quickAdjustWalletTank, auditWalletTank,
  syncEsunAvailableBalance, splitUnknownGapTransaction,
  recordCashTransaction, recordManualAtmDeposit, deleteTransactionRecord
};


