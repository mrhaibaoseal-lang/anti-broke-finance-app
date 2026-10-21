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

function quickAdjustWalletTank(db, { tankType = 'CASH', deltaAmount = -50, note = '快速扣水庫銅板消費' }) {
  const type = String(tankType).toUpperCase() === 'EASYCARD' ? 'EASYCARD' : 'CASH';
  const col = type === 'EASYCARD' ? 'easycard_balance' : 'cash_balance';
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  const delta = Math.round(Number(deltaAmount) || 0);
  const newBalance = Math.max(0, (Number(tank[col]) || 0) + delta);
  const nowIso = new Date().toISOString();

  db.prepare(`UPDATE wallet_tank SET ${col} = ?, updated_at = ? WHERE id = 1`).run(newBalance, nowIso);
  db.prepare(`
    INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(type, delta, newBalance, String(note || '水庫變動'), nowIso);

  return getWalletTankStatus(db, nowIso);
}

function auditWalletTank(db, { easycardBalance, cashBalance }) {
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  const nowIso = new Date().toISOString();
  const newEasy = easycardBalance !== undefined ? Math.max(0, Math.round(Number(easycardBalance))) : tank.easycard_balance;
  const newCash = cashBalance !== undefined ? Math.max(0, Math.round(Number(cashBalance))) : tank.cash_balance;

  const diffEasy = newEasy - tank.easycard_balance;
  const diffCash = newCash - tank.cash_balance;

  db.prepare(`
    UPDATE wallet_tank SET easycard_balance = ?, cash_balance = ?, last_audit_at = ?, updated_at = ? WHERE id = 1
  `).run(newEasy, newCash, nowIso, nowIso);

  if (diffEasy !== 0) {
    db.prepare(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
      VALUES ('EASYCARD', ?, ?, '3天定期盤點手動校正', NULL, ?)
    `).run(diffEasy, newEasy, nowIso);
  }
  if (diffCash !== 0) {
    db.prepare(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
      VALUES ('CASH', ?, ?, '3天定期盤點手動校正', NULL, ?)
    `).run(diffCash, newCash, nowIso);
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

module.exports = {
  splitTransactionBill, settleSplitBill, getSplitBillsSummary,
  getWalletTankStatus, quickAdjustWalletTank, auditWalletTank,
  syncEsunAvailableBalance, splitUnknownGapTransaction
};


