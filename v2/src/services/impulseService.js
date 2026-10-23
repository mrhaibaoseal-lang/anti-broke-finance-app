'use strict';

const {
  COFFEE_UNIT_PRICE,
  COOLDOWN_HOURS,
  VAMPIRE_WINDOW_DAYS,
  VAMPIRE_MAX_SINGLE_AMOUNT,
  VAMPIRE_WARNING_COUNT,
  VAMPIRE_ALERT_COUNT,
  SUBSCRIPTION_PRE_ALERT_DAYS,
  LATE_NIGHT_START_HOUR,
  LATE_NIGHT_END_HOUR,
  POST_PAYDAY_HIGH_RISK_DAYS,
  FLOW_TYPES,
  PAYMENT_MEDIA
} = require('../config/constants');
const { getSettings } = require('../repositories/settingsRepo');
const { getSmallExpensesInRange, insertEntry } = require('../repositories/ledgerRepo');
const {
  listCooldownItems,
  getCooldownItemById,
  insertCooldownItem,
  updateCooldownUnlockTime,
  updateCooldownStatus,
  listActiveFixedExpenses
} = require('../repositories/impulseRepo');
const { getTaipeiNowParts, evaluateSurvivalTier, getBudgetOverviewMetrics, ensureCurrentBudgetCycle } = require('./budgetEngine');
const { normalizeMerchant, classifyMerchantAndFlow } = require('./merchantClassifier');

async function getHighRiskModeStatus(db, referenceNowIso = null) {
  const settings = await getSettings(db);
  const tp = getTaipeiNowParts(referenceNowIso);
  const overview = await getBudgetOverviewMetrics(db, tp.dateStr);

  const isLateNight = tp.hour >= LATE_NIGHT_START_HOUR || tp.hour < LATE_NIGHT_END_HOUR;
  const isPostPayday72h = overview.cycle.daysElapsed >= 1 && overview.cycle.daysElapsed <= POST_PAYDAY_HIGH_RISK_DAYS;
  const isForced = Boolean(settings.force_high_risk_mode);
  const isHighRisk = isLateNight || isPostPayday72h || isForced;

  const reasons = [];
  if (isLateNight) reasons.push(`深夜腦波弱時段 (${tp.timeStr}，23:00~05:00 嚴格管制)`);
  if (isPostPayday72h) reasons.push(`發薪日後 72h 暴富錯覺期 (週期第 ${overview.cycle.daysElapsed} 天)`);
  if (isForced && !isLateNight && !isPostPayday72h) reasons.push('手動開啟高風險防禦模式');

  return {
    isHighRisk,
    isLateNight,
    isPostPayday72h,
    isForced,
    taipeiTime: tp.timeStr,
    reasons,
    warningBanner: isHighRisk
      ? `🌙 夜間/高風險防禦啟動中：${reasons.join(' ＋ ')}`
      : null
  };
}

function generateSoulRoast({ itemName, amount, reason, itemType, hours, minutes, dailyBefore, dailyAfter, tierBefore, tierAfter, isHighRisk }) {
  const r = String(reason || '').trim();
  const lines = [];

  if (isHighRisk) {
    lines.push('🛑 先把手機放下！現在是腦波最弱的高風險警戒時段，你以為的「心動」只是多巴胺在騙你的錢包！');
  }
  if (/特價|打折|優惠|限時|買一送一|免運|湊/.test(r)) {
    lines.push(`🔥 商家陷阱警報！「因為${r}而買」不是省錢，原本不買花 $0，買了立馬失血 $${amount.toLocaleString()}！`);
  } else if (/心情|壓力|犒賞|累|難過|生氣|獎勵/.test(r)) {
    lines.push(`💔 情緒消費警告！買「${itemName}」只能爽 15 分鐘，但接下來每天安全額度只剩 $${Math.max(0, dailyAfter)} 時會痛苦整個月！`);
  } else if (itemType === 'NEED') {
    lines.push(`🧐 靈魂拷問：你確定「${itemName}」真的是生存必需品 (Need)，還是被包裝成需要的「想要 (Want)」？`);
  } else {
    lines.push(`💀 靈魂拷問：買「${itemName}」的理由寫著「${r || '沒寫理由'}」，先冷靜 72 小時看看還想不想買！`);
  }

  lines.push(`⏱️ 血汗工時真相：這筆 $${amount.toLocaleString()} 等於你要在班表上辛苦多站【${hours} 小時 ${minutes} 分鐘】！`);
  lines.push(`📉 生存衝擊：買下去後，你每日數位安全額度將從 $${dailyBefore} 暴跌至 $${dailyAfter}（${tierBefore.emoji}${tierBefore.label} ➔ ${tierAfter.emoji}${tierAfter.label}）！`);
  return lines.join('\n\n');
}

