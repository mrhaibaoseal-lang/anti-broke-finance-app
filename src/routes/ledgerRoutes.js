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
  const titleStr = String(body.title || body.標題 || '').trim();
  const bodyStr = String(body.body || body.內文 || body.content || '').trim();
  const combinedNotif = (titleStr || bodyStr) ? `${titleStr} ${bodyStr}`.trim() : '';

  const rawText = String(
    body.raw_text || body.rawText || body.text || body.message || body.notification || body.input || body.t || body.q || combinedNotif || ''
  ).trim();

  let merchant = String(
    body.merchant || body.store || body.shop || body.name ||
    body.商家 || body.商店 || body.名稱 || body.m || ''
  ).trim();
  let amount = body.amount ?? body.money ?? body.price ?? body.金額 ?? body.a ?? null;
  let cardName = String(
    body.card_name || body.cardName || body.card || body.pass ||
    body.卡片 || body.票卡 || body.c || ''
  ).trim();

  // 支援極簡速記格式，例如 ?q=155_星巴克 或 ?t=星巴克 155
  if (amount === null && !merchant && rawText) {
    const quickPair = rawText.match(/^\$?\s*([0-9,]+(?:\.[0-9]+)?)\s*[_,，\s/｜|-]+\s*(.+)$/) ||
                      rawText.match(/^(.+?)\s*[_,，\s/｜|-]+\s*\$?\s*([0-9,]+(?:\.[0-9]+)?)\s*元?$/);
    if (quickPair) {
      if (/^[0-9,]+(?:\.[0-9]+)?$/.test(quickPair[1])) {
        amount = quickPair[1];
        merchant = quickPair[2].trim();
      } else {
        merchant = quickPair[1].trim();
        amount = quickPair[2];
      }
    }
  }

  // 相容圖 2「當我收到來自 錢包 的通知時」({ title, body } 或純文字通知)
  if (titleStr && !cardName && /玉山|簽帳|金融卡|信用卡|銀行|卡|Pay|Wallet/i.test(titleStr)) {
    cardName = titleStr;
  } else if (titleStr && !merchant) {
    merchant = titleStr;
  }

  if (amount === null && rawText) {
    const aMatch = rawText.match(/(?:NT\$|TWD|新[台臺]幣|\$)\s*([0-9,]+(?:\.[0-9]+)?)|([0-9,]+(?:\.[0-9]+)?)\s*元/i) ||
                   rawText.match(/\b([0-9]{1,6})\b/);
    if (aMatch) amount = aMatch[1] || aMatch[2];
  }

  if (!merchant && rawText) {
    const quoteMatch = rawText.match(/[「『]([^」』]+)[」』]/);
    if (quoteMatch) {
      merchant = quoteMatch[1].trim();
    } else {
      // 從錢包通知內文提取商店名稱 (例如 "星巴克 NT$155" 或 "於 7-ELEVEN 消費 $65")
      const cleanedForMerchant = rawText
        .replace(/(?:NT\$|TWD|新[台臺]幣|\$)\s*[0-9,]+(?:\.[0-9]+)?\s*元?/gi, ' ')
        .replace(/[0-9,]+(?:\.[0-9]+)?\s*元/g, ' ')
        .replace(/\b[0-9]{1,6}\b/g, ' ')
        .replace(/玉山[^\s，,。•·]*卡?/g, ' ')
        .replace(/Apple\s*Pay|感應刷卡|一般消費|消費通知|錢包/gi, ' ')
        .replace(/[•·｜|\-\n\r_]+/g, ' ')
        .trim();
      if (cleanedForMerchant) {
        merchant = cleanedForMerchant.split(/\s+/)[0].slice(0, 24);
      }
    }
  }

  return {
    source: 'apple_pay',
    amount: amount ?? 0,
    merchant: merchant || 'Apple Pay 消費',
    card_name: cardName || 'Apple Pay',
    timestamp: body.timestamp || new Date().toISOString(),
    referenceDate: body.referenceDate || undefined
  };
}

function isApplePayWebhookPayload(body = {}) {
  const src = String(body.source || '').trim().toLowerCase();
  if (src === 'apple_pay' || src === 'apple_pay_auto') return true;

  if (body.a !== undefined || body.m !== undefined || body.c !== undefined) return true;

  const hasRawText = Boolean(String(body.raw_text || body.rawText || body.text || body.message || body.t || body.q || '').trim());
  const hasMerchantField = Boolean(
    body.merchant || body.store || body.shop || body.商家 || body.商店 || body.票卡 || body.card_name || body.cardName || body.pass
  );
  const hasAmountField = (body.amount ?? body.money ?? body.price ?? body.金額) !== undefined;

  if (!hasRawText && hasMerchantField && hasAmountField) {
    return true;
  }

  const rawText = String(body.raw_text || body.rawText || body.text || body.message || body.t || body.q || '');
  if (/轉帳|轉出|轉入|帳號|餘額|手續費|ATM|提款|存款/i.test(rawText)) {
    return false;
  }
  return /APPLE\s*PAY|APPLE\s*錢包|APPLE\s*WALLET|感應刷卡|錢包票卡/i.test(rawText) ||
         Boolean(rawText && rawText.length <= 45 && /\d/.test(rawText));
}

async function handleLedgerRoutes(db, method, pathname, body) {
  // 0. 萬能極簡零設定端點 /api/q (支援 GET ?a=155&m=星巴克 或 ?t=任意文字，也支援 POST 純文字)
  if ((method === 'POST' || method === 'GET') && (pathname === '/api/q' || pathname === '/api/quick')) {
    const normalizedBody = {
      ...body,
      raw_text: body.raw_text || body.rawText || body.text || body.t || body.q || ''
    };
    const result = isApplePayWebhookPayload(normalizedBody)
      ? await ingestApplePayTransaction(db, extractApplePayPayload(normalizedBody))
      : await ingestTransferOrOcr(db, normalizedBody);
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
