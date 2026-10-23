'use strict';

const { buildDashboardState } = require('./dashboardRoutes');
const { handleLedgerRoutes } = require('./ledgerRoutes');
const { handleBudgetRoutes } = require('./budgetRoutes');
const { handleWalletRoutes } = require('./walletRoutes');
const { handleImpulseRoutes } = require('./impulseRoutes');
const { setMonthlyBaseBudget } = require('../services/budgetEngine');
const { ingestApplePayTransaction, ingestTransferOrOcr } = require('../services/ingestionService');
const { recordAtmDepositToCard, quickAdjustWalletTank, splitLedgerEntryBill } = require('../services/splitAndTankService');
const { evaluateImpulsePurchase, resolveCooldownItem } = require('../services/impulseService');
const { insertFixedExpense } = require('../repositories/impulseRepo');

async function seedDemoData(db) {
  await setMonthlyBaseBudget(db, {
    baseBudget: 20000,
    budgetNote: '範例起始預算 ($20,000)'
  });

  await quickAdjustWalletTank(db, { tankType: 'CASH', deltaAmount: 1500, note: '範例初始皮包現金' });
  await quickAdjustWalletTank(db, { tankType: 'EASYCARD', deltaAmount: 350, note: '範例初始悠遊卡餘額' });

  await insertFixedExpense(db, { name: 'Netflix 訂閱', expenseType: 'SUBSCRIPTION', monthlyAmount: 390, billingDay: 25 });
  await insertFixedExpense(db, { name: '手機電信費', expenseType: 'FIXED', monthlyAmount: 599, billingDay: 15 });

  await ingestApplePayTransaction(db, { amount: 65, merchant: '50嵐', card_name: '玉山 Unicard' });
  await ingestApplePayTransaction(db, { amount: 155, merchant: '星巴克', card_name: '玉山簽帳金融卡' });

  const dinnerRes = await ingestApplePayTransaction(db, { amount: 1200, merchant: '燒肉聚餐', card_name: '玉山 Unicard' });
  if (dinnerRes.entry) {
    await splitLedgerEntryBill(db, {
      entryId: dinnerRes.entry.id,
      selfAmount: 400,
      debtorName: '阿明、小華'
    });
  }

  await ingestTransferOrOcr(db, {
    raw_text: '【玉山銀行】轉帳成功：轉出金額 NT$450 元，備註：房租水電分攤',
    direction: 'OUT',
    flowType: 'EXPENSE'
  });

  await recordAtmDepositToCard(db, {
    amount: 500,
    merchant: '玉山 ATM 存款',
    deductFromWalletCash: true
  });

  const imp1 = await evaluateImpulsePurchase(db, {
    itemName: '機械式鍵盤 RGB 特仕版',
    amount: 2400,
    reason: '限時特價而且發光超帥',
    itemType: 'WANT',
    addToCart: true
  });
  void imp1;

  const imp2 = await evaluateImpulsePurchase(db, {
    itemName: '潮牌聯名連帽外套',
    amount: 1880,
    reason: '工作累想犒賞自己',
    itemType: 'WANT',
    addToCart: true
  });
  if (imp2.cooldownRecord) {
    await resolveCooldownItem(db, imp2.cooldownRecord.id, 'ABANDON');
  }
}

async function clearAllDatabaseTables(db) {
  await db.execScript(`
    DELETE FROM split_bills;
    DELETE FROM ledger_entries;
    DELETE FROM ingestion_logs;
    DELETE FROM cooldown_cart;
    DELETE FROM wallet_tank_logs;
    DELETE FROM balance_sync_logs;
    DELETE FROM budget_cycles;
    DELETE FROM fixed_expenses;
  `);
  const nowIso = new Date().toISOString();
  await db.execute('UPDATE wallet_tank SET cash_balance = 0, easycard_balance = 0, last_audit_at = ?, updated_at = ? WHERE id = 1', [nowIso, nowIso]);
  await db.execute('UPDATE user_settings SET last_known_bank_balance = 0, updated_at = ? WHERE id = 1', [nowIso]);
}

async function handleApiRequest(db, method, pathname, body = {}, searchParams = null) {
  const m = String(method || 'GET').toUpperCase();

  // Query param fallback for GET webhook calls
  const mergedBody = { ...(body || {}) };
  if (searchParams && typeof searchParams.entries === 'function') {
    for (const [k, v] of searchParams.entries()) {
      if (mergedBody[k] === undefined) mergedBody[k] = v;
    }
  }

  if ((m === 'GET' || m === 'POST') && pathname === '/api/dashboard') {
    const dashboard = await buildDashboardState(db);
    return { status: 200, data: { ok: true, ...dashboard } };
  }

  if (m === 'POST' && pathname === '/api/demo/reset') {
    await clearAllDatabaseTables(db);
    if (mergedBody.withDemoData === true) {
      await seedDemoData(db);
    }
    return {
      status: 200,
      data: {
        ok: true,
        message: mergedBody.withDemoData ? '✅ 已載入 GuardPay v2 範例資料' : '🧹 帳本已完全清空歸零',
        dashboard: await buildDashboardState(db)
      }
    };
  }

  for (const handler of [handleLedgerRoutes, handleBudgetRoutes, handleWalletRoutes, handleImpulseRoutes]) {
    const res = await handler(db, m, pathname, mergedBody);
    if (res) return res;
  }

  return {
    status: 404,
    data: { ok: false, error: `找不到 API 端點: ${m} ${pathname}` }
  };
}

module.exports = {
  handleApiRequest,
  clearAllDatabaseTables,
  seedDemoData
};
