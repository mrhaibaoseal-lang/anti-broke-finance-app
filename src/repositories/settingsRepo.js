'use strict';

/**
 * 系統與週期設定 Repository (`user_settings`)
 */
async function getSettings(db) {
  return await db.queryOne('SELECT * FROM user_settings WHERE id = 1');
}

async function updateSettings(db, patch = {}) {
  const cur = await getSettings(db);
  const paydayDay = patch.paydayDay !== undefined
    ? Math.min(28, Math.max(1, Math.round(Number(patch.paydayDay) || 10)))
    : cur.payday_day;
  const defaultHourlyWage = patch.defaultHourlyWage !== undefined
    ? Math.max(1, Math.round(Number(patch.defaultHourlyWage) || 200))
    : cur.default_hourly_wage;
  const netPayFactor = patch.netPayFactor !== undefined
    ? Math.min(1, Math.max(0.5, Number(patch.netPayFactor) || 0.95))
    : cur.net_pay_factor;
  const laborHealthDeduction = patch.laborHealthDeduction !== undefined
    ? Math.max(0, Math.round(Number(patch.laborHealthDeduction) || 0))
    : cur.labor_health_deduction;
  const dedupeWindowMinutes = patch.dedupeWindowMinutes !== undefined
    ? Math.min(60, Math.max(1, Math.round(Number(patch.dedupeWindowMinutes) || 10)))
    : cur.dedupe_window_minutes;
  const lastKnownBankBalance = patch.lastKnownBankBalance !== undefined
    ? Math.round(Number(patch.lastKnownBankBalance) || 0)
    : cur.last_known_bank_balance;
  const forceHighRiskMode = patch.forceHighRiskMode !== undefined
    ? (patch.forceHighRiskMode ? 1 : 0)
    : cur.force_high_risk_mode;
  const nowIso = new Date().toISOString();

  await db.execute(`
    UPDATE user_settings
    SET payday_day = ?, default_hourly_wage = ?, net_pay_factor = ?,
        labor_health_deduction = ?, dedupe_window_minutes = ?,
        last_known_bank_balance = ?, force_high_risk_mode = ?, updated_at = ?
    WHERE id = 1
  `, [
    paydayDay,
    defaultHourlyWage,
    netPayFactor,
    laborHealthDeduction,
    dedupeWindowMinutes,
    lastKnownBankBalance,
    forceHighRiskMode,
    nowIso
  ]);

  return await getSettings(db);
}

module.exports = {
  getSettings,
  updateSettings
};
