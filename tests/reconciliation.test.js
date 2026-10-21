'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db/database');
const { processBankNotification, scanGhostHolds } = require('../src/services/reconciliationEngine');
const { getSurvivalDashboardMetrics } = require('../src/services/survivalEngine');

function setupTestDb() {
  return createDatabase({ dbPath: ':memory:', seedDefaults: false });
}

test('1. 麥香問題 (FIFO 佇列) & 3 分鐘防抖動鎖：連續兩天買 $10 麥香絕不重複扣款、亦不誤殺', () => {
  const db = setupTestDb();

  // 星期一 10/19 08:10 在 7-11 刷卡買 $10 麥香 (通道 A)
  const monAuth = processBankNotification(
    db,
    '【玉山銀行】您的玉山簽帳金融卡於 2026/10/19 在 統一超商 刷卡消費授權 NT$10 元（可用餘額圈存）。',
    { timestamp: '2026-10-19T08:10:00.000Z', referenceDate: '2026-10-19' }
  );
  assert.equal(monAuth.resultType, 'PENDING_CREATED');
  assert.equal(monAuth.transaction.status, 'PENDING');
  assert.equal(monAuth.transaction.personal_amount, 10);

  // 1 分鐘後 (08:11) 銀行系統重複推播同一封 $10 通知 -> 應被 3 分鐘防抖動鎖攔截忽略！
  const dupAuth = processBankNotification(
    db,
    '【玉山銀行】您的玉山簽帳金融卡於 2026/10/19 在 統一超商 刷卡消費授權 NT$10 元（可用餘額圈存）。',
    { timestamp: '2026-10-19T08:11:15.000Z', referenceDate: '2026-10-19' }
  );
  assert.equal(dupAuth.resultType, 'DEBOUNCE_IGNORED');

  // 星期三 10/21 09:00 又去 7-11 買了一瓶 $10 麥香 (超過 3 分鐘，視為獨立真實消費)
  const wedAuth = processBankNotification(
    db,
    '【玉山銀行】您的玉山簽帳金融卡於 2026/10/21 在 7-ELEVEN 刷卡消費授權 NT$10 元。',
    { timestamp: '2026-10-21T09:00:00.000Z', referenceDate: '2026-10-21' }
  );
  assert.equal(wedAuth.resultType, 'PENDING_CREATED');
  assert.notEqual(wedAuth.transaction.id, monAuth.transaction.id);

  // 此時應有 2 筆獨立 PENDING，當月已花費總額 = $20
  let metrics = getSurvivalDashboardMetrics(db, '2026-10-21');
  assert.equal(metrics.budget.totalSpent, 20);
  assert.equal(metrics.budget.pendingSpent, 20);

  // 星期四 10/22 收到第 1 封通道 B 請款扣款通知（未附原始日期，考驗 FIFO 先進先出）
  const settle1 = processBankNotification(
    db,
    '【玉山銀行】簽帳卡消費扣款通知：您的帳戶於 2026/10/22 商店請款扣款「7-ELEVEN」金額 NT$10 元。',
    { timestamp: '2026-10-22T03:00:00.000Z', referenceDate: '2026-10-22' }
  );
  assert.equal(settle1.resultType, 'RECONCILED_SETTLED');
  assert.equal(settle1.transaction.id, monAuth.transaction.id);
  assert.equal(settle1.transaction.status, 'SETTLED');
  assert.equal(settle1.transaction.is_reconciled_locked, 1);

  const wedTxNow = db.prepare('SELECT * FROM transactions WHERE id = ?').get(wedAuth.transaction.id);
  assert.equal(wedTxNow.status, 'PENDING');
  assert.equal(wedTxNow.is_reconciled_locked, 0);

  // 總花費依然是 $20（SETTLED $10 + PENDING $10），絕不重複扣成 $30！
  metrics = getSurvivalDashboardMetrics(db, '2026-10-22');
  assert.equal(metrics.budget.totalSpent, 20);
  assert.equal(metrics.budget.settledSpent, 10);
  assert.equal(metrics.budget.pendingSpent, 10);
});

