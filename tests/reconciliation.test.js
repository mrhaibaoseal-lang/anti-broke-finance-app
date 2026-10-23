'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const { processApplePayTransaction, processBankNotification } = require('../src/services/reconciliationEngine');
const { getSurvivalDashboardMetrics } = require('../src/services/survivalEngine');

function setupTestDb() {
  return createDatabase({ dbPath: ':memory:', seedDefaults: false });
}

test('1. 【步驟 1】徹底攔截銀行刷卡/簽帳/消費/授權/卡號/請款/預授權通知：一律直接忽略不記帳，避免與 Apple Pay 重複', async () => {
  const { handleApiRequest } = require('../src/routes/api');
  const db = setupTestDb();

  const cardNotifications = [
    '【玉山銀行】您的玉山簽帳金融卡於 2026/10/19 在 統一超商 刷卡消費授權 NT$10 元（可用餘額圈存）。',
    '【玉山銀行】簽帳卡消費扣款通知：您的帳戶於 2026/10/22 商店請款扣款「7-ELEVEN」金額 NT$10 元。',
    '【玉山銀行】簽帳金融卡消費授權：2026/10/16 於「優食*UBEREATS」刷卡 NT$1 元（試刷驗證）。',
    '【玉山銀行】簽帳金融卡消費授權：2026/10/17 於「台灣中油」刷卡預授權 NT$1,500 元。',
    '【玉山銀行信用卡通知】卡號末4碼1234 於 2026/10/21 特店名稱：麥當勞 金額：NT$165 元。'
  ];

  for (const text of cardNotifications) {
    const res = await handleApiRequest('POST', '/api/notifications/webhook', {
      source: 'bank_push',
      text,
      timestamp: '2026-10-23T10:00:00.000Z',
      referenceDate: '2026-10-23'
    }, new URLSearchParams(), { db });

    assert.equal(res.data.ok, true);
    assert.equal(res.data.result.ignored, true);
    assert.equal(res.data.result.resultType, 'IGNORED_BANK_CARD');
  }

  const txCount = db.prepare('SELECT COUNT(*) AS cnt FROM transactions').get().cnt;
  assert.equal(txCount, 0);
  const metrics = getSurvivalDashboardMetrics(db, '2026-10-23');
  assert.equal(metrics.budget.totalSpent, 0);
});

