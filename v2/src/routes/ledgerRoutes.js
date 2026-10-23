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

function extractApplePayPayload(body = {}) {
  const rawText = String(body.raw_text || body.rawText || body.text || body.message || '').trim();
  let merchant = String(
    body.merchant || body.store || body.shop || body.name ||
    body.商家 || body.商店 || body.名稱 || ''
  ).trim();
  let amount = body.amount ?? body.money ?? body.price ?? body.金額 ?? null;
  const cardName = String(
    body.card_name || body.cardName || body.card || body.pass ||
    body.卡片 || body.票卡 || 'Apple Pay'
  ).trim();

  if ((!merchant || amount === null) && rawText) {
    const mMatch = rawText.match(/[「『]([^」』]+)[」』]/);
    if (!merchant && mMatch) merchant = mMatch[1].trim();
    const aMatch = rawText.match(/(?:NT\$|TWD|\$)\s*([0-9,]+(?:\.[0-9]+)?)|([0-9,]+)\s*元/i);
    if (amount === null && aMatch) amount = aMatch[1] || aMatch[2];
  }

  return {
    source: 'apple_pay',
    amount: amount ?? 0,
    merchant: merchant || '未知商店',
    card_name: cardName || 'Apple Pay',
    timestamp: body.timestamp || new Date().toISOString(),
    referenceDate: body.referenceDate || undefined
  };
}

function isApplePayWebhookPayload(body = {}) {
  const src = String(body.source || '').trim().toLowerCase();
  if (src === 'apple_pay' || src === 'apple_pay_auto') return true;

  const hasRawText = Boolean(String(body.raw_text || body.rawText || body.text || body.message || '').trim());
  const hasMerchantField = Boolean(
    body.merchant || body.store || body.shop || body.商家 || body.商店 || body.票卡 || body.card_name || body.cardName || body.pass
  );
  const hasAmountField = (body.amount ?? body.money ?? body.price ?? body.金額) !== undefined;

  if (!hasRawText && hasMerchantField && hasAmountField) {
    return true;
  }

  const rawText = String(body.raw_text || body.rawText || body.text || body.message || '');
  return /APPLE\s*PAY|APPLE\s*錢包|APPLE\s*WALLET|感應刷卡|錢包票卡/i.test(rawText);
}

async function handleLedgerRoutes(db, method, pathname, body) {
  if (
    (method === 'POST' || method === 'GET') &&
    (pathname === '/api/webhook/apple-pay' ||
     pathname === '/api/notifications/apple-pay' ||
     pathname === '/api/transactions/apple-pay')
  ) {
    const result = await ingestApplePayTransaction(db, extractApplePayPayload(body));
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

  if (
    (method === 'POST' || method === 'GET') &&
    (pathname === '/api/webhook/transfer-ocr' ||
     pathname === '/api/webhook/transfer' ||
     pathname === '/api/notifications/webhook' ||
     pathname === '/api/notifications/parse' ||
     pathname === '/api/transactions/transfer')
  ) {
    if (isApplePayWebhookPayload(body)) {
      const result = await ingestApplePayTransaction(db, extractApplePayPayload(body));
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