test('2. 第三方支付店名變形正規化：連加*7-ELEVEN (LINE Pay) 圈存 vs 統一超商 請款精準配對', () => {
  const db = setupTestDb();

  const auth = processBankNotification(
    db,
    '【玉山Wallet】簽帳金融卡消費授權通知：2026/10/18 於「連加*７－ＥＬＥＶＥＮ」消費 NT$85 元。',
    { timestamp: '2026-10-18T12:30:00.000Z', referenceDate: '2026-10-18' }
  );
  assert.equal(auth.transaction.normalized_merchant, '7-ELEVEN');

  const settle = processBankNotification(
    db,
    '【玉山銀行】帳戶扣款通知：2026/10/20 簽帳卡消費請款「LINE PAY*統一超商」（原始交易日 2026/10/18）實際扣款 NT$85 元。',
    { timestamp: '2026-10-20T05:00:00.000Z', referenceDate: '2026-10-20' }
  );
  assert.equal(settle.resultType, 'RECONCILED_SETTLED');
  assert.equal(settle.transaction.id, auth.transaction.id);
  assert.equal(settle.reconcileScore, 100);
});
test('3. 跨國交易匯差與 1.5% 海外手續費自動修正 (±6% 容許誤差比對)', () => {
  const db = setupTestDb();

  const auth = processBankNotification(
    db,
    '【玉山銀行】簽帳金融卡消費授權：2026/10/15 於「STEAM GAMES」刷卡 NT$1,000 元。',
    { timestamp: '2026-10-15T22:00:00.000Z', referenceDate: '2026-10-15' }
  );
  assert.equal(auth.transaction.personal_amount, 1000);

  const settle = processBankNotification(
    db,
    '【玉山銀行】簽帳卡消費扣款：2026/10/18 商店請款「STEAMPOWERED」（原交易日 2026/10/15）帳戶扣款 NT$1,023 元。',
    { timestamp: '2026-10-18T06:00:00.000Z', referenceDate: '2026-10-18' }
  );
  assert.equal(settle.resultType, 'RECONCILED_SETTLED');
  assert.equal(settle.matchType, 'FX_TOLERANCE_MATCH');
  assert.equal(settle.fxFeeDiff, 23);
  assert.equal(settle.transaction.id, auth.transaction.id);
  assert.equal(settle.transaction.effective_amount, 1023);
  assert.equal(settle.transaction.personal_amount, 1023);

  const metrics = getSurvivalDashboardMetrics(db, '2026-10-18');
  assert.equal(metrics.budget.totalSpent, 1023);
});

test('4. 特殊邊界防護：加油站 $1,500 預授權白名單 (TEMP_HOLD) 與 $1 元綁卡驗證過濾 (AUTH_VERIFY)', () => {
  const db = setupTestDb();

  const verifyRes = processBankNotification(
    db,
    '【玉山銀行】簽帳金融卡消費授權：2026/10/16 於「優食*UBEREATS」刷卡 NT$1 元。',
    { timestamp: '2026-10-16T10:00:00.000Z', referenceDate: '2026-10-16' }
  );
  assert.equal(verifyRes.resultType, 'VERIFY_FILTERED');
  assert.equal(verifyRes.transaction.status, 'AUTH_VERIFY');
  assert.equal(verifyRes.transaction.personal_amount, 0);

  const gasHold = processBankNotification(
    db,
    '【玉山銀行】簽帳金融卡消費授權：2026/10/17 於「台灣中油」刷卡授權 NT$1,500 元。',
    { timestamp: '2026-10-17T18:00:00.000Z', referenceDate: '2026-10-17' }
  );
  assert.equal(gasHold.resultType, 'GAS_PREAUTH_HOLD');
  assert.equal(gasHold.transaction.status, 'TEMP_HOLD');
  assert.equal(gasHold.transaction.personal_amount, 0);

  let metrics = getSurvivalDashboardMetrics(db, '2026-10-17');
  assert.equal(metrics.budget.totalSpent, 0);

  const gasSettle = processBankNotification(
    db,
    '【玉山銀行】簽帳卡消費扣款：2026/10/20「台灣中油」（原交易日 2026/10/17）實際請款扣款 NT$135 元。',
    { timestamp: '2026-10-20T04:00:00.000Z', referenceDate: '2026-10-20' }
  );
  assert.equal(gasSettle.resultType, 'RECONCILED_SETTLED');
  assert.equal(gasSettle.transaction.id, gasHold.transaction.id);
  assert.equal(gasSettle.transaction.status, 'SETTLED');
  assert.equal(gasSettle.transaction.personal_amount, 135);

  metrics = getSurvivalDashboardMetrics(db, '2026-10-20');
  assert.equal(metrics.budget.totalSpent, 135);
});