async function evaluateImpulsePurchase(db, { itemName, amount, reason = '', itemType = 'WANT', addToCart = true, referenceNowIso = null }) {
  const cleanName = String(itemName || '').trim() || '想買商品';
  const amt = Math.max(1, Math.round(Number(amount) || 0));
  const type = itemType === 'NEED' ? 'NEED' : 'WANT';

  const settings = await getSettings(db);
  const tp = getTaipeiNowParts(referenceNowIso);
  const overview = await getBudgetOverviewMetrics(db, tp.dateStr);
  const highRisk = await getHighRiskModeStatus(db, referenceNowIso);

  const wage = Math.max(1, Number(settings.default_hourly_wage) || 200);
  const workHoursEquivalent = Number((amt / wage).toFixed(2));
  const hours = Math.floor(amt / wage);
  const minutes = Math.round(((amt / wage) - hours) * 60);
  const coffeeCups = Math.max(1, Math.round(amt / COFFEE_UNIT_PRICE));

  const dailyBefore = overview.metrics.dailySafeBudget;
  const remainingAfter = overview.metrics.digitalRemainingBudget - amt;
  const dailyAfter = Math.floor(remainingAfter / overview.cycle.daysRemaining);
  const tierBefore = evaluateSurvivalTier(dailyBefore);
  const tierAfter = evaluateSurvivalTier(dailyAfter);

  const aiRoastMessage = generateSoulRoast({
    itemName: cleanName,
    amount: amt,
    reason,
    itemType: type,
    hours,
    minutes,
    dailyBefore,
    dailyAfter,
    tierBefore,
    tierAfter,
    isHighRisk: highRisk.isHighRisk
  });

  let cooldownRecord = null;
  if (addToCart) {
    const nowMs = referenceNowIso ? new Date(referenceNowIso).getTime() : Date.now();
    const unlockIso = new Date(nowMs + COOLDOWN_HOURS * 3600 * 1000).toISOString();
    cooldownRecord = await insertCooldownItem(db, {
      itemName: cleanName,
      amount: amt,
      reason,
      itemType: type,
      workHoursEquivalent,
      dailyBudgetBefore: dailyBefore,
      dailyBudgetAfter: dailyAfter,
      tierBefore: tierBefore.code,
      tierAfter: tierAfter.code,
      aiRoastMessage,
      createdAt: new Date(nowMs).toISOString(),
      unlockAt: unlockIso
    });
  }

  return {
    itemName: cleanName,
    amount: amt,
    itemType: type,
    coffeeCups,
    sweatWork: { hours, minutes, workHoursEquivalent },
    survivalImpact: {
      dailyBudgetBefore: dailyBefore,
      dailyBudgetAfter: dailyAfter,
      tierBefore,
      tierAfter
    },
    aiRoastMessage,
    lockedIn72hPool: Boolean(cooldownRecord),
    cooldownRecord
  };
}

async function getCooldownCartSummary(db, referenceNowIso = null) {
  const settings = await getSettings(db);
  const wage = Math.max(1, Number(settings.default_hourly_wage) || 200);
  const nowMs = referenceNowIso ? new Date(referenceNowIso).getTime() : Date.now();
  const rows = await listCooldownItems(db);

  const coolingItems = [];
  const abandonedItems = [];
  for (const r of rows) {
    if (r.status === 'COOLING') {
      const unlockMs = new Date(r.unlock_at).getTime();
      const remainingHours = Math.max(0, Number(((unlockMs - nowMs) / 3600000).toFixed(1)));
      coolingItems.push({
        ...r,
        remainingHours,
        isUnlocked: remainingHours <= 0
      });
    } else if (r.status === 'ABANDONED') {
      abandonedItems.push(r);
    }
  }

  const savedTotalAmount = abandonedItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const savedWorkHours = Number((savedTotalAmount / wage).toFixed(1));
  const savedCount = abandonedItems.length;

  let achievementTitle = '🌱 防衝動覺醒者';
  if (savedTotalAmount >= 10000) achievementTitle = '👑 傳奇鐵公雞宗師';
  else if (savedTotalAmount >= 5000) achievementTitle = '🛡️ 黃金守財聖騎士';
  else if (savedTotalAmount >= 1500) achievementTitle = '⚔️ 剁手剋星守門員';

  return {
    coolingItems,
    abandonedCount: savedCount,
    savedTotalAmount,
    savedWorkHours,
    achievementTitle
  };
}

async function fastForwardAllCoolingItems(db, itemId = null) {
  const pastIso = new Date(Date.now() - 3600 * 1000).toISOString();
  if (itemId) {
    return await updateCooldownUnlockTime(db, itemId, pastIso);
  }
  const all = await listCooldownItems(db);
  for (const item of all) {
    if (item.status === 'COOLING') {
      await updateCooldownUnlockTime(db, item.id, pastIso);
    }
  }
  return { ok: true };
}

