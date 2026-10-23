'use strict';

const {
  quickAdjustWalletTank,
  auditWalletTankBalances,
  splitLedgerEntryBill,
  settleSplitBillManually,
  syncEsunAvailableBalance,
  splitUnknownGapEntry
} = require('../services/splitAndTankService');
const { buildDashboardState } = require('./dashboardRoutes');

async function handleWalletRoutes(db, method, pathname, body) {
  // 1. 實體水庫 (皮包現金 / 悠遊卡) 加減調整
  if (method === 'POST' && (pathname === '/api/wallet/adjust' || pathname === '/api/wallet-tank/adjust')) {
    const walletTank = await quickAdjustWalletTank(db, {
      tankType: body.tankType,
      deltaAmount: body.deltaAmount,
      note: body.note
    });
    return {
      status: 200,
      data: {
        ok: true,
        walletTank,
        dashboard: await buildDashboardState(db)
      }
    };
  }

  // 2. 實體水庫盤點校正
  if (method === 'POST' && (pathname === '/api/wallet/audit' || pathname === '/api/wallet-tank/audit')) {
    const walletTank = await auditWalletTankBalances(db, {
      cashBalance: body.cashBalance,
      easycardBalance: body.easycardBalance
    });
    return {
      status: 200,
      data: {
        ok: true,
        walletTank,
        dashboard: await buildDashboardState(db)
      }
    };
  }

  // 3. 朋友聚餐一鍵拆帳 & 應收代墊結清
  if (method === 'POST' && (pathname === '/api/splits/create' || pathname === '/api/transactions/split')) {
    const res = await splitLedgerEntryBill(db, {
      entryId: body.entryId || body.transactionId,
      selfAmount: body.selfAmount,
      debtorName: body.debtorName
    });
    return {
      status: 200,
      data: {
        ok: true,
        ...res,
        dashboard: await buildDashboardState(db)
      }
    };
  }

  if (method === 'POST' && (pathname === '/api/splits/settle' || pathname === '/api/split-bills/settle')) {
    const splitBill = await settleSplitBillManually(db, body.splitBillId);
    return {
      status: 200,
      data: {
        ok: true,
        splitBill,
        dashboard: await buildDashboardState(db)
      }
    };
  }

  // 4. 玉山可用餘額一鍵校正 & 未知漏帳黑洞拆分
  if (method === 'POST' && pathname === '/api/balance/sync') {
    const syncResult = await syncEsunAvailableBalance(db, {
      actualBankBalance: body.actualBankBalance ?? body.actualEsunBalance
    });
    return {
      status: 200,
      data: {
        ok: true,
        syncResult,
        dashboard: await buildDashboardState(db)
      }
    };
  }

  if (method === 'POST' && pathname === '/api/balance/split-gap') {
    const res = await splitUnknownGapEntry(db, body.gapEntryId || body.gapTxId, body.items);
    return {
      status: 200,
      data: {
        ok: true,
        ...res,
        dashboard: await buildDashboardState(db)
      }
    };
  }

  return null;
}

module.exports = {
  handleWalletRoutes
};
