'use strict';

/**
 * 實體水庫 (皮包現金 & 悠遊卡) 與餘額校正歷史 Repository (`wallet_tank`, `wallet_tank_logs`, `balance_sync_logs`)
 */
async function getWalletTank(db) {
  return await db.queryOne('SELECT * FROM wallet_tank WHERE id = 1');
}

async function applyTankDelta(db, { tankType, deltaAmount, note, linkedEntryId = null }) {
  const delta = Math.round(Number(deltaAmount) || 0);
  if (delta === 0) return await getWalletTank(db);

  const tank = await getWalletTank(db);
  const col = tankType === 'EASYCARD' ? 'easycard_balance' : 'cash_balance';
  const curBal = Number(tank?.[col]) || 0;
  const newBal = Math.max(0, curBal + delta);
  const nowIso = new Date().toISOString();

  await db.execute(`UPDATE wallet_tank SET ${col} = ?, updated_at = ? WHERE id = 1`, [newBal, nowIso]);
  await db.execute(`
    INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_entry_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [tankType === 'EASYCARD' ? 'EASYCARD' : 'CASH', delta, newBal, String(note || ''), linkedEntryId, nowIso]);

  return await getWalletTank(db);
}

async function setTankBalancesAudit(db, { cashBalance, easycardBalance }) {
  const tank = await getWalletTank(db);
  const nowIso = new Date().toISOString();
  const nextCash = cashBalance !== undefined && cashBalance !== null && String(cashBalance).trim() !== ''
    ? Math.max(0, Math.round(Number(cashBalance) || 0))
    : Number(tank.cash_balance) || 0;
  const nextEasy = easycardBalance !== undefined && easycardBalance !== null && String(easycardBalance).trim() !== ''
    ? Math.max(0, Math.round(Number(easycardBalance) || 0))
    : Number(tank.easycard_balance) || 0;

  const cashDiff = nextCash - (Number(tank.cash_balance) || 0);
  const easyDiff = nextEasy - (Number(tank.easycard_balance) || 0);

  await db.execute(`
    UPDATE wallet_tank
    SET cash_balance = ?, easycard_balance = ?, last_audit_at = ?, updated_at = ?
    WHERE id = 1
  `, [nextCash, nextEasy, nowIso, nowIso]);

  if (cashDiff !== 0) {
    await db.execute(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_entry_id, created_at)
      VALUES ('CASH', ?, ?, '📋 盤點校正皮包現金餘額', NULL, ?)
    `, [cashDiff, nextCash, nowIso]);
  }
  if (easyDiff !== 0) {
    await db.execute(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_entry_id, created_at)
      VALUES ('EASYCARD', ?, ?, '📋 盤點校正悠遊卡餘額', NULL, ?)
    `, [easyDiff, nextEasy, nowIso]);
  }

  return await getWalletTank(db);
}

async function listWalletTankLogs(db, limit = 25) {
  return await db.queryAll('SELECT * FROM wallet_tank_logs ORDER BY id DESC LIMIT ?', [Number(limit)]);
}

async function insertBalanceSyncLog(db, { expectedDigitalBalance, actualBankBalance, discrepancyAmount, generatedGapEntryId, note }) {
  const nowIso = new Date().toISOString();
  await db.execute(`
    INSERT INTO balance_sync_logs (
      expected_digital_balance, actual_bank_balance, discrepancy_amount,
      generated_gap_entry_id, note, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `, [
    Math.round(Number(expectedDigitalBalance) || 0),
    Math.round(Number(actualBankBalance) || 0),
    Math.round(Number(discrepancyAmount) || 0),
    generatedGapEntryId || null,
    note || '',
    nowIso
  ]);
}

async function listBalanceSyncLogs(db, limit = 10) {
  return await db.queryAll('SELECT * FROM balance_sync_logs ORDER BY id DESC LIMIT ?', [Number(limit)]);
}

module.exports = {
  getWalletTank,
  applyTankDelta,
  setTankBalancesAudit,
  listWalletTankLogs,
  insertBalanceSyncLog,
  listBalanceSyncLogs
};
