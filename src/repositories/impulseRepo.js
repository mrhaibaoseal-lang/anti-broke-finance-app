'use strict';

/**
 * 72 小時防衝動冷卻池與每月固定扣款/訂閱 Repository (`cooldown_cart`, `fixed_expenses`)
 */
async function listCooldownItems(db) {
  return await db.queryAll('SELECT * FROM cooldown_cart ORDER BY id DESC');
}

async function getCooldownItemById(db, id) {
  return await db.queryOne('SELECT * FROM cooldown_cart WHERE id = ?', [Number(id)]);
}

async function insertCooldownItem(db, item) {
  const nowIso = item.createdAt || new Date().toISOString();
  const res = await db.execute(`
    INSERT INTO cooldown_cart (
      item_name, amount, reason, item_type, work_hours_equivalent,
      daily_budget_before, daily_budget_after, tier_before, tier_after,
      ai_roast_message, status, created_at, unlock_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COOLING', ?, ?)
  `, [
    item.itemName,
    Math.max(1, Math.round(Number(item.amount) || 0)),
    item.reason || '',
    item.itemType || 'WANT',
    Number(item.workHoursEquivalent) || 0,
    Math.round(Number(item.dailyBudgetBefore) || 0),
    Math.round(Number(item.dailyBudgetAfter) || 0),
    item.tierBefore || '',
    item.tierAfter || '',
    item.aiRoastMessage || '',
    nowIso,
    item.unlockAt
  ]);
  return await getCooldownItemById(db, res.lastInsertRowid);
}

async function updateCooldownUnlockTime(db, id, unlockAtIso) {
  await db.execute('UPDATE cooldown_cart SET unlock_at = ? WHERE id = ?', [unlockAtIso, Number(id)]);
  return await getCooldownItemById(db, id);
}

async function updateCooldownStatus(db, id, status) {
  const nowIso = new Date().toISOString();
  await db.execute(`
    UPDATE cooldown_cart
    SET status = ?, resolved_at = ?
    WHERE id = ?
  `, [status, nowIso, Number(id)]);
  return await getCooldownItemById(db, id);
}

async function listActiveFixedExpenses(db) {
  return await db.queryAll('SELECT * FROM fixed_expenses WHERE is_active = 1 ORDER BY billing_day ASC, id ASC');
}

async function insertFixedExpense(db, { name, expenseType = 'FIXED', monthlyAmount, billingDay = 15 }) {
  const nowIso = new Date().toISOString();
  const cleanType = expenseType === 'SUBSCRIPTION' ? 'SUBSCRIPTION' : 'FIXED';
  const res = await db.execute(`
    INSERT INTO fixed_expenses (name, expense_type, monthly_amount, billing_day, is_active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `, [
    String(name || '固定開銷').trim(),
    cleanType,
    Math.max(1, Math.round(Number(monthlyAmount) || 0)),
    Math.min(31, Math.max(1, Math.round(Number(billingDay) || 15))),
    nowIso
  ]);
  return await db.queryOne('SELECT * FROM fixed_expenses WHERE id = ?', [res.lastInsertRowid]);
}

async function deleteFixedExpense(db, id) {
  return await db.execute('DELETE FROM fixed_expenses WHERE id = ?', [Number(id)]);
}

module.exports = {
  listCooldownItems,
  getCooldownItemById,
  insertCooldownItem,
  updateCooldownUnlockTime,
  updateCooldownStatus,
  listActiveFixedExpenses,
  insertFixedExpense,
  deleteFixedExpense
};
