'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSqliteAdapter } = require('../src/db/dbAdapter');
const { setMonthlyBaseBudget, getBudgetOverviewMetrics } = require('../src/services/budgetEngine');
const {
  ingestApplePayTransaction,
  ingestTransferOrOcr,
  resolveSuspectedDuplicateEntry
} = require('../src/services/ingestionService');
const {
  quickAdjustWalletTank,
  recordCashExpense,
  recordAtmDepositToCard,
  splitLedgerEntryBill,
  syncEsunAvailableBalance,
  splitUnknownGapEntry,
  deleteAndRollbackLedgerEntry,
  updateAndReconcileLedgerEntry
} = require('../src/services/splitAndTankService');
const {
  evaluateImpulsePurchase,
  fastForwardAllCoolingItems,
  resolveCooldownItem
} = require('../src/services/impulseService');
const { handleApiRequest } = require('../src/routes/router');

test('1. 單一權威預算源與三大核心資產指標 (💳數位預算 / 💵實體水庫 / 💰最終總剩餘) 獨立計算且不被外部存款覆蓋', async () => {
  const db = createSqliteAdapter(':memory:');

  // 設定每月起始數位預算 $20,000
  await setMonthlyBaseBudget(db, { baseBudget: 20000, budgetNote: '手動設定' });
  // 設定實體水庫：皮包現金 $1,500 + 悠遊卡 $500 = $2,000
  await quickAdjustWalletTank(db, { tankType: 'CASH', deltaAmount: 1500, note: '初始現金' });
  await quickAdjustWalletTank(db, { tankType: 'EASYCARD', deltaAmount: 500, note: '初始悠遊卡' });

  let ov = await getBudgetOverviewMetrics(db);
  assert.equal(ov.metrics.digitalRemainingBudget, 20000);
  assert.equal(ov.metrics.physicalTankTotal, 2000);
  assert.equal(ov.metrics.grandTotalAvailable, 22000);

  // 收到外部一般存款/薪資入帳 $25,000 (INCOME_DEPOSIT)，嚴禁自動覆蓋 $20,000 起始預算！
  const depRes = await ingestTransferOrOcr(db, {
    raw_text: '【玉山銀行】薪資入帳通知：您的帳戶收到薪資轉帳 NT$25,000 元，可用餘額 NT$45,000 元。',
    direction: 'IN',
    flowType: 'INCOME_DEPOSIT'
  });
  assert.equal(depRes.flowType, 'INCOME_DEPOSIT');

  ov = await getBudgetOverviewMetrics(db);
  assert.equal(ov.cycle.baseBudget, 20000, '外部入帳絕不可自動覆蓋手動設定之起始預算');
  assert.equal(ov.metrics.digitalRemainingBudget, 20000);

  // 皮包現金消費 $100：扣減實體水庫，不扣數位預算，最終總剩餘變 $21,900
  await recordCashExpense(db, { itemName: '排骨便當', amount: 100 });
  ov = await getBudgetOverviewMetrics(db);
  assert.equal(ov.metrics.digitalRemainingBudget, 20000);
  assert.equal(ov.metrics.physicalTankTotal, 1900);
  assert.equal(ov.metrics.grandTotalAvailable, 21900);
});

test('2. 雙層 10 分鐘防重複入帳引擎 (2分鐘同通道攔截 + 10分鐘內疑似重複待確認)', async () => {
  const db = createSqliteAdapter(':memory:');
  await setMonthlyBaseBudget(db, { baseBudget: 10000 });

  const t0 = '2026-10-23T12:00:00.000Z';
  const t1 = '2026-10-23T12:00:30.000Z'; // 30 秒後捷徑重送
  const t2 = '2026-10-23T12:05:00.000Z'; // 5 分鐘後同店名同金額

  // 第 1 筆：正常入帳
  const r1 = await ingestApplePayTransaction(db, {
    amount: 155,
    merchant: '連加*星巴克',
    card_name: '玉山 Unicard (1234)',
    timestamp: t0
  });
  assert.equal(r1.status, 'ACCEPTED');
  assert.equal(r1.entry.normalized_merchant, '星巴克');

  // 第 2 筆 (30 秒後完全相同)：直接自動攔截 BLOCKED_DUPLICATE
  const r2 = await ingestApplePayTransaction(db, {
    amount: 155,
    merchant: '星巴克',
    card_name: '玉山 Unicard (1234)',
    timestamp: t1
  });
  assert.equal(r2.status, 'BLOCKED_DUPLICATE');
  assert.equal(r2.ignored, true);

  // 第 3 筆 (5 分鐘後同金額同店名)：標記為 SUSPECTED_DUPLICATE，暫不扣減數位預算
  const r3 = await ingestApplePayTransaction(db, {
    amount: 155,
    merchant: '星巴克',
    card_name: '玉山 Unicard (1234)',
    timestamp: t2
  });
  assert.equal(r3.status, 'FLAGGED_SUSPECTED');
  assert.equal(r3.entry.dedupe_status, 'SUSPECTED_DUPLICATE');
  assert.equal(r3.entry.budget_impact_amount, 0);

  let ov = await getBudgetOverviewMetrics(db);
  assert.equal(ov.metrics.digitalRemainingBudget, 10000 - 155, '疑似重複項目在確認前不扣預算');

  // 使用者點擊「確認真的是買了第 2 杯」
  await resolveSuspectedDuplicateEntry(db, r3.entry.id, 'CONFIRM');
  ov = await getBudgetOverviewMetrics(db);
  assert.equal(ov.metrics.digitalRemainingBudget, 10000 - 310, '確認後正式扣減第 2 筆預算');
});