async function resolveCooldownItem(db, itemId, decision = 'ABANDON') {
  const item = await getCooldownItemById(db, itemId);
  if (!item) throw new Error('找不到該筆冷卻商品');

  if (decision === 'PURCHASE') {
    const updated = await updateCooldownStatus(db, item.id, 'PURCHASED');
    const tp = getTaipeiNowParts();
    const cycle = await ensureCurrentBudgetCycle(db, tp.dateStr);
    const norm = normalizeMerchant(item.item_name);
    const cls = classifyMerchantAndFlow(item.item_name, norm);
    const entry = await insertEntry(db, {
      cycleKey: cycle.cycle_key,
      flowType: FLOW_TYPES.EXPENSE,
      paymentMedium: PAYMENT_MEDIA.DIGITAL_BANK,
      rawMerchant: item.item_name,
      normalizedMerchant: norm,
      category: cls.category === '一般消費' ? '網購剁手' : cls.category,
      amount: item.amount,
      budgetImpactAmount: item.amount,
      txDate: tp.dateStr,
      sourceChannel: 'cooldown_purchase',
      note: `🛒 冷卻滿 72h 後確認購買：${item.item_name}`
    });
    return { item: updated, ledgerEntry: entry };
  }

  const updated = await updateCooldownStatus(db, item.id, 'ABANDONED');
  return { item: updated, ledgerEntry: null };
}

async function getVampireAndSubscriptionRadar(db, referenceDateStr = null) {
  const refDate = (referenceDateStr || getTaipeiNowParts().dateStr).slice(0, 10);
  const refMs = new Date(`${refDate}T00:00:00`).getTime();
  const startDt = new Date(refMs - (VAMPIRE_WINDOW_DAYS - 1) * 86400000);
  const startStr = `${startDt.getFullYear()}-${String(startDt.getMonth() + 1).padStart(2, '0')}-${String(startDt.getDate()).padStart(2, '0')}`;

  const smallRows = await getSmallExpensesInRange(db, startStr, refDate, VAMPIRE_MAX_SINGLE_AMOUNT);
  const groups = new Map();
  for (const r of smallRows) {
    const key = r.normalized_merchant || r.category;
    if (!groups.has(key)) {
      groups.set(key, { name: key, category: r.category, count: 0, totalAmount: 0 });
    }
    const g = groups.get(key);
    g.count += 1;
    g.totalAmount += Number(r.amount) || 0;
  }

  const leaderboard = [...groups.values()]
    .map(g => ({
      ...g,
      isVampireAlert: g.count > VAMPIRE_ALERT_COUNT,
      isWarning: g.count >= VAMPIRE_WARNING_COUNT
    }))
    .sort((a, b) => b.count - a.count || b.totalAmount - a.totalAmount);

  const totalSmallCount = smallRows.length;
  const totalSmallAmount = smallRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  const fixedItems = await listActiveFixedExpenses(db);
  const currentDay = Number(refDate.slice(8, 10));
  const subscriptionAlerts = [];

  for (const fx of fixedItems) {
    let diffDays = fx.billing_day - currentDay;
    if (diffDays < 0) diffDays += 30;
    fx.daysUntilBilling = diffDays;
    fx.preBillingAlert = fx.expense_type === 'SUBSCRIPTION' && diffDays <= SUBSCRIPTION_PRE_ALERT_DAYS;
    if (fx.preBillingAlert) {
      subscriptionAlerts.push(
        `🔔 訂閱守門員提醒：【${fx.name} ($${fx.monthly_amount}/月)】將在 ${diffDays === 0 ? '今天' : diffDays + ' 天後'}（每月 ${fx.billing_day} 號）扣款！`
      );
    }
  }

  return {
    vampireRadar: {
      windowStart: startStr,
      windowEnd: refDate,
      totalSmallTxCount: totalSmallCount,
      totalSmallTxAmount: totalSmallAmount,
      isTriggered: totalSmallCount > VAMPIRE_ALERT_COUNT,
      alertText: totalSmallCount > VAMPIRE_ALERT_COUNT
        ? `🧛 隱形吸血鬼警報：過去 7 天內有 ${totalSmallCount} 筆低於 $${VAMPIRE_MAX_SINGLE_AMOUNT} 的小額消費，累積失血 $${totalSmallAmount.toLocaleString()} 元！`
        : null,
      leaderboard
    },
    fixedExpenses: {
      items: fixedItems,
      subscriptionAlerts
    }
  };
}

module.exports = {
  getHighRiskModeStatus,
  generateSoulRoast,
  evaluateImpulsePurchase,
  getCooldownCartSummary,
  fastForwardAllCoolingItems,
  resolveCooldownItem,
  getVampireAndSubscriptionRadar
};


