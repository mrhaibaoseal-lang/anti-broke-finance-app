'use strict';

/**
 * 發薪週期與單一權威起始預算 Repository (`budget_cycles`)
 */
async function getCycleByKey(db, cycleKey) {
  return await db.queryOne('SELECT * FROM budget_cycles WHERE cycle_key = ?', [cycleKey]);
}

async function ensureCycle(db, { cycleKey, startDate, endDate, defaultBaseBudget = 0 }) {
  let cycle = await getCycleByKey(db, cycleKey);
  if (!cycle) {
    const nowIso = new Date().toISOString();
    await db.execute(`
      INSERT INTO budget_cycles (cycle_key, start_date, end_date, base_budget, budget_note, updated_at)
      VALUES (?, ?, ?, ?, '尚未設定起始預算', ?)
    `, [cycleKey, startDate, endDate, Math.max(0, Math.round(Number(defaultBaseBudget) || 0)), nowIso]);
    cycle = await getCycleByKey(db, cycleKey);
  }
  return cycle;
}

async function updateCycleBaseBudget(db, cycleKey, { baseBudget, budgetNote = '手動設定起始預算' }) {
  const nowIso = new Date().toISOString();
  const cleanBudget = Math.max(0, Math.round(Number(baseBudget) || 0));
  await db.execute(`
    UPDATE budget_cycles
    SET base_budget = ?, budget_note = ?, updated_at = ?
    WHERE cycle_key = ?
  `, [cleanBudget, String(budgetNote || '手動設定起始預算').trim(), nowIso, cycleKey]);
  return await getCycleByKey(db, cycleKey);
}

module.exports = {
  getCycleByKey,
  ensureCycle,
  updateCycleBaseBudget
};
