'use strict';

const { getSettings } = require('../repositories/settingsRepo');
const { listEntriesWithSplits } = require('../repositories/ledgerRepo');
const { listRecentIngestionLogs } = require('../repositories/dedupeRepo');
const { listBalanceSyncLogs } = require('../repositories/walletTankRepo');
const { getBudgetOverviewMetrics } = require('../services/budgetEngine');
const { getHighRiskModeStatus, getCooldownCartSummary, getVampireAndSubscriptionRadar } = require('../services/impulseService');
const { getWalletTankStatus, getSplitBillsSummary } = require('../services/splitAndTankService');

/**
 * 組裝前端 Dashboard 完整狀態快照 (純讀取聚合，不含任何隱藏寫入或背景改預算副作用)
 */
async function buildDashboardState(db) {
  const settings = await getSettings(db);
  const budgetOverview = await getBudgetOverviewMetrics(db);
  const highRiskMode = await getHighRiskModeStatus(db);
  const walletTank = await getWalletTankStatus(db);
  const splitBills = await getSplitBillsSummary(db);
  const cooldownCart = await getCooldownCartSummary(db);
  const radar = await getVampireAndSubscriptionRadar(db);
  const entries = await listEntriesWithSplits(db, { limit: 120 });
  const ingestionLogs = await listRecentIngestionLogs(db, 20);
  const balanceSyncLogs = await listBalanceSyncLogs(db, 10);

  return {
    settings,
    budgetOverview,
    highRiskMode,
    walletTank,
    splitBills,
    cooldownCart,
    radar,
    entries,
    ingestionLogs,
    balanceSyncLogs
  };
}

module.exports = {
  buildDashboardState
};
