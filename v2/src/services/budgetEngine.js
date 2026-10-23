'use strict';

const { SURVIVAL_TIERS, DEFAULT_PAYDAY_DAY } = require('../config/constants');
const { getSettings } = require('../repositories/settingsRepo');
const { ensureCycle, updateCycleBaseBudget } = require('../repositories/cycleRepo');
const { getCycleAggregates } = require('../repositories/ledgerRepo');
const { getWalletTank } = require('../repositories/walletTankRepo');
const { listActiveFixedExpenses } = require('../repositories/impulseRepo');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatYMD(dt) {
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function getTaipeiNowParts(referenceNowIso = null) {
  let dt;
  if (!referenceNowIso) {
    dt = new Date();
  } else {
    const s = String(referenceNowIso).trim();
    const hasTz = /Z$|[+-]\d{2}:?\d{2}$/i.test(s);
    dt = new Date(hasTz ? s : (s.length === 10 ? `${s}T12:00:00+08:00` : `${s}+08:00`));
    if (Number.isNaN(dt.getTime())) dt = new Date();
  }
  const taipeiDt = new Date(dt.getTime() + 8 * 3600 * 1000);
  const year = taipeiDt.getUTCFullYear();
  const month = pad2(taipeiDt.getUTCMonth() + 1);
  const day = pad2(taipeiDt.getUTCDate());
  const hour = taipeiDt.getUTCHours();
  const minute = taipeiDt.getUTCMinutes();
  return {
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${pad2(hour)}:${pad2(minute)}`,
    hour,
    minute
  };
}

function getCycleRangeForDate(dateStr, paydayDay = DEFAULT_PAYDAY_DAY) {
  const safePayday = Math.min(28, Math.max(1, Number(paydayDay) || DEFAULT_PAYDAY_DAY));
  const ymd = (dateStr || getTaipeiNowParts().dateStr).slice(0, 10);
  const ref = new Date(`${ymd}T00:00:00`);
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
    paydayDay: safePayday
  };
}

function evaluateSurvivalTier(dailySafeBudget) {
  const d = Number(dailySafeBudget) || 0;
  if (d >= SURVIVAL_TIERS.WEALTHY.minDaily) return { ...SURVIVAL_TIERS.WEALTHY };
  if (d >= SURVIVAL_TIERS.NORMAL.minDaily) return { ...SURVIVAL_TIERS.NORMAL };
  if (d >= SURVIVAL_TIERS.BEGGAR_HERO.minDaily) return { ...SURVIVAL_TIERS.BEGGAR_HERO };
  return { ...SURVIVAL_TIERS.DIRT_EATING };
}

async function ensureCurrentBudgetCycle(db, referenceDateStr = null) {
  const settings = await getSettings(db);
  const refDate = (referenceDateStr || getTaipeiNowParts().dateStr).slice(0, 10);
  const range = getCycleRangeForDate(refDate, settings.payday_day);
  return await ensureCycle(db, {
    cycleKey: range.cycleKey,
    startDate: range.startDate,
    endDate: range.endDate,
    defaultBaseBudget: 0
  });
}

async function setMonthlyBaseBudget(db, { baseBudget, budgetNote = '手動設定起始預算', referenceDateStr = null }) {
  const cycle = await ensureCurrentBudgetCycle(db, referenceDateStr);
  return await updateCycleBaseBudget(db, cycle.cycle_key, { baseBudget, budgetNote });
}

async function getBudgetOverviewMetrics(db, referenceDateStr = null) {
  const settings = await getSettings(db);
  const refDate = (referenceDateStr || getTaipeiNowParts().dateStr).slice(0, 10);
  const cycle = await ensureCurrentBudgetCycle(db, refDate);
  const fixedList = await listActiveFixedExpenses(db);
  const fixedTotal = fixedList.reduce((sum, item) => sum + (Number(item.monthly_amount) || 0), 0);

  const agg = await getCycleAggregates(db, cycle.cycle_key, refDate);
  const tank = await getWalletTank(db);

  const startMs = new Date(`${cycle.start_date}T00:00:00`).getTime();
  const endMs = new Date(`${cycle.end_date}T00:00:00`).getTime();
  const refMs = Math.min(endMs, Math.max(startMs, new Date(`${refDate}T00:00:00`).getTime()));

  const totalCycleDays = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
  const daysElapsed = Math.max(1, Math.round((refMs - startMs) / 86400000) + 1);
  const daysRemaining = Math.max(1, Math.round((endMs - refMs) / 86400000) + 1);

  const baseBudget = Number(cycle.base_budget) || 0;
  const netDigitalUsed = Number(agg.net_digital_budget_used) || 0;
  const digitalExpenseTotal = Number(agg.digital_expense_total) || 0;
  const cashExpenseTotal = Number(agg.cash_expense_total) || 0;
  const gapExpenseTotal = Number(agg.gap_expense_total) || 0;
  const atmCashDepositedToCard = Number(agg.atm_cash_deposited_to_card) || 0;
  const externalDepositRecorded = Number(agg.external_deposit_recorded) || 0;
  const todayDigitalSpent = Number(agg.today_digital_spent) || 0;
  const todayCashSpent = Number(agg.today_cash_spent) || 0;

  // 1. 💳 本月數位可用預算 (決定四級生存狀態)
  const disposableDigitalPool = baseBudget - fixedTotal;
  const digitalRemainingBudget = disposableDigitalPool - netDigitalUsed;
  const dailySafeBudget = Math.floor(digitalRemainingBudget / daysRemaining);
  const idealDailyBudget = Math.max(1, Math.floor(Math.max(0, disposableDigitalPool) / totalCycleDays));

  // 2. 💵 實體水庫總額 (皮包現金 + 悠遊卡)
  const cashBalance = Number(tank?.cash_balance) || 0;
  const easycardBalance = Number(tank?.easycard_balance) || 0;
  const physicalTankTotal = cashBalance + easycardBalance;

  // 3. 💰 最終總可用剩餘 (數位可用預算 + 實體水庫總額)
  const grandTotalAvailable = digitalRemainingBudget + physicalTankTotal;

  const avgDailyBurnRate = Math.round((digitalExpenseTotal + gapExpenseTotal) / daysElapsed);
  const effectiveBurnVelocity = Math.max(avgDailyBurnRate, todayDigitalSpent);
  const isUnconfiguredZero = baseBudget === 0 && fixedTotal === 0 && netDigitalUsed === 0 && physicalTankTotal === 0;

  let daysUntilBroke = null;
  let projectedBrokeDate = null;
  let overdraftDays = 0;
  let bankruptcyWarningText = null;

  if (!isUnconfiguredZero && digitalRemainingBudget <= 0) {
    daysUntilBroke = 0;
    projectedBrokeDate = refDate;
    overdraftDays = daysRemaining;
    bankruptcyWarningText = `🚨 緊急破產警報：本月數位可用預算已透支 $${Math.abs(digitalRemainingBudget).toLocaleString()} 元！接下來 ${daysRemaining} 天每日數位安全額度為 $0 元！`;
  } else if (!isUnconfiguredZero && effectiveBurnVelocity > Math.max(1, dailySafeBudget)) {
    daysUntilBroke = Math.max(1, Math.floor(digitalRemainingBudget / effectiveBurnVelocity));
    if (daysUntilBroke < daysRemaining) {
      const brokeDt = new Date(refMs + daysUntilBroke * 86400000);
      projectedBrokeDate = `${brokeDt.getMonth() + 1}月${brokeDt.getDate()}號`;
      const excessAmt = Math.max(todayDigitalSpent - idealDailyBudget, (digitalExpenseTotal + gapExpenseTotal) - idealDailyBudget * daysElapsed);
      overdraftDays = Math.max(1, Math.ceil(Math.max(1, excessAmt) / idealDailyBudget));
      bankruptcyWarningText = `⚠️ 破產倒數預警：按目前數位花費速度（日均 $${effectiveBurnVelocity.toLocaleString()}），預計將在【${projectedBrokeDate}】提前花光數位預算！目前已透支未來 ${overdraftDays} 天餐費，接下來每天安全額度剩 $${Math.max(0, dailySafeBudget).toLocaleString()} 元。`;
    }
  }

  const tier = isUnconfiguredZero
    ? {
        code: 'WEALTHY',
        emoji: '🎯',
        label: '請設定本月起始預算',
        rangeText: '前往設定或點右上角設定預算',
        themeColor: 'emerald',
        advice: '💡 請先點擊右上角「預算設定」輸入本月起始數位預算，即可啟動四級生存雷達與防破產守門員。'
      }
    : evaluateSurvivalTier(dailySafeBudget);

  return {
    referenceDate: refDate,
    cycle: {
      cycleKey: cycle.cycle_key,
      startDate: cycle.start_date,
      endDate: cycle.end_date,
      paydayDay: settings.payday_day,
      totalCycleDays,
      daysElapsed,
      daysRemaining,
      baseBudget,
      budgetNote: cycle.budget_note || '手動設定',
      hourlyWage: settings.default_hourly_wage,
      netPayFactor: settings.net_pay_factor,
      laborHealthDeduction: settings.labor_health_deduction
    },
    metrics: {
      digitalRemainingBudget,
      physicalTankTotal,
      grandTotalAvailable,
      baseBudget,
      fixedTotal,
      disposableDigitalPool,
      digitalExpenseTotal,
      cashExpenseTotal,
      gapExpenseTotal,
      atmCashDepositedToCard,
      externalDepositRecorded,
      todayDigitalSpent,
      todayCashSpent,
      cashBalance,
      easycardBalance,
      dailySafeBudget,
      idealDailyBudget,
      avgDailyBurnRate,
      daysUntilBroke,
      projectedBrokeDate,
      overdraftDays,
      bankruptcyWarningText,
      suspectedDuplicateCount: Number(agg.suspected_duplicate_count) || 0
    },
    tier
  };
}

module.exports = {
  getTaipeiNowParts,
  getCycleRangeForDate,
  evaluateSurvivalTier,
  ensureCurrentBudgetCycle,
  setMonthlyBaseBudget,
  getBudgetOverviewMetrics
};