test('3. 轉帳截圖 OCR 雜訊清洗、底部「信用卡」選單不誤殺、以及「朋友代墊 vs 轉入還款自動沖銷」分流驗證', async () => {
  const db = createSqliteAdapter(':memory:');
  await setMonthlyBaseBudget(db, { baseBudget: 15000 });

  // 情境 A：網銀轉帳截圖含有手機電量 88%、手續費 0元、銀行代碼 808、底部導覽列「信用卡」字樣
  const ocrOut = await ingestTransferOrOcr(db, {
    raw_text: `9:41 5G 88%\n【玉山行動銀行】臺幣轉帳成功\n轉帳金額 NT$ 600 元\n手續費優惠減免 0 元\n轉入銀行 808 玉山銀行\n交易備註 買日用品\n首頁 帳務 信用卡 設定`,
    direction: 'OUT',
    flowType: 'EXPENSE'
  });
  assert.equal(ocrOut.ignored, false, '截圖含「信用卡」選單絕不可被誤殺攔截');
  assert.equal(ocrOut.entry.amount, 600, '應精準略過 88%、0元、808 並抓出 $600');

  let ov = await getBudgetOverviewMetrics(db);
  assert.equal(ov.metrics.digitalRemainingBudget, 14400);

  // 情境 B：轉帳幫朋友代墊 $800 (ADVANCE_OUT) -> 不扣個人數位預算，進入應收代墊池
  const advOut = await ingestTransferOrOcr(db, {
    raw_text: `【玉山銀行】轉帳成功\n交易金額 $800\n交易備註 幫阿明買門票`,
    direction: 'OUT',
    flowType: 'ADVANCE_OUT'
  });
  assert.equal(advOut.flowType, 'ADVANCE_OUT');
  assert.equal(advOut.entry.budget_impact_amount, 0, '幫朋友代墊不扣減個人預算');

  ov = await getBudgetOverviewMetrics(db);
  assert.equal(ov.metrics.digitalRemainingBudget, 14400, '代墊後個人數位可用預算維持 $14,400');

  // 情境 C：收到朋友轉帳還款 $800 (ADVANCE_IN)，截圖同時印有對方「轉出帳號」與自己「轉入帳號」
  const advIn = await ingestTransferOrOcr(db, {
    raw_text: `【玉山Wallet】收到轉帳通知\n對方轉出帳號 822-***9988\n您的轉入帳號 808-***1234\n轉入金額 NT$800 元\n備註 阿明還門票錢`,
    direction: 'IN',
    flowType: 'ADVANCE_IN'
  });
  assert.equal(advIn.direction, 'IN');
  assert.equal(advIn.flowType, 'ADVANCE_IN');
  assert.equal(advIn.settledSplitBills.length, 1, '應自動沖銷結清阿明的 $800 代墊單');

  ov = await getBudgetOverviewMetrics(db);
  assert.equal(ov.metrics.digitalRemainingBudget, 14400, '收到朋友還款絕不虛增個人每月預算');
});

test('4. ATM 存入金融卡打錯金額時：支援 100% 雙向回滾反悔撤銷 (Delete) 與自由修改金額 (Edit)', async () => {
  const db = createSqliteAdapter(':memory:');
  await setMonthlyBaseBudget(db, { baseBudget: 10000 });
  await quickAdjustWalletTank(db, { tankType: 'CASH', deltaAmount: 3000, note: '初始皮包現金' });

  // 使用者想存 $1,000，卻不小心多打一個 0 變成存 $2,500（且勾選從皮包現金扣除）
  const wrongAtm = await recordAtmDepositToCard(db, {
    amount: 2500,
    merchant: '玉山 ATM 存款',
    deductFromWalletCash: true
  });

  let ov = await getBudgetOverviewMetrics(db);
  assert.equal(ov.metrics.digitalRemainingBudget, 12500, '數位可用額度暫增為 $12,500');
  assert.equal(ov.metrics.cashBalance, 500, '皮包現金被扣到剩 $500');

  // 測試 A：使用者點擊「✏️ 修改」將金額從 $2,500 改回正確的 $1,000
  await updateAndReconcileLedgerEntry(db, wrongAtm.entry.id, {
    amount: 1000,
    deductFromWalletCash: true
  });

  ov = await getBudgetOverviewMetrics(db);
  assert.equal(ov.metrics.digitalRemainingBudget, 11000, '修改後數位可用額度應精準變為 $11,000');
  assert.equal(ov.metrics.cashBalance, 2000, '修改後皮包現金應精準退回差額變為 $2,000');

  // 測試 B：使用者決定完全「↩️ 反悔撤銷」這筆 ATM 存款
  await deleteAndRollbackLedgerEntry(db, wrongAtm.entry.id);

  ov = await getBudgetOverviewMetrics(db);
  assert.equal(ov.metrics.digitalRemainingBudget, 10000, '撤銷後數位可用預算 100% 恢復為 $10,000');
  assert.equal(ov.metrics.cashBalance, 3000, '撤銷後皮包現金 100% 退回恢復為 $3,000');
});