test('2. 【步驟 2】乾淨的 Apple Pay 專用 JSON 格式接收：進系統直接視為 SETTLED 已確認交易並更新當日安全額度', async () => {
  const { handleApiRequest } = require('../src/routes/api');
  const db = setupTestDb();

  processBankNotification(
    db,
    '【玉山銀行】存款通知：您的玉山帳戶於 2026/10/20 於 ATM 現金存入 NT$9,000 元。',
    { timestamp: '2026-10-20T09:00:00.000Z', referenceDate: '2026-10-23' }
  );

  const appleRes = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'apple_pay',
    amount: 155,
    merchant: '星巴克 STARBUCKS',
    card_name: '玉山 Unicard',
    timestamp: '2026-10-23T10:12:00+08:00',
    referenceDate: '2026-10-23'
  }, new URLSearchParams(), { db });

  assert.equal(appleRes.data.ok, true);
  assert.equal(appleRes.data.result.resultType, 'APPLE_PAY_SETTLED');
  assert.equal(appleRes.data.result.transaction.status, 'SETTLED');
  assert.equal(appleRes.data.result.transaction.is_reconciled_locked, 1);
  assert.equal(appleRes.data.result.transaction.normalized_merchant, '星巴克');
  assert.equal(appleRes.data.result.transaction.effective_amount, 155);
  assert.equal(appleRes.data.result.transaction.personal_amount, 155);

  const bankDup = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'esun_push',
    text: '【玉山銀行】您的玉山信用卡(卡號1234)於 2026/10/23 在「星巴克」刷卡消費授權 NT$155 元。',
    timestamp: '2026-10-23T10:14:00+08:00',
    referenceDate: '2026-10-23'
  }, new URLSearchParams(), { db });
  assert.equal(bankDup.data.result.resultType, 'IGNORED_BANK_CARD');

  const metrics = getSurvivalDashboardMetrics(db, '2026-10-23');
  assert.equal(metrics.budget.totalSpent, 155);
  assert.equal(metrics.budget.settledSpent, 155);
  assert.equal(metrics.budget.pendingSpent, 0);
  assert.equal(metrics.budget.todaySpent, 155);
  assert.equal(metrics.budget.remainingBudget, 9000 - 155);
});
test('3. 【步驟 3】轉帳與收帳重構：支援 iOS 螢幕截圖 OCR (raw_text) + 分類標籤 (EXPENSE / ADVANCE / TRANSFER) + 5 分鐘防重複鎖', async () => {
  const { handleApiRequest } = require('../src/routes/api');
  const { getSplitBillsSummary } = require('../src/services/accountingPatchService');
  const db = setupTestDb();

  // (A) 螢幕 OCR 轉帳 + 手動選擇「一般支出 (EXPENSE)」-> 直接寫入 SETTLED 並扣減個人預算
  const ocrExpense = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'ios_ocr_shortcut',
    raw_text: '玉山銀行 臺幣轉帳 交易成功\n轉帳金額 NT$450\n轉出帳號 0808-***1234\n轉入帳號 822-***5678\n備註：房東水電費\n可用餘額 NT$12,550',
    category: 'EXPENSE',
    timestamp: '2026-10-23T12:00:00.000Z',
    referenceDate: '2026-10-23'
  }, new URLSearchParams(), { db });

  assert.equal(ocrExpense.data.ok, true);
  assert.equal(ocrExpense.data.result.resultType, 'TRANSFER_EXPENSE_RECORDED');
  assert.equal(ocrExpense.data.result.direction, 'OUT');
  assert.equal(ocrExpense.data.result.transaction.status, 'SETTLED');
  assert.equal(ocrExpense.data.result.transaction.effective_amount, 450);
  assert.equal(ocrExpense.data.result.transaction.personal_amount, 450);

  // (B) 【5 分鐘內相同金額與方向的防重複鎖 (Idempotency Check)】：
  // 3 分鐘後 (12:03) 收到銀行發來的 $450 轉出通知或重送一次捷徑 -> 必須被 5 分鐘防重鎖直接忽略！
  const dupTransferOut = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'bank_transfer_push',
    raw_text: '【玉山銀行】臺幣轉帳通知：您於 2026/10/23 12:00 轉帳成功 轉出金額 NT$450 元。',
    category: 'EXPENSE',
    timestamp: '2026-10-23T12:03:00.000Z',
    referenceDate: '2026-10-23'
  }, new URLSearchParams(), { db });

  assert.equal(dupTransferOut.data.result.ignored, true);
  assert.equal(dupTransferOut.data.result.resultType, 'IDEMPOTENCY_IGNORED');

  // (C) 螢幕 OCR 轉帳 + 手動選擇「代墊款 (ADVANCE)」-> 不扣個人預算 (personal_amount = 0)，且自動寫入應收代墊款池！
  const ocrAdvance = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'ios_ocr_shortcut',
    raw_text: '轉帳成功\n交易金額 NT$1,800\n轉入帳號 013-***9988\n備註：幫阿凱代墊演唱會門票',
    category: 'ADVANCE',
    timestamp: '2026-10-23T13:00:00.000Z',
    referenceDate: '2026-10-23'
  }, new URLSearchParams(), { db });

  assert.equal(ocrAdvance.data.result.resultType, 'TRANSFER_ADVANCE_RECORDED');
  assert.equal(ocrAdvance.data.result.transaction.status, 'SETTLED');
  assert.equal(ocrAdvance.data.result.transaction.effective_amount, 1800);
  assert.equal(ocrAdvance.data.result.transaction.personal_amount, 0);
  assert.ok(ocrAdvance.data.result.splitBill);
  assert.equal(ocrAdvance.data.result.splitBill.receivable_amount, 1800);

  const splitSummary = getSplitBillsSummary(db);
  assert.equal(splitSummary.pendingReceivableTotal, 1800);
  assert.equal(splitSummary.unpaidCount, 1);

  // (D) 螢幕 OCR 轉帳 + 手動選擇「內部互轉 (TRANSFER)」-> 自己帳戶間互轉，不扣個人預算 (personal_amount = 0)
  const ocrInternal = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'ios_ocr_shortcut',
    raw_text: '轉帳成功 NT$3,000 轉入帳號 812-***7777 備註：轉台新Richart備用',
    category: 'TRANSFER',
    timestamp: '2026-10-23T14:00:00.000Z',
    referenceDate: '2026-10-23'
  }, new URLSearchParams(), { db });

  assert.equal(ocrInternal.data.result.resultType, 'INTERNAL_TRANSFER_RECORDED');
  assert.equal(ocrInternal.data.result.transaction.status, 'SETTLED');
  assert.equal(ocrInternal.data.result.transaction.personal_amount, 0);

  const metrics = getSurvivalDashboardMetrics(db, '2026-10-23');
  assert.equal(metrics.budget.totalSpent, 450);
});

