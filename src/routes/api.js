'use strict';

const { getDb } = require('../db/database');
const { getSurvivalDashboardMetrics, syncCycleWithShiftData } = require('../services/survivalEngine');
const { processBankNotification, resolveGasTempHoldManually, markTransactionCanceled, scanGhostHolds } = require('../services/reconciliationEngine');
const { getHighRiskModeStatus, evaluateImpulsePurchase, getCooldownCartSummary, fastForwardCooldownItem, resolveCooldownItem, getVampireAndSubscriptionRadar } = require('../services/impulseControlService');
const { splitTransactionBill, settleSplitBill, getSplitBillsSummary, getWalletTankStatus, quickAdjustWalletTank, auditWalletTank, syncEsunAvailableBalance, splitUnknownGapTransaction } = require('../services/accountingPatchService');
const { pollEsunEmailsViaImap } = require('../services/gmailImapService');

/**
 * 首次啟動時若交易表為空，寫入貼近真實生活的預設展示資料（亦可隨時一鍵清空重置）
 */
function ensureDemoTransactionsIfEmpty(db) {
  const txCount = db.prepare('SELECT COUNT(*) AS cnt FROM transactions').get().cnt;
  if (txCount > 0) return;

  const today = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const d0 = fmt(today);
  const d1 = fmt(new Date(today.getTime() - 1 * 86400000));
  const d2 = fmt(new Date(today.getTime() - 2 * 86400000));
  const d3 = fmt(new Date(today.getTime() - 3 * 86400000));
  const d4 = fmt(new Date(today.getTime() - 4 * 86400000));
  const d15 = fmt(new Date(today.getTime() - 15 * 86400000)); // 超過 14 天的幽靈圈存示範

  // 1. 超過 14 天未請款的幽靈圈存示範
  processBankNotification(db, `【玉山銀行】簽帳金融卡消費授權：${d15} 於「日本亞馬遜 AMAZON JP」刷卡 NT$890 元。`, {
    timestamp: `${d15}T14:20:00+08:00`, referenceDate: d0
  });

  // 2. 小額高頻消費 (觸發 7 天內 > 4 次低於 $200 隱形吸血鬼抓漏雷達)
  processBankNotification(db, `【玉山Wallet】簽帳金融卡消費授權：${d4} 於「連加*7-ELEVEN」消費 NT$10 元（麥香紅茶）。`, {
    timestamp: `${d4}T08:15:00+08:00`, referenceDate: d0
  });
  processBankNotification(db, `【玉山銀行】簽帳卡消費扣款：${d2} 商店請款「統一超商」（原交易日 ${d4}）實際扣款 NT$10 元。`, {
    timestamp: `${d2}T04:10:00+08:00`, referenceDate: d0
  });

  processBankNotification(db, `【玉山Wallet】簽帳金融卡消費授權：${d3} 於「連加*50嵐」消費 NT$65 元。`, {
    timestamp: `${d3}T15:10:00+08:00`, referenceDate: d0
  });
  processBankNotification(db, `【玉山Wallet】簽帳金融卡消費授權：${d2} 於「街口*全家便利商店」消費 NT$89 元。`, {
    timestamp: `${d2}T23:40:00+08:00`, referenceDate: d0
  });
  processBankNotification(db, `【玉山Wallet】簽帳金融卡消費授權：${d1} 於「連加*7-ELEVEN」消費 NT$10 元（麥香奶茶）。`, {
    timestamp: `${d1}T09:05:00+08:00`, referenceDate: d0
  });
  processBankNotification(db, `【玉山Wallet】簽帳金融卡消費授權：${d0} 於「連加*得正飲品」消費 NT$60 元。`, {
    timestamp: `${d0}T13:20:00+08:00`, referenceDate: d0
  });

  // 3. 中油 $1,500 加油站預授權白名單 (TEMP_HOLD)
  processBankNotification(db, `【玉山銀行】簽帳金融卡消費授權：${d1} 於「台灣中油」刷卡授權 NT$1,500 元。`, {
    timestamp: `${d1}T18:30:00+08:00`, referenceDate: d0
  });

  // 4. Steam 海外消費圈存 (等待通道 B 匯差 +1.5% 請款測試)
  processBankNotification(db, `【玉山銀行】簽帳金融卡消費授權：${d2} 於「STEAM GAMES」刷卡 NT$1,000 元。`, {
    timestamp: `${d2}T21:00:00+08:00`, referenceDate: d0
  });

  // 5. 72 小時冷靜池示範商品
  const cartCount = db.prepare('SELECT COUNT(*) AS cnt FROM cooldown_cart').get().cnt;
  if (cartCount === 0) {
    const item1 = evaluateImpulsePurchase(db, {
      itemName: '機械式鍵盤 RGB 特仕版',
      amount: 2400,
      reason: '限時特價而且發光超帥',
      itemType: 'WANT',
      addToCart: true
    });
    // 新增一筆已放棄購買的防剁手成就示範
    const item2 = evaluateImpulsePurchase(db, {
      itemName: '潮牌聯名連帽外套',
      amount: 1880,
      reason: '心情不好想犒賞自己',
      itemType: 'WANT',
      addToCart: true
    });
    if (item2.cooldownRecord) {
      resolveCooldownItem(db, item2.cooldownRecord.id, 'ABANDON');
    }
    void item1;
  }
}

