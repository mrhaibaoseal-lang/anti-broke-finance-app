'use strict';

const { readExternalShiftDirectory, parseShiftPayload, calculateEstimatedNetPay } = require('./shiftSyncService');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatYMD(dt) {
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/**
 * 1.2 自訂「發薪日生存週期」計算器 (禁止死板以每月 1 號重置)
 */
function getCycleRangeForDate(dateStr, paydayDay = 10) {
  const safePayday = Math.min(28, Math.max(1, Number(paydayDay) || 10));
  const ref = dateStr ? new Date(`${dateStr.slice(0, 10)}T00:00:00`) : new Date();
  const y = ref.getFullYear();
  const m = ref.getMonth();
  const d = ref.getDate();

  const startDt = d >= safePayday ? new Date(y, m, safePayday) : new Date(y, m - 1, safePayday);
  const endDt = d >= safePayday ? new Date(y, m + 1, safePayday - 1) : new Date(y, m, safePayday - 1);

  const startDate = formatYMD(startDt);
  const endDate = formatYMD(endDt);
  return {
    cycleKey: `${startDate}_${endDate}`,
    startDate,
    endDate,
    targetShiftMonth: startDate.slice(0, 7),
    paydayDay: safePayday
  };
}

function ensureCurrentCycle(db, referenceDateStr) {
  const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
  const range = getCycleRangeForDate(referenceDateStr, settings.payday_day);

  let cycle = db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(range.cycleKey);
  if (!cycle) {
    const nowIso = new Date().toISOString();
    const initialWage = Number(settings.default_hourly_wage) || 200;

    db.prepare(`
      INSERT INTO income_cycles (
        cycle_key, start_date, end_date, target_shift_month,
        shift_gross_pay, normal_hours, ot_minutes, bonus_pay,
        hourly_wage, estimated_net_pay, actual_salary, is_salary_settled,
        shift_sync_source, raw_shift_payload, last_synced_at
      ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, 0, NULL, 0, 'init_clean', NULL, ?)
    `).run(
      range.cycleKey,
      range.startDate,
      range.endDate,
      range.targetShiftMonth,
      initialWage,
      nowIso
    );

    cycle = db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(range.cycleKey);
  }
  return cycle;
}

function syncCycleWithShiftData(db, { rawJsonPayload = null, manualNetSalary = null, manualGrossPay = null, manualHourlyWage = null, recalculateOnly = false, referenceDateStr = null } = {}) {
  const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
  const cycle = ensureCurrentCycle(db, referenceDateStr);
  const nowIso = new Date().toISOString();

  const wage = (manualHourlyWage !== null && manualHourlyWage !== undefined && Number(manualHourlyWage) > 0)
    ? Math.round(Number(manualHourlyWage))
    : (Number(cycle.hourly_wage) || Number(settings.default_hourly_wage) || 200);

  if (wage > 0) {
    db.prepare('UPDATE user_settings SET default_hourly_wage = ?, updated_at = ? WHERE id = 1').run(wage, nowIso);
  }

  // 模式 A：使用者直接輸入「本月實領薪資 / 可用預算」
  if (manualNetSalary !== null && manualNetSalary !== undefined && String(manualNetSalary).trim() !== '') {
    const netAmt = Math.max(0, Math.round(Number(manualNetSalary) || 0));
    const grossAmt = (manualGrossPay !== null && manualGrossPay !== undefined && String(manualGrossPay).trim() !== '')
      ? Math.max(0, Math.round(Number(manualGrossPay) || 0))
      : netAmt;

    db.prepare(`
      UPDATE income_cycles
      SET shift_gross_pay = ?, hourly_wage = ?, estimated_net_pay = ?,
          actual_salary = ?, is_salary_settled = 1, shift_sync_source = 'manual_salary', last_synced_at = ?
      WHERE cycle_key = ?
    `).run(grossAmt, wage, netAmt, netAmt, nowIso, cycle.cycle_key);

    return db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(cycle.cycle_key);
  }

  // 模式 B：使用者輸入「預估班表總薪資 (Gross)」，由系統乘上折數與扣除勞健保
  if (manualGrossPay !== null && manualGrossPay !== undefined && String(manualGrossPay).trim() !== '') {
    const grossAmt = Math.max(0, Math.round(Number(manualGrossPay) || 0));
    const estNet = calculateEstimatedNetPay(grossAmt, settings.net_pay_factor, settings.labor_health_deduction);

    db.prepare(`
      UPDATE income_cycles
      SET shift_gross_pay = ?, hourly_wage = ?, estimated_net_pay = ?,
          actual_salary = NULL, is_salary_settled = 0, shift_sync_source = 'manual_gross', last_synced_at = ?
      WHERE cycle_key = ?
    `).run(grossAmt, wage, estNet, nowIso, cycle.cycle_key);

    return db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(cycle.cycle_key);
  }

  // 模式 C：僅變更設定（折數 / 勞健保 / 時薪）時重算現有週期，不洗掉既有薪資
  if (recalculateOnly) {
    const estNet = calculateEstimatedNetPay(cycle.shift_gross_pay, settings.net_pay_factor, settings.labor_health_deduction);
    db.prepare(`
      UPDATE income_cycles
      SET hourly_wage = ?, estimated_net_pay = ?, last_synced_at = ?
      WHERE cycle_key = ?
    `).run(wage, estNet, nowIso, cycle.cycle_key);
    return db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(cycle.cycle_key);
  }

  // 模式 D：從貼上的 shiftpay-v2 JSON 或外部目錄唯讀同步
  const synced = rawJsonPayload
    ? { ...parseShiftPayload(rawJsonPayload, cycle.target_shift_month), syncSource: 'clipboard_or_upload_json' }
    : readExternalShiftDirectory(settings.shift_app_path, cycle.target_shift_month);

  const estNetPay = calculateEstimatedNetPay(
    synced.totalPay,
    settings.net_pay_factor,
    settings.labor_health_deduction
  );

  db.prepare(`
    UPDATE income_cycles
    SET shift_gross_pay = ?, normal_hours = ?, ot_minutes = ?, bonus_pay = ?,
        hourly_wage = ?, estimated_net_pay = ?, shift_sync_source = ?,
        raw_shift_payload = ?, last_synced_at = ?
    WHERE cycle_key = ?
  `).run(
    synced.totalPay, synced.normalHours, synced.otMinutes, synced.bonusPay,
    synced.hourlyWage || wage, estNetPay, synced.syncSource,
    JSON.stringify(synced), nowIso, cycle.cycle_key
  );

  if (synced.hourlyWage > 0) {
    db.prepare('UPDATE user_settings SET default_hourly_wage = ?, updated_at = ? WHERE id = 1')
      .run(synced.hourlyWage, nowIso);
  }
  return db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(cycle.cycle_key);
}

function applyActualSalaryDeposit(db, actualAmount, referenceDateStr) {
  const cycle = ensureCurrentCycle(db, referenceDateStr);
  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE income_cycles
    SET actual_salary = ?, is_salary_settled = 1, last_synced_at = ?
    WHERE cycle_key = ?
  `).run(Math.round(Number(actualAmount)), nowIso, cycle.cycle_key);
  return db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(cycle.cycle_key);
}

function evaluateSurvivalTier(dailySafeAmount) {
  if (dailySafeAmount > 500) {
    return { code: 'WEALTHY', emoji: '🟢', label: '財富自由級', rangeText: '每日可用 > $500', themeColor: 'emerald', advice: '手頭寬裕！記得把多餘額度存起來，別在深夜手滑。' };
  }
  if (dailySafeAmount >= 250) {
    return { code: 'NORMAL', emoji: '🟡', label: '普通生存級', rangeText: '每日可用 $250 ~ $500', themeColor: 'amber', advice: '收支平衡！三餐正常吃沒問題，買超過 $300 的非必需品請先三思。' };
  }
  if (dailySafeAmount >= 150) {
    return { code: 'BEGGAR_HERO', emoji: '🟠', label: '超商乞丐超人級', rangeText: '每日可用 $150 ~ $250', themeColor: 'orange', advice: '警報響起！請鎖定超商 20:00 後友善時光，禁止手搖飲與消夜！' };
  }
  return { code: 'DIRT_EATING', emoji: '🔴', label: '極限吃土喝水級', rangeText: '每日可用 < $150', themeColor: 'rose', advice: '紅色破產危機！目前額度連便當都危險，嚴禁任何非生存必要支出！' };
}

function getSurvivalDashboardMetrics(db, referenceDateStr) {
  const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
  const refDate = (referenceDateStr || formatYMD(new Date())).slice(0, 10);
  const cycle = ensureCurrentCycle(db, refDate);

  const effectiveIncome = cycle.is_salary_settled && cycle.actual_salary !== null
    ? Number(cycle.actual_salary)
    : Number(cycle.estimated_net_pay);

  const fixedRow = db.prepare('SELECT COALESCE(SUM(monthly_amount), 0) AS total_fixed FROM fixed_expenses WHERE is_active = 1').get();
  const fixedAndInstallments = Number(fixedRow.total_fixed) || 0;

  const spentRow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('PENDING', 'SETTLED', 'UNKNOWN_GAP') THEN personal_amount ELSE 0 END), 0) AS total_spent,
      COALESCE(SUM(CASE WHEN status = 'PENDING' THEN personal_amount ELSE 0 END), 0) AS pending_spent,
      COALESCE(SUM(CASE WHEN status = 'SETTLED' THEN personal_amount ELSE 0 END), 0) AS settled_spent,
      COALESCE(SUM(CASE WHEN status = 'UNKNOWN_GAP' THEN personal_amount ELSE 0 END), 0) AS gap_spent,
      COALESCE(SUM(CASE WHEN status IN ('PENDING', 'SETTLED', 'UNKNOWN_GAP') AND tx_date = ? THEN personal_amount ELSE 0 END), 0) AS today_spent
    FROM transactions WHERE cycle_key = ?
  `).get(refDate, cycle.cycle_key);

  const totalSpent = Number(spentRow.total_spent) || 0;
  const todaySpent = Number(spentRow.today_spent) || 0;

  const startMs = new Date(`${cycle.start_date}T00:00:00`).getTime();
  const endMs = new Date(`${cycle.end_date}T00:00:00`).getTime();
  const refMs = Math.min(endMs, Math.max(startMs, new Date(`${refDate}T00:00:00`).getTime()));

  const totalCycleDays = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
  const daysElapsed = Math.max(1, Math.round((refMs - startMs) / 86400000) + 1);
  const daysRemaining = Math.max(1, Math.round((endMs - refMs) / 86400000) + 1);

  const disposablePool = effectiveIncome - fixedAndInstallments;
  const remainingBudget = disposablePool - totalSpent;
  const dailySafeBudget = Math.floor(remainingBudget / daysRemaining);
  const idealDailyBudget = Math.max(1, Math.floor(disposablePool / totalCycleDays));

  const avgDailyBurnRate = Math.round(totalSpent / daysElapsed);
  const isTodayOverspent = todaySpent > idealDailyBudget || (remainingBudget < disposablePool * (daysRemaining / totalCycleDays));

  let projectedBrokeDate = null, daysUntilBroke = null, overdraftDays = 0, bankruptcyWarningText = null;
  const effectiveBurnVelocity = Math.max(avgDailyBurnRate, todaySpent);
  const isInitialZeroState = effectiveIncome === 0 && fixedAndInstallments === 0 && totalSpent === 0;

  if (!isInitialZeroState && remainingBudget <= 0) {
    daysUntilBroke = 0;
    projectedBrokeDate = refDate;
    overdraftDays = daysRemaining;
    bankruptcyWarningText = `🚨 緊急破產警報：可用安全預算已透支 $${Math.abs(remainingBudget)} 元！你已透支未來 ${daysRemaining} 天的餐費，接下來每天只能花 $0 元！`;
  } else if (!isInitialZeroState && effectiveBurnVelocity > Math.max(1, dailySafeBudget)) {
    daysUntilBroke = Math.max(1, Math.floor(remainingBudget / effectiveBurnVelocity));
    if (daysUntilBroke < daysRemaining) {
      const brokeDt = new Date(refMs + daysUntilBroke * 86400000);
      projectedBrokeDate = `${brokeDt.getMonth() + 1}月${brokeDt.getDate()}號`;
    }
    const excessAmount = Math.max(todaySpent - idealDailyBudget, totalSpent - idealDailyBudget * daysElapsed);
    if (excessAmount > 0) {
      overdraftDays = Math.max(1, Math.ceil(excessAmount / Math.max(1, idealDailyBudget)));
      bankruptcyWarningText = `⚠️ 破產倒數預警：按目前花費速度（日均 $${effectiveBurnVelocity}），將在【${projectedBrokeDate || '發薪日前'}】破產歸零！你已透支未來 ${overdraftDays} 天的餐費，接下來每天只能花 $${Math.max(0, dailySafeBudget)} 元！`;
    }
  }

  const tier = isInitialZeroState
    ? {
        code: 'WEALTHY',
        emoji: '✨',
        label: '初始待設定狀態',
        rangeText: '請輸入本月薪資',
        themeColor: 'emerald',
        advice: '帳本已歸零為初始狀態！請點選右上角「💰 設定薪資 / 班表同步」輸入您目前的薪資與時薪，並新增您的固定扣款與消費。'
      }
    : evaluateSurvivalTier(dailySafeBudget);

  return {
    referenceDate: refDate,
    cycle: {
      cycleKey: cycle.cycle_key, startDate: cycle.start_date, endDate: cycle.end_date,
      paydayDay: settings.payday_day, totalCycleDays, daysElapsed, daysRemaining,
      targetShiftMonth: cycle.target_shift_month, shiftGrossPay: cycle.shift_gross_pay,
      normalHours: cycle.normal_hours, otMinutes: cycle.ot_minutes, bonusPay: cycle.bonus_pay,
      hourlyWage: cycle.hourly_wage || settings.default_hourly_wage,
      netPayFactor: settings.net_pay_factor, laborHealthDeduction: settings.labor_health_deduction,
      estimatedNetPay: cycle.estimated_net_pay, actualSalary: cycle.actual_salary,
      isSalarySettled: Boolean(cycle.is_salary_settled), shiftSyncSource: cycle.shift_sync_source,
      lastSyncedAt: cycle.last_synced_at
    },
    budget: {
      effectiveIncome, fixedAndInstallments, disposablePool, totalSpent,
      pendingSpent: Number(spentRow.pending_spent) || 0, settledSpent: Number(spentRow.settled_spent) || 0,
      gapSpent: Number(spentRow.gap_spent) || 0, todaySpent, remainingBudget, dailySafeBudget,
      idealDailyBudget, avgDailyBurnRate, isTodayOverspent: isInitialZeroState ? false : isTodayOverspent, overdraftDays,
      daysUntilBroke, projectedBrokeDate, bankruptcyWarningText
    },
    tier
  };
}

module.exports = {
  getCycleRangeForDate, ensureCurrentCycle, syncCycleWithShiftData,
  applyActualSalaryDeposit, evaluateSurvivalTier, getSurvivalDashboardMetrics
};