test('4. 發薪日入帳自動校正與收帳 5 分鐘防重鎖驗證', () => {
  const db = setupTestDb();

  const salaryRes = processBankNotification(
    db,
    '【玉山銀行】薪資入帳通知：您的帳戶於 2026/10/10 收到薪資轉帳入帳 NT$23,800 元。',
    { timestamp: '2026-10-10T09:00:00.000Z', referenceDate: '2026-10-26' }
  );
  assert.equal(salaryRes.resultType, 'SALARY_CALIBRATED');

  const dupSalary = processBankNotification(
    db,
    '【玉山銀行】臺幣帳戶入帳通知：存入金額 NT$23,800 元。',
    { timestamp: '2026-10-10T09:04:00.000Z', referenceDate: '2026-10-26' }
  );
  assert.equal(dupSalary.resultType, 'IDEMPOTENCY_IGNORED');

  const metrics = getSurvivalDashboardMetrics(db, '2026-10-26');
  assert.equal(metrics.cycle.isSalarySettled, true);
  assert.equal(metrics.budget.effectiveIncome, 23800);
});

test('6. 防衝動消費守門員：血汗工時換算、72 小時冷靜池鎖定與放棄購買成就榜', () => {
  const { evaluateImpulsePurchase, fastForwardCooldownItem, resolveCooldownItem } = require('../src/services/impulseControlService');
  const db = setupTestDb();

  // 時薪 $200，想買 $1,500 的限量耳機 (Want) -> 等於要在班表多站 7 小時 30 分鐘，且強制鎖入 72h 冷靜池
  const evalRes = evaluateImpulsePurchase(db, {
    itemName: '藍牙降噪耳機',
    amount: 1500,
    reason: '限時特價好想買',
    itemType: 'WANT',
    addToCart: true
  }, { nowIso: '2026-10-21T23:30:00+08:00' }); // 台灣時間 23:30 觸發深夜高風險防禦模式

  assert.equal(evalRes.sweatWork.hours, 7);
  assert.equal(evalRes.sweatWork.minutes, 30);
  assert.equal(evalRes.highRiskMode.isHighRisk, true);
  assert.equal(evalRes.canBuyImmediately, false);
  assert.equal(evalRes.lockedIn72hPool, true);
  assert.equal(evalRes.cooldownRecord.status, 'COOLING');

  // 模擬滿 72 小時後解鎖，使用者選擇「放棄購買 (ABANDON)」-> 計入防剁手省錢成就榜
  fastForwardCooldownItem(db, evalRes.cooldownRecord.id);
  const resolved = resolveCooldownItem(db, evalRes.cooldownRecord.id, 'ABANDON');
  assert.equal(resolved.resolvedItem.status, 'ABANDONED');
  assert.equal(resolved.summary.achievement.totalSavedAmount, 1500);
  assert.equal(resolved.summary.achievement.abandonedCount, 1);
});