test('5. 14 天幽靈圈存雷達、先買後退原則與發薪日入帳自動校正', () => {
  const db = setupTestDb();

  const shopTx = processBankNotification(
    db,
    '【玉山銀行】簽帳金融卡消費授權：2026/10/10 於「蝦皮購物」刷卡 NT$1,200 元。',
    { timestamp: '2026-10-10T11:00:00.000Z', referenceDate: '2026-10-10' }
  );
  assert.equal(shopTx.transaction.personal_amount, 1200);

  const alerts = scanGhostHolds(db, '2026-10-25');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].transactionId, shopTx.transaction.id);
  assert.match(alerts[0].alertText, /已逾 15 天未請款/);

  const refundRes = processBankNotification(
    db,
    '【玉山銀行】刷退入帳通知：2026/10/26「蝦皮購物」取消授權刷退 NT$1,200 元已退回帳戶。',
    { timestamp: '2026-10-26T10:00:00.000Z', referenceDate: '2026-10-26' }
  );
  assert.equal(refundRes.resultType, 'REFUND_APPLIED');
  assert.equal(refundRes.transaction.status, 'CANCELED');
  assert.equal(refundRes.transaction.personal_amount, 0);

  const salaryRes = processBankNotification(
    db,
    '【玉山銀行】薪資入帳通知：您的帳戶於 2026/10/10 收到薪資轉帳入帳 NT$23,800 元。',
    { timestamp: '2026-10-10T09:00:00.000Z', referenceDate: '2026-10-26' }
  );
  assert.equal(salaryRes.resultType, 'SALARY_CALIBRATED');
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

  // (A) 朋友聚餐刷卡 $2,000，自己僅負擔 $500，剩下 $1,500 移入應收代墊款池
  const dinnerTx = processBankNotification(
    db,
    '【玉山銀行】簽帳金融卡消費授權：2026/10/20 於「海底撈火鍋」刷卡 NT$2,000 元。',
    { timestamp: '2026-10-20T19:00:00.000Z', referenceDate: '2026-10-20' }
  );
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
  processBankNotification(
    db,
    '【玉山銀行】簽帳金融卡消費授權：2026/10/21 於「悠遊卡自動加值」消費 NT$500 元。',
    { timestamp: '2026-10-21T08:00:00.000Z', referenceDate: '2026-10-21' }
  );
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

