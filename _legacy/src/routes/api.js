'use strict';

const { getDb } = require('../db/database');
const { getSurvivalDashboardMetrics, syncCycleWithShiftData } = require('../services/survivalEngine');
const { processApplePayTransaction, processBankNotification, resolveGasTempHoldManually, markTransactionCanceled, scanGhostHolds } = require('../services/reconciliationEngine');
const { getHighRiskModeStatus, evaluateImpulsePurchase, getCooldownCartSummary, fastForwardCooldownItem, resolveCooldownItem, getVampireAndSubscriptionRadar } = require('../services/impulseControlService');
const { splitTransactionBill, settleSplitBill, getSplitBillsSummary, getWalletTankStatus, quickAdjustWalletTank, auditWalletTank, syncEsunAvailableBalance, splitUnknownGapTransaction, recordCashTransaction, recordManualAtmDeposit, deleteTransactionRecord } = require('../services/accountingPatchService');
const { pollEsunEmailsViaImap, decodeEmailMimeToText, buildGoogleAppsScriptCode } = require('../services/gmailImapService');

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

  // 0. 領現金後去 ATM 存入金融卡示範 (DEPOSIT 存款紀錄)
  processBankNotification(db, `【玉山銀行】存款通知：您的玉山帳戶於 ${d4} 12:10 於 ATM 現金存入 NT$15,000 元，可用餘額 NT$15,000 元。`, {
    timestamp: `${d4}T12:10:00+08:00`, referenceDate: d0
  });

  // 1. Apple Pay 原生捷徑消費示範（直接為 SETTLED 已確認交易）
  processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 10,
    merchant: '7-ELEVEN',
    card_name: '玉山簽帳金融卡',
    timestamp: `${d4}T08:15:00+08:00`,
    referenceDate: d4
  });
  processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 65,
    merchant: '50嵐',
    card_name: '玉山簽帳金融卡',
    timestamp: `${d3}T15:10:00+08:00`,
    referenceDate: d3
  });
  processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 89,
    merchant: '全家便利商店',
    card_name: '玉山簽帳金融卡',
    timestamp: `${d2}T23:40:00+08:00`,
    referenceDate: d2
  });
  processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 10,
    merchant: '7-ELEVEN',
    card_name: '玉山簽帳金融卡',
    timestamp: `${d1}T09:05:00+08:00`,
    referenceDate: d1
  });
  processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 60,
    merchant: '得正飲品',
    card_name: '玉山簽帳金融卡',
    timestamp: `${d0}T13:20:00+08:00`,
    referenceDate: d0
  });
  processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 155,
    merchant: '星巴克',
    card_name: '玉山 Unicard',
    timestamp: `${d0}T15:00:00+08:00`,
    referenceDate: d0
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
    automation: {
      gmailAutoPollEnabled: Boolean(settings.gmail_user && settings.gmail_app_password),
      shiftSyncSource: survival.cycle.shiftSyncSource,
      lastShiftSyncedAt: survival.cycle.lastSyncedAt,
      gasScriptCode: buildGoogleAppsScriptCode()
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

function extractAnyBodyText(body = {}, searchParams = null) {
  const getParam = key => (searchParams && typeof searchParams.get === 'function') ? searchParams.get(key) : null;

  // 優先處理新版 iOS 捷徑「當收到 App 通知時」自動生成的 { title: [標題], body: [內文] } 結構
  if (body && typeof body === 'object' && (body.title !== undefined && body.body !== undefined)) {
    const t = String(body.title || '').trim();
    const b = String(body.body || '').trim();
    if (t && b) return `【${t}】${b}`;
    return b || t;
  }

  let directText = body.raw_text || body.rawText || body.text || body.message || body.notification || body.body || body.input || body.content || body.transaction || body[''] || getParam('raw_text') || getParam('text') || getParam('message') || getParam('input') || '';

  if (!directText && body && typeof body === 'object') {
    const extraVals = Object.entries(body)
      .filter(([k, v]) => !['_clientState', 'source', 'timestamp', 'referenceDate', 'emailUid', 'category', 'categoryTag', 'direction', 'card_name', 'cardName'].includes(k) && (typeof v === 'string' || typeof v === 'number'))
      .map(([, v]) => String(v).trim())
      .filter(Boolean);
    if (extraVals.length > 0) {
      directText = extraVals.join(' ');
    }
  }

  if (typeof directText === 'string' && /%[0-9A-Fa-f]{2}/.test(directText)) {
    try {
      directText = decodeURIComponent(directText.replace(/\+/g, ' '));
    } catch (_) {}
  }
  return String(directText || '').trim();
}

function extractApplePayPayload(body = {}, searchParams = null) {
  const getParam = key => (searchParams && typeof searchParams.get === 'function') ? searchParams.get(key) : null;
  const merchant = String(body.merchant || body.store || body.shop || body.name || body.商家 || body.商店 || body.名稱 || getParam('merchant') || getParam('store') || getParam('name') || '未知商店').trim();
  const amount = body.amount ?? body.money ?? body.price ?? body.金額 ?? getParam('amount') ?? getParam('price') ?? 0;
  const cardName = String(body.card_name || body.cardName || body.card || body.pass || body.卡片 || body.票卡 || getParam('card_name') || getParam('card') || 'Apple Pay').trim();
  const timestamp = body.timestamp || getParam('timestamp') || new Date().toISOString();

  return {
    source: 'apple_pay',
    amount,
    merchant,
    card_name: cardName,
    timestamp,
    referenceDate: body.referenceDate || getParam('referenceDate') || undefined
  };
}

let lastDashboardImapPollMs = 0;

async function handleApiRequest(method, pathname, body = {}, searchParams, options = {}) {
  const db = options.db || getDb();

  if ((method === 'GET' || method === 'POST') && pathname === '/api/dashboard') {
    if (body && body.autoShiftState) {
      try {
        syncCycleWithShiftData(db, { rawJsonPayload: body.autoShiftState, isAutoSync: true });
      } catch (_) {}
    }
    // 若已綁定 Gmail 帳號與 16 碼密碼，前端輪詢 Dashboard 時每 45 秒自動背景掃描一次信箱
    const s = db.prepare('SELECT gmail_user, gmail_app_password FROM user_settings WHERE id = 1').get();
    if (s && s.gmail_user && s.gmail_app_password && (Date.now() - lastDashboardImapPollMs > 45000)) {
      lastDashboardImapPollMs = Date.now();
      try {
        await pollEsunEmailsViaImap(db);
      } catch (_) {}
    }
    return { status: 200, data: { ok: true, ...buildFullDashboardSnapshot(db) } };
  }

  // 1A. 【步驟 2：Apple Pay 專用接收端點】直接寫入 SETTLED 並更新當日安全額度
  if ((method === 'GET' || method === 'POST') && (pathname === '/api/notifications/apple-pay' || pathname === '/api/transactions/apple-pay')) {
    const applePayload = extractApplePayPayload(body, searchParams);
    const result = processApplePayTransaction(db, applePayload, {
      timestamp: applePayload.timestamp,
      referenceDate: applePayload.referenceDate
    });
    const dashboard = buildFullDashboardSnapshot(db);
    return {
      status: 200,
      data: {
        ok: true,
        result,
        dailySafeBudget: dashboard.survival?.budget?.dailySafeBudget ?? 0,
        dashboard
      }
    };
  }

  // 1B. 【Webhook 主接收端】支援：
  //  - Apple Pay 乾淨 JSON ({ source: "apple_pay", amount, merchant, card_name, timestamp })
  //  - 轉帳／收帳螢幕 OCR 文字 ({ raw_text, category: "EXPENSE" | "ADVANCE" | "TRANSFER" }) 與銀行轉帳/存款通知
  //  - 自動攔截並忽略所有含「簽帳、消費、授權、卡號」等字眼的銀行刷卡通知
  if ((method === 'GET' || method === 'POST') && (pathname === '/api/notifications/parse' || pathname === '/api/notifications/webhook' || pathname === '/api/notifications/batch' || pathname === '/api/transactions/transfer')) {
    const getParam = key => (searchParams && typeof searchParams.get === 'function') ? searchParams.get(key) : null;
    const reqSource = String(body.source || getParam('source') || (
      pathname.endsWith('/webhook') ? 'auto_webhook' : (pathname.endsWith('/batch') ? 'auto_batch_webhook' : 'manual_ui')
    )).trim();

    if (reqSource === 'apple_pay' || reqSource === 'apple_pay_auto') {
      const applePayload = extractApplePayPayload(body, searchParams);
      const result = processApplePayTransaction(db, applePayload, {
        timestamp: applePayload.timestamp,
        referenceDate: applePayload.referenceDate
      });
      const dashboard = buildFullDashboardSnapshot(db);
      return {
        status: 200,
        data: {
          ok: true,
          result,
          dailySafeBudget: dashboard.survival?.budget?.dailySafeBudget ?? 0,
          dashboard
        }
      };
    }

    const batchList = Array.isArray(body.notifications)
      ? body.notifications
      : (Array.isArray(body.messages) ? body.messages : null);

    if (batchList && batchList.length > 0) {
      const results = [];
      for (const item of batchList) {
        const itemObj = typeof item === 'string' ? { raw_text: item } : (item || {});
        if (itemObj.source === 'apple_pay' || itemObj.source === 'apple_pay_auto') {
          try {
            const r = processApplePayTransaction(db, extractApplePayPayload(itemObj), {
              timestamp: itemObj.timestamp || new Date().toISOString(),
              referenceDate: itemObj.referenceDate || body.referenceDate
            });
            results.push(r);
          } catch (_) {}
          continue;
        }
        const text = itemObj.rawEmail
          ? decodeEmailMimeToText(itemObj.rawEmail)
          : extractAnyBodyText(itemObj);
        if (!String(text).trim() && !itemObj.amount) continue;
        try {
          const r = processBankNotification(db, text, {
            source: itemObj.source || reqSource,
            category: itemObj.category || body.category,
            direction: itemObj.direction || body.direction,
            amount: itemObj.amount,
            merchant: itemObj.merchant || itemObj.debtor_name || itemObj.debtorName,
            emailUid: itemObj.emailUid || itemObj.messageId || itemObj.uid,
            timestamp: itemObj.timestamp || new Date().toISOString(),
            referenceDate: itemObj.referenceDate || body.referenceDate
          });
          results.push(r);
        } catch (_) {}
      }
      const dashboard = buildFullDashboardSnapshot(db);
      return {
        status: 200,
        data: {
          ok: true,
          processedCount: results.length,
          results,
          result: results[results.length - 1] || null,
          dailySafeBudget: dashboard.survival?.budget?.dailySafeBudget ?? 0,
          dashboard
        }
      };
    }

    const rawText = body.rawEmail
      ? decodeEmailMimeToText(body.rawEmail)
      : extractAnyBodyText(body, searchParams);
    const result = processBankNotification(db, rawText, {
      source: reqSource,
      category: body.category || getParam('category'),
      direction: body.direction || getParam('direction'),
      amount: body.amount || getParam('amount'),
      merchant: body.merchant || body.debtor_name || body.debtorName || getParam('merchant'),
      emailUid: body.emailUid || body.messageId || body.uid,
      timestamp: body.timestamp || new Date().toISOString(),
      referenceDate: body.referenceDate
    });
    const dashboard = buildFullDashboardSnapshot(db);
    return {
      status: 200,
      data: {
        ok: true,
        result,
        dailySafeBudget: dashboard.survival?.budget?.dailySafeBudget ?? 0,
        dashboard
      }
    };
  }

  // 2. Gmail IMAP 主動與背景自動掃描
  if (method === 'POST' && pathname === '/api/notifications/gmail-poll') {
    const imapRes = await pollEsunEmailsViaImap(db);
    return { status: 200, data: { ok: true, imap: imapRes, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 3. 薪資設定與跨專案班表全自動同步 (支援 shift-pay-app 即時自動推送、外部目錄自動掃描、或手動微調)
  if ((method === 'GET' || method === 'POST') && pathname === '/api/shift/state') {
    const survival = getSurvivalDashboardMetrics(db);
    const rawPayload = survival.cycle.rawShiftPayload || null;
    const fullState = rawPayload?.fullState || null;
    const hasShiftData = Boolean(
      (fullState?.shifts && Object.keys(fullState.shifts).length > 0) ||
      (rawPayload && Number(rawPayload.totalPay) > 0)
    );
    return {
      status: 200,
      data: {
        ok: true,
        hasShiftData,
        fullState,
        shiftSummary: rawPayload,
        hourlyWage: survival.cycle.hourlyWage,
        updatedAt: survival.cycle.lastSyncedAt
      }
    };
  }

  if (method === 'POST' && (pathname === '/api/shift/sync' || pathname === '/api/shift/webhook')) {
    if (body.mappingMode === 'NEXT_MONTH_PAY' || body.mappingMode === 'SAME_MONTH_PAY') {
      db.prepare('UPDATE user_settings SET llm_api_key = ?, updated_at = ? WHERE id = 1')
        .run(body.mappingMode, new Date().toISOString());
    }
    if (body.clearManualSalary === true) {
      const curCycle = syncCycleWithShiftData(db, { recalculateOnly: true, referenceDateStr: body.referenceDate || null });
      db.prepare('UPDATE income_cycles SET actual_salary = NULL, is_salary_settled = 0, last_synced_at = ? WHERE cycle_key = ?')
        .run(new Date().toISOString(), curCycle.cycle_key);
    }
    const cycle = syncCycleWithShiftData(db, {
      rawJsonPayload: body.rawJsonPayload || body.shiftState || body.payload || null,
      manualNetSalary: body.manualNetSalary,
      manualGrossPay: body.manualGrossPay,
      manualHourlyWage: body.manualHourlyWage,
      recalculateOnly: Boolean(body.recalculateOnly),
      isAutoSync: Boolean(body.autoSync),
      referenceDateStr: body.referenceDate || null
    });
    const fullDash = buildFullDashboardSnapshot(db);
    const effective = fullDash.survival.budget.effectiveIncome;
    const nextEst = fullDash.survival.timeMapping?.upcomingCycle?.currMonthShift?.estimatedNetPay || 0;
    return {
      status: 200,
      data: {
        ok: true,
        message: `✅ 已同步薪資與時間對照！目前可用預算 $${effective.toLocaleString()}｜下月發薪預估 $${nextEst.toLocaleString()}`,
        cycle,
        dashboard: fullDash
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

  // 9B. 首頁使用現金直接登記消費 & ATM 金融卡存款登記 & 刪除單筆紀錄
  if (method === 'POST' && pathname === '/api/cash/spend') {
    const res = recordCashTransaction(db, body);
    return { status: 200, data: { ok: true, ...res, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/deposits/add') {
    const res = recordManualAtmDeposit(db, body);
    return { status: 200, data: { ok: true, ...res, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/transactions/delete') {
    const res = deleteTransactionRecord(db, body.txId);
    return { status: 200, data: { ok: true, ...res, dashboard: buildFullDashboardSnapshot(db) } };
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


