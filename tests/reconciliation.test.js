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



