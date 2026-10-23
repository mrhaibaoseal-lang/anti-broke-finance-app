'use strict';

const {
  ingestApplePayTransaction,
  ingestTransferOrOcr,
  resolveSuspectedDuplicateEntry
} = require('../services/ingestionService');
const {
  recordCashExpense,
  recordAtmDepositToCard,
  deleteAndRollbackLedgerEntry,
  updateAndReconcileLedgerEntry
} = require('../services/splitAndTankService');
const { buildDashboardState } = require('./dashboardRoutes');

async function handleLedgerRoutes(db, method, pathname, body) {
  // 1. Apple Pay 原生捷徑入帳端點
  if ((method === 'POST' || method === 'GET') && (pathname === '/api/webhook/apple-pay' || pathname === '/api/notifications/apple-pay' || pathname === '/api/transactions/apple-pay')) {
    const result = await ingestApplePayTransaction(db, body);
    const dashboard = await buildDashboardState(db);
    return {
      status: 200,
      data: {
        ok: true,
        result,
        dailySafeBudget: dashboard.budgetOverview.metrics.dailySafeBudget,
        dashboard
      }
    };
  }

  // 2. 轉帳/收帳截圖 OCR 與通用 Webhook 端點
  if (method === 'POST' && (pathname === '/api/webhook/transfer-ocr' || pathname === '/api/webhook/transfer' || pathname === '/api/notifications/webhook')) {
    const src = String(body.source || '').trim().toLowerCase();
    if (src === 'apple_pay' || src === 'apple_pay_auto') {
      const result = await ingestApplePayTransaction(db, body);
      const dashboard = await buildDashboardState(db);
      return {
        status: 200,
        data: {
          ok: true,
          result,
          dailySafeBudget: dashboard.budgetOverview.metrics.dailySafeBudget,
          dashboard
        }
      };
    }

    const result = await ingestTransferOrOcr(db, body);
    const dashboard = await buildDashboardState(db);
    return {
      status: 200,
      data: {
        ok: true,
        result,
        dailySafeBudget: dashboard.budgetOverview.metrics.dailySafeBudget,
        dashboard
      }
    };
  }

  // 3. 皮包現金消費快速記帳
  if (method === 'POST' && pathname === '/api/cash/spend') {
    const res = await recordCashExpense(db, {
      itemName: body.itemName,
      amount: body.amount,
      category: body.category,
      deductDigitalBudgetToo: Boolean(body.countInBudget || body.deductDigitalBudgetToo)
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

  // 4. 拿現金去 ATM 存入金融卡 (可隨時反悔撤銷與改金額)
  if (method === 'POST' && pathname === '/api/deposits/add') {
    const res = await recordAtmDepositToCard(db, {
      amount: body.amount,
      merchant: body.merchant || '玉山 ATM 存款',
      deductFromWalletCash: body.deductFromWalletCash !== false
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

  // 5. 疑似重複項目人工確認或刪除
  if (method === 'POST' && pathname === '/api/ledger/resolve-duplicate') {
    const res = await resolveSuspectedDuplicateEntry(db, body.entryId, body.decision);
    return {
      status: 200,
      data: {
        ok: true,
        ...res,
        dashboard: await buildDashboardState(db)
      }
    };
  }

  // 6. ✏️ 隨時編輯修改任何一筆明細或 ATM 存款 (100% 自動先回滾舊值再套用新值)
  if ((method === 'POST' || method === 'PUT') && (pathname === '/api/ledger/update' || pathname === '/api/transactions/update')) {
    const res = await updateAndReconcileLedgerEntry(db, body.entryId || body.txId || body.id, body);
    return {
      status: 200,
      data: {
        ok: true,
        ...res,
        message: '✅ 紀錄已更新，數位預算與實體水庫已同步重算！',
        dashboard: await buildDashboardState(db)
      }
    };
  }

  // 7. ↩️ 反悔撤銷 / 刪除任何一筆明細或 ATM 存款 (100% 原子化雙向回滾水庫與代墊池)
  if ((method === 'POST' || method === 'DELETE') && (pathname === '/api/ledger/delete' || pathname === '/api/transactions/delete')) {
    const res = await deleteAndRollbackLedgerEntry(db, body.entryId || body.txId || body.id);
    return {
      status: 200,
      data: {
        ok: true,
        ...res,
        message: '↩️ 已成功撤銷刪除該筆紀錄，相關預算與水庫餘額已完整回滾復原！',
        dashboard: await buildDashboardState(db)
      }
    };
  }

  return null;
}

module.exports = {
  handleLedgerRoutes
};