test('8. Cloudflare 無伺服器相容引擎 (PortableSqliteDb & 快照匯出入)：雙重通知對帳與狀態同步完全一致', async () => {
  const { handleApiRequest, ensureDemoTransactionsIfEmpty } = require('../src/routes/api');
  const db = createDatabase({ engine: 'portable', seedDefaults: true });
  ensureDemoTransactionsIfEmpty(db);

  const authRes = await handleApiRequest('POST', '/api/notifications/parse', {
    text: '【玉山Wallet】簽帳金融卡消費授權通知：2026/10/21 於「連加*7-ELEVEN」消費 NT$85 元。',
    timestamp: '2026-10-21T10:00:00.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });
  assert.equal(authRes.data.ok, true);
  assert.equal(authRes.data.result.resultType, 'PENDING_CREATED');

  const snap = db.exportSnapshot();
  const db2 = createDatabase({ engine: 'portable', seedDefaults: false, snapshot: snap });

  const settleRes = await handleApiRequest('POST', '/api/notifications/parse', {
    text: '【玉山銀行】帳戶扣款通知：2026/10/21 簽帳卡消費請款「LINE PAY*統一超商」（原始交易日 2026/10/21）實際扣款 NT$85 元。',
    timestamp: '2026-10-21T18:00:00.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db: db2 });
  assert.equal(settleRes.data.ok, true);
  assert.equal(settleRes.data.result.resultType, 'RECONCILED_SETTLED');
  assert.equal(settleRes.data.result.transaction.id, authRes.data.result.transaction.id);
});

test('9. 信用卡與簽帳卡全自動偵測：免責聲明防誤判、小數點金額、可用餘額排除、跨管道(推播+Gmail MIME)絕不重複扣款', async () => {
  const { handleApiRequest } = require('../src/routes/api');
  const { syncEsunAvailableBalance } = require('../src/services/accountingPatchService');
  const db = setupTestDb();

  // (A) 手機推播先到達：含「末四碼1234」、「165.00 元」、「可用餘額 15,800 元」與「實際請款金額以帳單為準」免責聲明
  const pushRes = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'ios_shortcut_auto',
    text: '【消費通知】您的玉山Ｕ Bear信用卡(末四碼1234)於 2026/10/21 14:25 在「連加*麥當勞」一般消費 新臺幣 165.00 元（帳戶可用餘額 NT$15,800 元），實際請款金額以帳單為準。',
    timestamp: '2026-10-21T06:25:05.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });

  assert.equal(pushRes.data.ok, true);
  assert.equal(pushRes.data.result.resultType, 'PENDING_CREATED');
  assert.equal(pushRes.data.result.parsed.channelType, 'CHANNEL_A_AUTH');
  assert.equal(pushRes.data.result.parsed.cardType, 'CREDIT');
  assert.equal(pushRes.data.result.parsed.cardLast4, '1234');
  assert.equal(pushRes.data.result.parsed.normalizedMerchant, '麥當勞');
  assert.equal(pushRes.data.result.parsed.amount, 165);
  assert.equal(pushRes.data.result.parsed.reportedAvailableBalance, 15800);

  // (B) 15 分鐘後 Gmail 自動掃描又抓到同一筆 14:25 的消費通知信 -> 必須被跨管道防重鎖攔截，絕不重複扣款！
  const emailRes = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'gmail_imap_auto',
    emailUid: '99881',
    text: '【玉山銀行信用卡消費通知】卡號末4碼1234 於 2026/10/21 14:25 特店名稱：麥當勞 消費金額：NT$165 元，實際請款金額以商店請款為準。',
    timestamp: '2026-10-21T06:40:00.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });

  assert.equal(emailRes.data.result.resultType, 'DEBOUNCE_IGNORED');

  // 驗證總花費精準為 $165，絕不會算錯成 $330 或 $15800！
  const metrics = getSurvivalDashboardMetrics(db, '2026-10-21');
  assert.equal(metrics.budget.totalSpent, 165);
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

test('11. Apple Pay 感應刷卡秒級自動偵測：支援 iOS 錢包「交易」自動化 + 事後銀行通知防重 + 通道 B 請款核銷', async () => {
  const { handleApiRequest } = require('../src/routes/api');
  const db = setupTestDb();

  // (1) 手機感應 Apple Pay 當下 1 秒觸發 /api/notifications/apple-pay (帶入 merchant 與 amount)
  const applePayRes = await handleApiRequest('POST', '/api/notifications/apple-pay', {
    merchant: '星巴克 STARBUCKS',
    amount: 'NT$155',
    card: '玉山 U Bear',
    timestamp: '2026-10-21T07:00:00.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });

  assert.equal(applePayRes.data.ok, true);
  assert.equal(applePayRes.data.result.resultType, 'PENDING_CREATED');
  assert.equal(applePayRes.data.result.parsed.isApplePay, true);
  assert.equal(applePayRes.data.result.parsed.normalizedMerchant, '星巴克');
  assert.equal(applePayRes.data.result.parsed.amount, 155);

  // (2) 5 分鐘後收到玉山銀行發來的同筆消費授權通知信 -> 自動識別為剛才那筆 Apple Pay 刷卡，絕不重複扣款！
  const bankAuthRes = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'gmail_imap_auto',
    text: '【玉山銀行】您的玉山信用卡於 2026/10/21 在「悠旅生活(星巴克)」刷卡消費 NT$155 元。',
    timestamp: '2026-10-21T07:05:00.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });

  assert.equal(bankAuthRes.data.result.resultType, 'DEBOUNCE_IGNORED');

  // (3) 兩天後收到銀行通道 B 請款扣款通知 -> 自動核銷該筆 Apple Pay 交易並上鎖
  const bankSettleRes = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'gmail_imap_auto',
    text: '【玉山銀行】帳戶扣款通知：2026/10/23 商店請款「星巴克」（原交易日 2026/10/21）實際扣款 NT$155 元。',
    timestamp: '2026-10-23T03:00:00.000Z',
    referenceDate: '2026-10-23'
  }, new URLSearchParams(), { db });

  assert.equal(bankSettleRes.data.result.resultType, 'RECONCILED_SETTLED');
  assert.equal(bankSettleRes.data.result.transaction.id, applePayRes.data.result.transaction.id);

  // 驗證總花費始終精準為 $155！
  const metrics = getSurvivalDashboardMetrics(db, '2026-10-23');
  assert.equal(metrics.budget.totalSpent, 155);
  assert.equal(metrics.budget.settledSpent, 155);
  assert.equal(metrics.budget.pendingSpent, 0);

  // (4) 驗證新版 iOS AI「描述捷徑」直接傳送極簡文字（無「於...消費」結構，如「麥當勞 NT$165」）也能精準抓出店名與金額
  const iosAiRes = await handleApiRequest('POST', '/api/notifications/apple-pay', {
    text: '麥當勞 NT$165',
    timestamp: '2026-10-23T12:00:00.000Z',
    referenceDate: '2026-10-23'
  }, new URLSearchParams(), { db });
  assert.equal(iosAiRes.data.result.resultType, 'PENDING_CREATED');
  assert.equal(iosAiRes.data.result.parsed.normalizedMerchant, '麥當勞');
  assert.equal(iosAiRes.data.result.parsed.amount, 165);

  // (5) 驗證使用者實測的新版 iOS「當我收到來自 玉山銀行 / 錢包 的通知時」自動產生的 { body: [內文], title: [標題] } JSON 格式
  const iosNotifNodeRes = await handleApiRequest('POST', '/api/notifications/webhook', {
    body: '2026/10/23 18:10 連加*全家便利商店 一般消費 NT$95 元',
    title: '玉山銀行消費通知',
    timestamp: '2026-10-23T18:10:00.000Z',
    referenceDate: '2026-10-23'
  }, new URLSearchParams(), { db });
  assert.equal(iosNotifNodeRes.data.result.resultType, 'PENDING_CREATED');
  assert.equal(iosNotifNodeRes.data.result.parsed.normalizedMerchant, '全家便利商店');
  assert.equal(iosNotifNodeRes.data.result.parsed.amount, 95);
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

  // (2) 跨管道防重測試：5 分鐘後 Gmail 信箱又抓到同一筆 15:20 的 $6,000 ATM 存款通知信 -> 自動攔截不重複累加！
  const dupAtmEmail = await handleApiRequest('POST', '/api/notifications/webhook', {
    source: 'gmail_imap_auto',
    text: '【玉山銀行臺幣存匯通知】您的帳戶於 2026/10/21 15:20 自動化設備存款 新臺幣 6,000.00 元。',
    timestamp: '2026-10-21T07:25:00.000Z',
    referenceDate: '2026-10-21'
  }, new URLSearchParams(), { db });
  assert.equal(dupAtmEmail.data.result.resultType, 'DEBOUNCE_IGNORED');
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

test('14. 皮包現金與悠遊卡自訂輸入加值與扣款：支援 60、+60、＋60 正數加值與 -60、－60 負數扣款', async () => {
  const { handleApiRequest } = require('../src/routes/api');
  const db = setupTestDb();

  // 初始餘額為 $0，輸入正數 60 應加值 +$60 顯示為 $60
  const addCash60 = await handleApiRequest('POST', '/api/wallet-tank/adjust', {
    tankType: 'CASH',
    deltaAmount: '60',
    note: '自訂金額加值'
  }, new URLSearchParams(), { db });
  assert.equal(addCash60.data.walletTank.cashBalance, 60);

  // 輸入 +60 應再加值 +$60 顯示為 $120
  const addCashPlus60 = await handleApiRequest('POST', '/api/wallet-tank/adjust', {
    tankType: 'CASH',
    deltaAmount: '+60',
    note: '自訂金額加值'
  }, new URLSearchParams(), { db });
  assert.equal(addCashPlus60.data.walletTank.cashBalance, 120);

  // 悠遊卡輸入 +60 與全形 ＋60 應正常加值
  await handleApiRequest('POST', '/api/wallet-tank/adjust', {
    tankType: 'EASYCARD',
    deltaAmount: '60',
    note: '自訂金額加值'
  }, new URLSearchParams(), { db });
  const addEasyPlus60 = await handleApiRequest('POST', '/api/wallet-tank/adjust', {
    tankType: 'EASYCARD',
    deltaAmount: '＋60',
    note: '自訂金額加值'
  }, new URLSearchParams(), { db });
  assert.equal(addEasyPlus60.data.walletTank.easycardBalance, 120);

  // 輸入 -45 應正常扣款
  const subEasy45 = await handleApiRequest('POST', '/api/wallet-tank/adjust', {
    tankType: 'EASYCARD',
    deltaAmount: '-45',
    note: '自訂金額扣款'
  }, new URLSearchParams(), { db });
  assert.equal(subEasy45.data.walletTank.easycardBalance, 75);
});

test('15. 雲端支出上限警示防誤判與交易刪除水庫自動回滾：GCP 預算信不誤判為消費或 ATM 提款，且刪除提款紀錄自動扣回皮包餘額', async () => {
  const { isBankTransactionEmailText } = require('../src/services/gmailImapService');
  const { parseEsunNotification } = require('../src/services/esunParser');
  const { deleteTransactionRecord } = require('../src/services/accountingPatchService');
  const db = setupTestDb();

  // 1. 測試 GCP 預算上限警示信被 Gmail IMAP 掃到時，應直接被過濾
  const gcpEmailText = 'Warning 帳單支出上限警告\n帳單帳戶：我的帳單帳戶 (016E2E-47C0FE-37BB51)\n專案：無\n支出金額上限 $9,500.00\n目前支出：$9,500.00\nBase64 Chunk: aTm9500xyz';
  assert.equal(isBankTransactionEmailText(gcpEmailText), false);

  // 2. parseEsunNotification 遇到支出上限警告應拋出錯誤
  assert.throws(() => {
    parseEsunNotification(gcpEmailText);
  }, /非銀行扣款或帳戶通知/);

  // 3. 測試刪除曾轉入水庫的交易時，自動扣回皮包現金餘額
  db.prepare('UPDATE wallet_tank SET cash_balance = 10000 WHERE id = 1').run();
  db.prepare(`
    INSERT INTO transactions (id, cycle_key, status, raw_merchant, normalized_merchant, category, auth_amount, effective_amount, personal_amount, tx_date, tx_timestamp, created_at)
    VALUES (999, '2026-10', 'SETTLED', '我的帳單帳戶', '我的帳單帳戶', 'ATM提款', 9500, 9500, 9500, '2026-10-01', datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
    VALUES ('CASH', 9500, 10000, 'ATM提款自動存入皮包現金', 999, datetime('now'))
  `).run();

  // 刪除此交易
  deleteTransactionRecord(db, 999);

  // 驗證交易已刪除
  const tx = db.prepare('SELECT * FROM transactions WHERE id = 999').get();
  assert.equal(tx, undefined);

  // 驗證 wallet_tank 現金已自動扣回 9500 (10000 - 9500 = 500)
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  assert.equal(tank.cash_balance, 500);

  // 驗證有寫入負向回滾日誌
  const rollbackLog = db.prepare('SELECT * FROM wallet_tank_logs WHERE delta_amount = -9500').get();
  assert.ok(rollbackLog);
  assert.ok(rollbackLog.note.includes('刪除交易扣回水庫'));
});

test('16. 銀行轉帳與刷卡嚴格分離：轉帳轉出即時扣款結算不圈存、他人轉帳存入直接加預算、ATM提款精準入水庫', () => {
  const db = setupTestDb();
  const initTank = db.prepare('SELECT cash_balance FROM wallet_tank WHERE id = 1').get();
  const startCash = Number(initTank.cash_balance) || 0;

  // 1. 測試轉帳轉出 $20 (例如轉給朋友)
  const transferOut = processBankNotification(
    db,
    '【玉山銀行】台幣帳戶金額異動~提台幣20元',
    { timestamp: '2026-10-22T08:00:00.000Z', referenceDate: '2026-10-22' }
  );
  assert.equal(transferOut.resultType, 'TRANSFER_OUT_SETTLED');
  assert.equal(transferOut.transaction.status, 'SETTLED'); // 轉帳轉出直接結算，絕非 PENDING
  assert.equal(transferOut.transaction.is_reconciled_locked, 1);
  assert.equal(transferOut.transaction.personal_amount, 20);
  assert.equal(transferOut.transaction.category, '轉帳支出');
  assert.ok(transferOut.transaction.reconcile_note.includes('💸 帳戶轉帳支出'));
  assert.ok(!transferOut.transaction.reconcile_note.includes('信用卡刷卡'));
  assert.ok(!transferOut.transaction.reconcile_note.includes('圈存'));

  // 驗證水庫現金餘額完全未受轉帳影響
  const tankAfterOut = db.prepare('SELECT cash_balance FROM wallet_tank WHERE id = 1').get();
  assert.equal(Number(tankAfterOut.cash_balance), startCash);

  // 2. 測試他人轉帳轉入 $500 (例如朋友還錢或他人轉帳)
  const transferIn = processBankNotification(
    db,
    '【玉山銀行】台幣帳戶金額異動~存台幣500元',
    { timestamp: '2026-10-22T08:30:00.000Z', referenceDate: '2026-10-22' }
  );
  assert.equal(transferIn.resultType, 'DEPOSIT_RECORDED');
  assert.equal(transferIn.transaction.status, 'DEPOSIT');
  assert.equal(transferIn.transaction.category, '轉帳入帳');
  assert.equal(transferIn.transaction.personal_amount, 0); // 存入不扣預算
  assert.equal(transferIn.transaction.effective_amount, 500);
  assert.ok(transferIn.transaction.reconcile_note.includes('💸 帳戶轉帳存入'));
  assert.ok(!transferIn.transaction.reconcile_note.includes('ATM'));

  // 驗證他人轉帳存入不扣皮包現金
  const tankAfterIn = db.prepare('SELECT cash_balance FROM wallet_tank WHERE id = 1').get();
  assert.equal(Number(tankAfterIn.cash_balance), startCash);

  // 3. 測試實體 ATM 提款 $1000 -> 結算並轉入皮包現金水庫
  const atmWithdraw = processBankNotification(
    db,
    '【玉山銀行】ATM提款通知：您已於自動櫃員機提款新台幣 1000 元',
    { timestamp: '2026-10-22T09:00:00.000Z', referenceDate: '2026-10-22' }
  );
  assert.equal(atmWithdraw.resultType, 'ATM_WITHDRAWAL_SETTLED');
  assert.equal(atmWithdraw.transaction.status, 'SETTLED');
  assert.equal(atmWithdraw.transaction.category, 'ATM提款');
  assert.equal(atmWithdraw.transaction.personal_amount, 0);
  const tankAfterWithdraw = db.prepare('SELECT cash_balance FROM wallet_tank WHERE id = 1').get();
  assert.equal(Number(tankAfterWithdraw.cash_balance), startCash + 1000);

  // 4. 測試正常信用卡刷卡 $50 -> 必須維持通道 A PENDING 圈存預扣
  const cardAuth = processBankNotification(
    db,
    '【玉山銀行】信用卡消費通知：您於 7-ELEVEN 消費新台幣 50 元',
    { timestamp: '2026-10-22T09:15:00.000Z', referenceDate: '2026-10-22' }
  );
  assert.equal(cardAuth.resultType, 'PENDING_CREATED');
  assert.equal(cardAuth.transaction.status, 'PENDING');
  assert.equal(cardAuth.transaction.personal_amount, 50);
  assert.ok(cardAuth.transaction.reconcile_note.includes('信用卡刷卡'));
});


test('17. 本月剩餘包含現金：驗證皮包現金即時計入本月總剩餘可用額度與每日安全預算，並與玉山金融卡餘額校正嚴格隔離', async () => {
  const { handleApiRequest } = require('../src/routes/api');
  const { syncEsunAvailableBalance } = require('../src/services/accountingPatchService');
  const db = setupTestDb();
  const nowIso = '2026-10-22T08:00:00.000Z';

  // 1. 存入金融卡 $5,000，設定固定支出 $1,000 -> 金融卡純預算剩餘為 $4,000
  db.prepare(`
    INSERT INTO transactions (
      cycle_key, status, raw_merchant, normalized_merchant, category,
      auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
      tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
      reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
      channel_a_raw, channel_b_raw, created_at
    ) VALUES ('2026-10-10_2026-11-09', 'DEPOSIT', '玉山 ATM 存款', '玉山 ATM 存款', 'ATM存款', 5000, 5000, 0, 5000, 5000, '2026-10-22', ?, ?, NULL, 1, 100, 'ATM 存款', 0, 0, 'ATM', NULL, ?)
  `).run(nowIso, nowIso, nowIso);

  db.prepare(`
    INSERT INTO fixed_expenses (name, monthly_amount, billing_day, is_active, created_at)
    VALUES ('租屋補貼差額', 1000, 10, 1, ?)
  `).run(nowIso);

  // 2. 皮包現金設定為 $3,000
  db.prepare('UPDATE wallet_tank SET cash_balance = 3000, updated_at = ? WHERE id = 1').run(nowIso);

  const m1 = getSurvivalDashboardMetrics(db, '2026-10-22');
  assert.equal(m1.budget.cardRemainingBudget, 4000); // 5000 - 1000
  assert.equal(m1.budget.cashBalance, 3000);
  // 本月總剩餘可用額度必須包含現金：4000 + 3000 = 7000
  assert.equal(m1.budget.remainingBudget, 7000);
  assert.equal(m1.budget.totalRemaining, 7000);
  assert.equal(m1.budget.dailySafeBudget, Math.floor(7000 / m1.cycle.daysRemaining));

  // 3. 登記現金消費 $200 (未勾選同步扣卡) -> 皮包現金變 $2,800，總剩餘降至 $6,800
  await handleApiRequest('POST', '/api/cash/spend', {
    itemName: '午餐三寶飯',
    amount: 200,
    category: '餐飲外食',
    countInBudget: false,
    referenceDateStr: '2026-10-22'
  }, new URLSearchParams(), { db });

  const m2 = getSurvivalDashboardMetrics(db, '2026-10-22');
  assert.equal(m2.budget.cardRemainingBudget, 4000); // 金融卡預算不受影響
  assert.equal(m2.budget.cashBalance, 2800);
  assert.equal(m2.budget.remainingBudget, 6800); // 4000 + 2800 = 6800

  // 4. 玉山銀行金融卡餘額校正：應精確比對金融卡額度 ($4,000)，不受皮包現金 ($2,800) 干擾
  const syncRes = syncEsunAvailableBalance(db, {
    actualEsunBalance: 4000,
    referenceDateStr: '2026-10-22'
  });
  assert.equal(syncRes.discrepancyAmount, 0); // 完全吻合，無黑洞
});