test('7. 日常真實生活補丁：聚餐一鍵拆帳代墊池、悠遊卡自動加值轉水庫、玉山餘額一鍵校正黑洞', () => {
  const { splitTransactionBill, settleSplitBill, getWalletTankStatus, syncEsunAvailableBalance, splitUnknownGapTransaction } = require('../src/services/accountingPatchService');
  const db = setupTestDb();

  // (A) 朋友聚餐透過 Apple Pay 刷卡 $2,000，自己僅負擔 $500，剩下 $1,500 移入應收代墊款池
  const dinnerTx = processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 2000,
    merchant: '海底撈火鍋',
    card_name: '玉山 Unicard',
    timestamp: '2026-10-20T19:00:00.000Z',
    referenceDate: '2026-10-20'
  });
  const splitRes = splitTransactionBill(db, {
    transactionId: dinnerTx.transaction.id,
    selfAmount: 500,
    debtorName: '阿明 $500、小華 $1000'
  });
  assert.equal(splitRes.transaction.personal_amount, 500);
  assert.equal(splitRes.splitBill.receivable_amount, 1500);

  let metrics = getSurvivalDashboardMetrics(db, '2026-10-20');
  assert.equal(metrics.budget.totalSpent, 500); // 只扣個人預算 $500！

  settleSplitBill(db, splitRes.splitBill.id);

  // (B) 悠遊卡自動加值 $500 -> 個人總預算照扣，同時自動轉入 Wallet Tank 水庫
  const tankBefore = getWalletTankStatus(db).easycardBalance;
  processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 500,
    merchant: '悠遊卡自動加值',
    card_name: '玉山簽帳金融卡',
    timestamp: '2026-10-21T08:00:00.000Z',
    referenceDate: '2026-10-21'
  });
  const tankAfter = getWalletTankStatus(db).easycardBalance;
  assert.equal(tankAfter, tankBefore + 500);

  // (C) 一鍵餘額校正：若玉山真實餘額比系統推算少了 $350 -> 自動生成「$350 未知漏帳（待查黑洞）」立即扣減安全額度
  processBankNotification(
    db,
    '【玉山銀行】薪資入帳通知：您的玉山帳戶於 2026/10/10 收到薪資轉帳入帳 NT$20,000 元。',
    { timestamp: '2026-10-10T09:00:00.000Z', referenceDate: '2026-10-21' }
  );
  metrics = getSurvivalDashboardMetrics(db, '2026-10-21');
  const expectedBal = metrics.budget.remainingBudget;
  const syncRes = syncEsunAvailableBalance(db, {
    actualEsunBalance: expectedBal - 350,
    referenceDateStr: '2026-10-21'
  });
  assert.equal(syncRes.discrepancyAmount, -350);
  assert.equal(syncRes.generatedGapTransaction.status, 'UNKNOWN_GAP');
  assert.equal(syncRes.generatedGapTransaction.personal_amount, 350);
  assert.equal(syncRes.updatedMetrics.budget.remainingBudget, expectedBal - 350);

  // 事後將 $350 黑洞拆分為具體明細
  const splitGap = splitUnknownGapTransaction(db, syncRes.generatedGapTransaction.id, [
    { merchant: '補記便當午餐', amount: 150, category: '餐飲外食' },
    { merchant: '補記日用品', amount: 200, category: '一般消費' }
  ]);
  assert.equal(splitGap.remainingGap, 0);
  assert.equal(splitGap.createdTransactions.length, 2);
});