test('5. 玉山可用餘額校正黑洞拆分與 72 小時防衝動冷卻池完整流程', async () => {
  const db = createSqliteAdapter(':memory:');
  await setMonthlyBaseBudget(db, { baseBudget: 10000 });

  // 系統推算應有 $10,000，但玉山實際餘額只有 $9,500 -> 自動生成 $500 待查黑洞
  const syncRes = await syncEsunAvailableBalance(db, { actualBankBalance: 9500 });
  assert.equal(syncRes.discrepancyAmount, 500);
  assert.ok(syncRes.gapEntry);

  // 將 $500 黑洞拆出 $300 聚餐忘記記帳
  const splitGap = await splitUnknownGapEntry(db, syncRes.gapEntry.id, [
    { merchant: '忘記記帳的火鍋', amount: 300 }
  ]);
  assert.equal(splitGap.remainingGap, 200);

  // 評估想買 $2,000 耳機並鎖入 72h 冷卻池 -> 快轉後選擇放棄購買 -> 省下 $2,000
  const ev = await evaluateImpulsePurchase(db, {
    itemName: '降噪耳機',
    amount: 2000,
    reason: '限時特價',
    itemType: 'WANT',
    addToCart: true
  });
  assert.ok(ev.lockedIn72hPool);
  await fastForwardAllCoolingItems(db, ev.cooldownRecord.id);
  const resolved = await resolveCooldownItem(db, ev.cooldownRecord.id, 'ABANDON');
  assert.equal(resolved.item.status, 'ABANDONED');
});

test('6. REST API 路由整合測試：完整覆蓋預算設定、Apple Pay、轉帳截圖 OCR 與 ATM 存款修改/撤銷', async () => {
  const db = createSqliteAdapter(':memory:');

  // 1. 設定起始預算 $20,000
  const bRes = await handleApiRequest(db, 'POST', '/api/budget/cycle', { baseBudget: 20000 });
  assert.equal(bRes.status, 200);
  assert.equal(bRes.data.dashboard.budgetOverview.metrics.digitalRemainingBudget, 20000);

  // 2. 先加皮包現金 $2,000，再測試 ATM 存入金融卡 $1,500 (誤輸入)，接著透過 API 改為 $500，最後撤銷刪除
  await handleApiRequest(db, 'POST', '/api/wallet/adjust', { tankType: 'CASH', deltaAmount: 2000, note: '初始現金' });
  const depRes = await handleApiRequest(db, 'POST', '/api/deposits/add', { amount: 1500, deductFromWalletCash: true });
  assert.equal(depRes.data.dashboard.budgetOverview.metrics.digitalRemainingBudget, 21500);
  assert.equal(depRes.data.dashboard.budgetOverview.metrics.cashBalance, 500);

  const editRes = await handleApiRequest(db, 'POST', '/api/ledger/update', {
    entryId: depRes.data.entry.id,
    amount: 500,
    deductFromWalletCash: true
  });
  assert.equal(editRes.data.dashboard.budgetOverview.metrics.digitalRemainingBudget, 20500);
  assert.equal(editRes.data.dashboard.budgetOverview.metrics.cashBalance, 1500);

  const delRes = await handleApiRequest(db, 'POST', '/api/ledger/delete', {
    entryId: depRes.data.entry.id
  });
  assert.equal(delRes.data.dashboard.budgetOverview.metrics.digitalRemainingBudget, 20000);
  assert.equal(delRes.data.dashboard.budgetOverview.metrics.cashBalance, 2000);

  // 3. 驗證 iOS 捷徑傳送中文欄位或無 source 標籤至 /api/notifications/webhook 時，自動識別為 Apple Pay 消費
  const apAutoRes = await handleApiRequest(db, 'POST', '/api/notifications/webhook', {
    商家: '統一超商',
    金額: 'NT$65',
    票卡: '玉山 Unicard'
  });
  assert.equal(apAutoRes.status, 200);
  assert.equal(apAutoRes.data.result.entry.source_channel, 'apple_pay_webhook');
  assert.equal(apAutoRes.data.result.entry.normalized_merchant, '7-ELEVEN');
  assert.equal(apAutoRes.data.dashboard.budgetOverview.metrics.digitalRemainingBudget, 20000 - 65);
});