function buildFullDashboardSnapshot(db) {
  const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
  const survival = getSurvivalDashboardMetrics(db);
  const highRiskMode = getHighRiskModeStatus(db);
  const ghostHolds = scanGhostHolds(db);
  const cooldownCart = getCooldownCartSummary(db);
  const radar = getVampireAndSubscriptionRadar(db);
  const splitBills = getSplitBillsSummary(db);
  const walletTank = getWalletTankStatus(db);

  const transactions = db.prepare(`
    SELECT t.*,
           s.id AS split_id, s.self_amount AS split_self_amount,
           s.receivable_amount AS split_receivable_amount, s.debtor_name AS split_debtor_name,
           s.is_repaid AS split_is_repaid
    FROM transactions t
    LEFT JOIN split_bills s ON s.transaction_id = t.id
    ORDER BY t.tx_date DESC, t.id DESC
    LIMIT 100
  `).all();

  const notificationLogs = db.prepare('SELECT * FROM notification_logs ORDER BY id DESC LIMIT 30').all();
  const balanceSyncLogs = db.prepare('SELECT * FROM balance_sync_logs ORDER BY id DESC LIMIT 10').all();

  return {
    settings: {
      ...settings,
      gmail_app_password: settings.gmail_app_password ? '********' : ''
    },
    survival,
    highRiskMode,
    ghostHolds,
    transactions,
    notificationLogs,
    cooldownCart,
    radar,
    splitBills,
    walletTank,
    balanceSyncLogs
  };
}
async function handleApiRequest(method, pathname, body = {}, searchParams, options = {}) {
  const db = options.db || getDb();

  if ((method === 'GET' || method === 'POST') && pathname === '/api/dashboard') {
    return { status: 200, data: { ok: true, ...buildFullDashboardSnapshot(db) } };
  }

  // 1. 玉山銀行通知解析 (手動貼上 / iOS 捷徑 Webhook)
  if (method === 'POST' && (pathname === '/api/notifications/parse' || pathname === '/api/notifications/webhook')) {
    const rawText = body.text || body.rawText || body.message || '';
    const source = pathname.endsWith('/webhook') ? (body.source || 'ios_shortcut_webhook') : (body.source || 'manual_ui');
    const result = processBankNotification(db, rawText, {
      source,
      timestamp: body.timestamp || new Date().toISOString(),
      referenceDate: body.referenceDate
    });
    return { status: 200, data: { ok: true, result, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 2. Gmail IMAP 主動收信測試
  if (method === 'POST' && pathname === '/api/notifications/gmail-poll') {
    const imapRes = await pollEsunEmailsViaImap(db);
    return { status: 200, data: { ok: true, imap: imapRes, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 3. 薪資設定與唯讀跨專案班表同步 (支援直接輸入實領薪資/總薪資/時薪，或貼上 shiftpay-v2 JSON)
  if (method === 'POST' && pathname === '/api/shift/sync') {
    const cycle = syncCycleWithShiftData(db, {
      rawJsonPayload: body.rawJsonPayload || null,
      manualNetSalary: body.manualNetSalary,
      manualGrossPay: body.manualGrossPay,
      manualHourlyWage: body.manualHourlyWage,
      referenceDateStr: body.referenceDate || null
    });
    const effective = cycle.is_salary_settled && cycle.actual_salary !== null ? cycle.actual_salary : cycle.estimated_net_pay;
    return {
      status: 200,
      data: {
        ok: true,
        message: `✅ 已更新本月薪資設定！目前可用薪資預算 $${effective.toLocaleString()}（時薪 $${cycle.hourly_wage}）`,
        cycle,
        dashboard: buildFullDashboardSnapshot(db)
      }
    };
  }

  // 4. 加油站預授權手動填入實際加油金額
  if (method === 'POST' && pathname === '/api/transactions/gas-resolve') {
    const tx = resolveGasTempHoldManually(db, body.txId, body.actualAmount);
    return { status: 200, data: { ok: true, transaction: tx, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 5. 手動標記退單待解圈 (移入凍結觀察區)
  if (method === 'POST' && pathname === '/api/transactions/cancel') {
    const tx = markTransactionCanceled(db, body.txId, body.reason);
    return { status: 200, data: { ok: true, transaction: tx, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 6. 朋友聚餐一鍵拆帳 / 代墊沖銷
  if (method === 'POST' && pathname === '/api/transactions/split') {
    const res = splitTransactionBill(db, {
      transactionId: body.transactionId,
      selfAmount: body.selfAmount,
      debtorName: body.debtorName
    });
    return { status: 200, data: { ok: true, ...res, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/split-bills/settle') {
    const res = settleSplitBill(db, body.splitBillId);
    return { status: 200, data: { ok: true, splitBill: res, dashboard: buildFullDashboardSnapshot(db) } };
  }
  // 7. 衝動消費守門員評估 + 72 小時冷靜池操作
  if (method === 'POST' && pathname === '/api/impulse/evaluate') {
    const evaluation = evaluateImpulsePurchase(db, body);
    return { status: 200, data: { ok: true, evaluation, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/cooldown/fast-forward') {
    const item = fastForwardCooldownItem(db, body.itemId);
    return { status: 200, data: { ok: true, item, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/cooldown/resolve') {
    const res = resolveCooldownItem(db, body.itemId, body.decision);
    return { status: 200, data: { ok: true, ...res, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 8. 固定開銷、訂閱與分期付款管理
  if (method === 'POST' && pathname === '/api/fixed-expenses') {
    const nowIso = new Date().toISOString();
    const type = ['FIXED', 'SUBSCRIPTION', 'INSTALLMENT'].includes(body.expenseType) ? body.expenseType : 'FIXED';
    db.prepare(`
      INSERT INTO fixed_expenses (name, expense_type, monthly_amount, billing_day, total_installments, remaining_installments, note, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      String(body.name || '新增固定開銷').trim(),
      type,
      Math.max(1, Math.round(Number(body.monthlyAmount) || 0)),
      Math.min(31, Math.max(1, Math.round(Number(body.billingDay) || 15))),
      type === 'INSTALLMENT' ? Math.max(1, Math.round(Number(body.totalInstallments) || 6)) : null,
      type === 'INSTALLMENT' ? Math.max(1, Math.round(Number(body.remainingInstallments) || 6)) : null,
      String(body.note || '').trim(),
      nowIso
    );
    return { status: 200, data: { ok: true, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/fixed-expenses/delete') {
    db.prepare('DELETE FROM fixed_expenses WHERE id = ?').run(Number(body.id));
    return { status: 200, data: { ok: true, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 9. 悠遊卡自動加值 / 領現金黑洞追蹤水庫 (Wallet Tank)
  if (method === 'POST' && pathname === '/api/wallet-tank/adjust') {
    const tank = quickAdjustWalletTank(db, body);
    return { status: 200, data: { ok: true, walletTank: tank, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/wallet-tank/audit') {
    const tank = auditWalletTank(db, body);
    return { status: 200, data: { ok: true, walletTank: tank, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 10. 玉山可用餘額一鍵校正 & 未知漏帳黑洞拆分
  if (method === 'POST' && pathname === '/api/balance/sync') {
    const syncRes = syncEsunAvailableBalance(db, body);
    return { status: 200, data: { ok: true, syncResult: syncRes, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/balance/split-gap') {
    const res = splitUnknownGapTransaction(db, body.gapTxId, body.items);
    return { status: 200, data: { ok: true, ...res, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 11. 系統與生存週期設定更新
  if (method === 'POST' && pathname === '/api/settings') {
    const cur = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
    const paydayDay = body.paydayDay !== undefined ? Math.min(28, Math.max(1, Number(body.paydayDay))) : cur.payday_day;
    const netPayFactor = body.netPayFactor !== undefined ? Math.min(1, Math.max(0.5, Number(body.netPayFactor))) : cur.net_pay_factor;
    const laborHealthDeduction = body.laborHealthDeduction !== undefined ? Math.max(0, Math.round(Number(body.laborHealthDeduction))) : cur.labor_health_deduction;
    const shiftAppPath = body.shiftAppPath !== undefined ? String(body.shiftAppPath).trim() : cur.shift_app_path;
    const forceHighRiskMode = body.forceHighRiskMode !== undefined ? (body.forceHighRiskMode ? 1 : 0) : cur.force_high_risk_mode;
    const gmailUser = body.gmailUser !== undefined ? String(body.gmailUser).trim() : cur.gmail_user;
    const gmailPass = (body.gmailAppPassword && body.gmailAppPassword !== '********') ? String(body.gmailAppPassword).trim() : cur.gmail_app_password;
    const nowIso = new Date().toISOString();

    db.prepare(`
      UPDATE user_settings
      SET payday_day = ?, net_pay_factor = ?, labor_health_deduction = ?,
          shift_app_path = ?, force_high_risk_mode = ?, gmail_user = ?, gmail_app_password = ?, updated_at = ?
      WHERE id = 1
    `).run(paydayDay, netPayFactor, laborHealthDeduction, shiftAppPath, forceHighRiskMode, gmailUser, gmailPass, nowIso);

    syncCycleWithShiftData(db, { recalculateOnly: true });
    return { status: 200, data: { ok: true, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 12. 展示資料重置 / 清空帳本（完全歸零）
  if (method === 'POST' && pathname === '/api/demo/reset') {
    db.exec(`
      DELETE FROM split_bills;
      DELETE FROM transactions;
      DELETE FROM notification_logs;
      DELETE FROM cooldown_cart;
      DELETE FROM wallet_tank_logs;
      DELETE FROM balance_sync_logs;
      DELETE FROM income_cycles;
      DELETE FROM fixed_expenses;
    `);
    const nowIso = new Date().toISOString();
    db.prepare('UPDATE wallet_tank SET easycard_balance = 0, cash_balance = 0, last_audit_at = ?, updated_at = ? WHERE id = 1').run(nowIso, nowIso);
    db.prepare('UPDATE user_settings SET last_known_bank_balance = 0, updated_at = ? WHERE id = 1').run(nowIso);

    if (body.withDemoData === true) {
      ensureDemoTransactionsIfEmpty(db);
    }
    return { status: 200, data: { ok: true, dashboard: buildFullDashboardSnapshot(db) } };
  }

  return { status: 404, data: { ok: false, error: `Unknown endpoint: ${method} ${pathname}` } };
}

module.exports = {
  handleApiRequest,
  ensureDemoTransactionsIfEmpty,
  buildFullDashboardSnapshot
};