test('8. Cloudflare 無伺服器相容引擎 (PortableSqliteDb & 快照匯出入)：Apple Pay 與 OCR 轉帳狀態同步完全一致', async () => {
  const { handleApiRequest, ensureDemoTransactionsIfEmpty } = require('../src/routes/api');
  const db = createDatabase({ engine: 'portable', seedDefaults: true });
  ensureDemoTransactionsIfEmpty(db);

  const appleRes = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'apple_pay',
    amount: 85,
    merchant: '7-ELEVEN',
    card_name: '玉山 Unicard',
    timestamp: '2026-10-21T10:00:00.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });
  assert.equal(appleRes.data.ok, true);
  assert.equal(appleRes.data.result.resultType, 'APPLE_PAY_SETTLED');
  assert.equal(appleRes.data.result.transaction.status, 'SETTLED');

  const snap = db.exportSnapshot();
  const db2 = createDatabase({ engine: 'portable', seedDefaults: false, snapshot: snap });

  // 在快照還原後的 db2 上驗證銀行刷卡通知會被攔截忽略
  const blockedRes = await handleApiRequest('POST', '/api/notifications/webhook', {
    text: '【玉山銀行】帳戶扣款通知：2026/10/21 簽帳卡消費請款「LINE PAY*統一超商」實際扣款 NT$85 元。',
    timestamp: '2026-10-21T18:00:00.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db: db2 });
  assert.equal(blockedRes.data.ok, true);
  assert.equal(blockedRes.data.result.resultType, 'IGNORED_BANK_CARD');
});

test('9. 銀行轉帳與收帳進階驗證：代墊款收帳自動沖銷 (ADVANCE IN) 與跨方向不誤殺', async () => {
  const { handleApiRequest } = require('../src/routes/api');
  const { getSplitBillsSummary } = require('../src/services/accountingPatchService');
  const db = setupTestDb();

  // (A) 先用 OCR 轉出一筆 $1,200 代墊款 (ADVANCE OUT)
  const outAdv = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'ios_ocr',
    raw_text: '轉帳成功 NT$1,200 轉入帳號 808-***1122 備註：聚餐代墊',
    category: 'ADVANCE',
    timestamp: '2026-10-21T12:00:00.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });
  assert.equal(outAdv.data.result.resultType, 'TRANSFER_ADVANCE_RECORDED');
  assert.equal(getSplitBillsSummary(db).pendingReceivableTotal, 1200);

  // (B) 2 分鐘後朋友馬上轉帳還錢 $1,200（方向為 IN 收帳，雖然金額相同但方向不同，絕不誤擋，且自動沖銷代墊池！）
  const inAdv = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'ios_ocr',
    raw_text: '【玉山銀行】收到轉帳入帳 NT$1,200 元 備註：聚餐還款',
    category: 'ADVANCE',
    direction: 'IN',
    timestamp: '2026-10-21T12:02:00.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });
  assert.equal(inAdv.data.result.resultType, 'ADVANCE_REPAID_IN');
  assert.equal(getSplitBillsSummary(db).pendingReceivableTotal, 0);
});

test('10. 薪資 App (shift-pay-app) 全自動無感連動：免手動貼 JSON 自動計算排班與加班薪資，且防空班表誤覆蓋', async () => {
  const { handleApiRequest } = require('../src/routes/api');
  const db = setupTestDb();

  // 模擬 shift-pay-app 在背景自動推送完整排班狀態 (2 天晚班 4h + 1 天假日班 8h 含加班 60m + 全勤 $500)
  const autoShiftPayload = {
    app: 'shiftpay-v2',
    updatedAt: '2026-10-21T10:00:00.000Z',
    month: '2026-10',
    state: {
      settings: {
        hourlyWage: 200,
        otMultiplier: 1.34,
        roundingMode: 'monthly',
        attendanceBonus: 500,
        myName: '王凱弘'
      },
      shifts: {
        '2026-10-12': { name: '晚班', start: '18:00', end: '22:00', breakMin: 0, otMin: 0, status: 'normal' },
        '2026-10-14': { name: '晚班', start: '18:00', end: '22:00', breakMin: 0, otMin: 0, status: 'normal' },
        '2026-10-18': { name: '假日班', start: '10:00', end: '19:00', breakMin: 60, otMin: 60, status: 'normal' }
      }
    }
  };

  const syncRes = await handleApiRequest('POST', '/api/shift/sync', {
    rawJsonPayload: autoShiftPayload,
    autoSync: true,
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });

  assert.equal(syncRes.data.ok, true);
  // 正常工時 = 4 + 4 + 8 = 16h ($3,200)，加班 60m = round(200 * 1.34) = $268，全勤 = $500 ➔ 總薪資 $3,968
  assert.equal(syncRes.data.cycle.shift_gross_pay, 3968);
  assert.equal(syncRes.data.cycle.normal_hours, 16);
  assert.equal(syncRes.data.cycle.ot_minutes, 60);
  assert.equal(syncRes.data.cycle.bonus_pay, 500);
  // 預估實領 (×0.95) = round(3968 * 0.95) = 3770
  assert.equal(syncRes.data.cycle.estimated_net_pay, 3770);

  // 若另一個空瀏覽器分頁觸發 autoSync (shifts 為空)，系統應保護既有 $3,968 薪資不被歸零
  const emptyAutoRes = await handleApiRequest('POST', '/api/shift/sync', {
    rawJsonPayload: { app: 'shiftpay-v2', state: { settings: { hourlyWage: 210 }, shifts: {} } },
    autoSync: true,
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });

  assert.equal(emptyAutoRes.data.cycle.shift_gross_pay, 3968);
  assert.equal(emptyAutoRes.data.cycle.hourly_wage, 210);
});

test('11. Apple Pay 感應刷卡秒級自動入帳：支援 /api/notifications/apple-pay 與 /api/notifications/webhook，直接寫入 SETTLED', async () => {
  const { handleApiRequest } = require('../src/routes/api');
  const db = setupTestDb();

  // (1) 手機感應 Apple Pay 當下 1 秒觸發 /api/notifications/apple-pay
  const applePayRes = await handleApiRequest('POST', '/api/notifications/apple-pay', {
    source: 'apple_pay',
    merchant: '星巴克 STARBUCKS',
    amount: 155,
    card_name: '玉山 U Bear',
    timestamp: '2026-10-21T07:00:00.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });

  assert.equal(applePayRes.data.ok, true);
  assert.equal(applePayRes.data.result.resultType, 'APPLE_PAY_SETTLED');
  assert.equal(applePayRes.data.result.transaction.status, 'SETTLED');
  assert.equal(applePayRes.data.result.parsed.normalizedMerchant, '星巴克');
  assert.equal(applePayRes.data.result.parsed.amount, 155);

  // (2) 5 分鐘後收到玉山銀行發來的同筆消費授權通知信 -> 被步驟 1 攔截丟棄，絕不重複扣款！
  const bankAuthRes = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'gmail_imap_auto',
    text: '【玉山銀行】您的玉山信用卡於 2026/10/21 在「悠旅生活(星巴克)」刷卡消費 NT$155 元。',
    timestamp: '2026-10-21T07:05:00.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });

  assert.equal(bankAuthRes.data.result.resultType, 'IGNORED_BANK_CARD');

  // (3) 兩天後收到銀行請款扣款通知 -> 同樣被攔截丟棄
  const bankSettleRes = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'gmail_imap_auto',
    text: '【玉山銀行】帳戶扣款通知：2026/10/23 商店請款「星巴克」（原交易日 2026/10/21）實際扣款 NT$155 元。',
    timestamp: '2026-10-23T03:00:00.000Z',
    referenceDate: '2026-10-23'
  }, new URLSearchParams(), { db });

  assert.equal(bankSettleRes.data.result.resultType, 'IGNORED_BANK_CARD');

  // 驗證總花費始終精準為 $155！
  const metrics = getSurvivalDashboardMetrics(db, '2026-10-23');
  assert.equal(metrics.budget.totalSpent, 155);
  assert.equal(metrics.budget.settledSpent, 155);
  assert.equal(metrics.budget.pendingSpent, 0);
});

test('12. 修復三大已知問題：現金/悠遊卡自訂負數扣款不歸零、主畫面薪資 App 備份導入與雲端狀態拉取 (/api/shift/state)', async () => {
  const { handleApiRequest } = require('../src/routes/api');
  const db = setupTestDb();

  // (1) 先設定悠遊卡 $500、皮包現金 $1,000
  const initTankRes = await handleApiRequest('POST', '/api/wallet-tank/audit', {
    easycardBalance: '500',
    cashBalance: '1000'
  }, new URLSearchParams(), { db });
  assert.equal(initTankRes.data.walletTank.easycardBalance, 500);
  assert.equal(initTankRes.data.walletTank.cashBalance, 1000);

  // (2) 輸入負數（例如悠遊卡 -45、現金 -80）應從餘額中扣除，絕不可直接歸零！
  const negTankRes = await handleApiRequest('POST', '/api/wallet-tank/audit', {
    easycardBalance: '-45',
    cashBalance: '-80'
  }, new URLSearchParams(), { db });
  assert.equal(negTankRes.data.walletTank.easycardBalance, 455);
  assert.equal(negTankRes.data.walletTank.cashBalance, 920);

  // (3) 模擬從手機主畫面「打工薪水帳 V2」匯出備份檔 (.json) 直接導入
  const backupFileJson = {
    app: 'shiftpay-v2',
    exportedAt: '2026-10-21T12:00:00.000Z',
    settings: {
      hourlyWage: 215,
      otMultiplier: 1.34,
      roundingMode: 'monthly',
      attendanceBonus: 600,
      myName: '手機主畫面使用者'
    },
    stamps: [{ id: 's1', name: '晚班', color: '#0A84FF', start: '18:00', end: '22:00', breakMin: 0 }],
    shifts: {
      '2026-10-15': { name: '晚班', start: '18:00', end: '22:00', breakMin: 0, otMin: 0, status: 'normal' },
      '2026-10-16': { name: '晚班', start: '18:00', end: '22:00', breakMin: 0, otMin: 0, status: 'normal' }
    }
  };

  const importRes = await handleApiRequest('POST', '/api/shift/sync', {
    rawJsonPayload: backupFileJson,
    autoSync: false,
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });
  assert.equal(importRes.data.ok, true);
  // 8小時 * $215 = $1,720 + 全勤 $600 = $2,320
  assert.equal(importRes.data.cycle.shift_gross_pay, 2320);

  // (4) 驗證內嵌 /shift-pay 頁面呼叫 GET /api/shift/state 能拉取完整班表日曆與設定，不再是初始歸零狀態
  const stateRes = await handleApiRequest('GET', '/api/shift/state', {}, new URLSearchParams(), { db });
  assert.equal(stateRes.data.ok, true);
  assert.equal(stateRes.data.hasShiftData, true);
  assert.equal(stateRes.data.fullState.settings.hourlyWage, 215);
  assert.equal(Object.keys(stateRes.data.fullState.shifts).length, 2);

  // (5) 驗證點擊「立即重新抓取最新薪資」(空 payload) 時保留已綁定的雲端班表，不會被空範本歸零
  const repullRes = await handleApiRequest('POST', '/api/shift/sync', {}, new URLSearchParams(), { db });
  assert.equal(repullRes.data.cycle.shift_gross_pay, 2320);

  // (6) 驗證雲端 UTC 時間 17:03（即台灣時間半夜 01:03）自動觸發夜間高風險防禦模式
  const { getHighRiskModeStatus } = require('../src/services/impulseControlService');
  const nightStatus = getHighRiskModeStatus(db, '2026-10-21T17:03:00.000Z');
  assert.equal(nightStatus.taipeiHour, 1);
  assert.equal(nightStatus.isLateNight, true);
  assert.equal(nightStatus.isHighRisk, true);

  // (7) 驗證「⏳ 薪資班表 ↔ 現實發薪時間對照」：
  // 10月登記的班表 ($2,320 * 0.95 = $2,204) 預設為「下個月 (11/10) 才領的錢」，不會誤當成 10 月現在能花的錢！
  const dashNextPay = repullRes.data.dashboard.survival;
  assert.equal(dashNextPay.timeMapping.mappingMode, 'NEXT_MONTH_PAY');
  assert.equal(dashNextPay.timeMapping.currentCycle.earnedShiftMonth, '2026-09');
  assert.equal(dashNextPay.timeMapping.currentCycle.effectiveIncome, 0);
  assert.equal(dashNextPay.timeMapping.upcomingCycle.workMonth, '2026-10');
  assert.equal(dashNextPay.timeMapping.upcomingCycle.paydayDate, '2026-11-10');
  assert.equal(dashNextPay.timeMapping.upcomingCycle.currMonthShift.estimatedNetPay, 2204);

  // 當使用者設定目前 10 月手頭實際可用預算 ($20,000) 時，現在能花的錢為 $20,000，同時下個月 11/10 預估仍保留 $2,204
  const setCurBudgetRes = await handleApiRequest('POST', '/api/shift/sync', {
    manualNetSalary: 20000,
    mappingMode: 'NEXT_MONTH_PAY',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });
  assert.equal(setCurBudgetRes.data.dashboard.survival.budget.effectiveIncome, 20000);
  assert.equal(setCurBudgetRes.data.dashboard.survival.timeMapping.upcomingCycle.currMonthShift.estimatedNetPay, 2204);

  // 若切換為「當月抵用制 (SAME_MONTH_PAY)」，則直接拿 10 月班表 ($2,204) 作為現在預算
  const sameMonthRes = await handleApiRequest('POST', '/api/shift/sync', {
    mappingMode: 'SAME_MONTH_PAY',
    clearManualSalary: true,
    recalculateOnly: true,
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });
  assert.equal(sameMonthRes.data.dashboard.survival.budget.effectiveIncome, 2204);
});

test('13. 領現金再去 ATM 存金融卡全流程：玉山 ATM 存款通知偵測、存款/扣款紀錄分離、首頁現金直接登記與班表零衝突', async () => {
  const { handleApiRequest } = require('../src/routes/api');
  const db = setupTestDb();

  // (1) 使用者領到現金薪水後，先在皮包留 $5,000 現鈔，並把 $6,000 拿去 ATM 存入玉山金融卡
  await handleApiRequest('POST', '/api/wallet-tank/audit', {
    cashBalance: '5000',
    easycardBalance: '300'
  }, new URLSearchParams(), { db });

  const atmDep1 = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'ios_shortcut_auto',
    text: '【玉山銀行】存款通知：您的玉山帳戶(末四碼1234)於 2026/10/21 15:20 於 ATM 現金存入 NT$6,000 元，帳戶可用餘額 NT$6,000 元。',
    timestamp: '2026-10-21T07:20:00.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });

  assert.equal(atmDep1.data.ok, true);
  assert.equal(atmDep1.data.result.resultType, 'DEPOSIT_RECORDED');
  assert.equal(atmDep1.data.result.channelType, 'DEPOSIT_IN');
  assert.equal(atmDep1.data.result.transaction.status, 'DEPOSIT');
  assert.equal(atmDep1.data.result.transaction.effective_amount, 6000);
  assert.equal(atmDep1.data.result.transaction.personal_amount, 0);
  assert.equal(atmDep1.data.dashboard.survival.budget.atmDeposited, 6000);
  assert.equal(atmDep1.data.dashboard.survival.budget.effectiveIncome, 6000);
  assert.equal(atmDep1.data.dashboard.survival.budget.totalSpent, 0);

  // (2) 跨管道 5 分鐘防重測試：5 分鐘內 Gmail 信箱又抓到同一筆 15:20 的 $6,000 ATM 存款通知信 -> 自動攔截不重複累加！
  const dupAtmEmail = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'gmail_imap_auto',
    text: '【玉山銀行臺幣存匯通知】您的帳戶於 2026/10/21 15:20 自動化設備存款 新臺幣 6,000.00 元。',
    timestamp: '2026-10-21T07:24:30.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });
  assert.equal(dupAtmEmail.data.result.resultType, 'IDEMPOTENCY_IGNORED');
  assert.equal(dupAtmEmail.data.dashboard.survival.budget.effectiveIncome, 6000);

  // (3) 隔天再去 ATM 無卡存款 $4,000 -> 自動累加存款紀錄，金融卡總可用預算變為 $10,000 (共 2 筆存款紀錄)
  const atmDep2 = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'ios_shortcut_auto',
    text: '【玉山Wallet】臺幣帳戶入帳通知：您的帳戶於 2026/10/22 18:10 完成無卡存款存入 新臺幣 4,000 元。',
    timestamp: '2026-10-22T10:10:00.000Z',
    referenceDate: '2026-10-22'
  }, new URLSearchParams(), { db });
  assert.equal(atmDep2.data.result.resultType, 'DEPOSIT_RECORDED');
  assert.equal(atmDep2.data.dashboard.survival.budget.atmDeposited, 10000);
  assert.equal(atmDep2.data.dashboard.survival.budget.depositCount, 2);
  assert.equal(atmDep2.data.dashboard.survival.budget.effectiveIncome, 10000);

  // (4) 首頁「使用現金直接登記」：花現金買雞腿便當 $120（僅扣皮包現金）與手搖飲 $65（同步計入防剁手預算）
  const cashTx1 = await handleApiRequest('POST', '/api/cash/spend', {
    itemName: '巷口雞腿便當',
    amount: 120,
    category: '餐飲外食',
    countInBudget: false,
    referenceDateStr: '2026-10-22'
  }, new URLSearchParams(), { db });
  assert.equal(cashTx1.data.ok, true);
  assert.equal(cashTx1.data.transaction.status, 'CASH_SPENT');
  assert.equal(cashTx1.data.walletTank.cashBalance, 4880); // 5000 - 120

  const cashTx2 = await handleApiRequest('POST', '/api/cash/spend', {
    itemName: '50嵐四季春',
    amount: 65,
    category: '手搖飲品',
    countInBudget: true,
    referenceDateStr: '2026-10-22'
  }, new URLSearchParams(), { db });
  assert.equal(cashTx2.data.walletTank.cashBalance, 4815); // 4880 - 65
  assert.equal(cashTx2.data.dashboard.survival.budget.cashSpent, 185); // 120 + 65
  assert.equal(cashTx2.data.dashboard.survival.budget.totalSpent, 65); // 僅勾選同步扣預算的 $65 計入金融卡防剁手總花費

  // (5) 首頁「從皮包拿現金去 ATM 存入金融卡」：拿 $3,000 皮包現金去 ATM 存卡 (deductFromWalletCash: true)
  const manualAtmRes = await handleApiRequest('POST', '/api/deposits/add', {
    amount: 3000,
    merchant: '玉山 ATM 存款',
    category: 'ATM存款',
    deductFromWalletCash: true,
    referenceDateStr: '2026-10-22'
  }, new URLSearchParams(), { db });
  assert.equal(manualAtmRes.data.walletTank.cashBalance, 1815); // 4815 - 3000
  assert.equal(manualAtmRes.data.dashboard.survival.budget.atmDeposited, 13000); // 10000 + 3000
  assert.equal(manualAtmRes.data.dashboard.survival.budget.depositCount, 3);
  assert.equal(manualAtmRes.data.dashboard.survival.budget.effectiveIncome, 13000);

  // (6) 驗證班表薪資 App 零衝突：即使同步了班表排班 ($2,320)，因為已有真實 ATM 存款 ($13,000)，主預算絕不會被班表覆蓋！
  const shiftSyncRes = await handleApiRequest('POST', '/api/shift/sync', {
    rawJsonPayload: {
      app: 'shiftpay-v2',
      settings: { hourlyWage: 200, otMultiplier: 1.34, roundingMode: 'monthly', attendanceBonus: 0 },
      shifts: {
        '2026-10-15': { name: '晚班', start: '18:00', end: '22:00', breakMin: 0, otMin: 0, status: 'normal' }
      }
    },
    autoSync: true,
    referenceDate: '2026-10-22'
  }, new URLSearchParams(), { db });
  assert.equal(shiftSyncRes.data.dashboard.survival.budget.effectiveIncome, 13000);
  assert.equal(shiftSyncRes.data.dashboard.survival.cycle.shiftGrossPay, 800); // 班表應領現金仍保留供對帳
});





