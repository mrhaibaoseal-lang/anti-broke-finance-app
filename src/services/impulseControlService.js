'use strict';

const { getSurvivalDashboardMetrics, evaluateSurvivalTier } = require('./survivalEngine');

/**
 * 將任意時間轉換為台灣時區 (UTC+8, Asia/Taipei) 的日期與小時資訊，
 * 解決 Cloudflare Workers 雲端伺服器預設為 UTC (慢 8 小時) 導致半夜未自動觸發夜間防禦的問題
 */
function getTaipeiTimeParts(referenceNowIso) {
  let dt;
  if (!referenceNowIso) {
    dt = new Date();
  } else {
    const s = String(referenceNowIso).trim();
    // 若傳入無時區偏移的本地字串，視為台灣時間 (+08:00)
    const hasTz = /Z$|[+-]\d{2}:?\d{2}$/i.test(s);
    dt = new Date(hasTz ? s : (s.length === 10 ? `${s}T12:00:00+08:00` : `${s}+08:00`));
    if (Number.isNaN(dt.getTime())) dt = new Date();
  }
  const taipeiMs = dt.getTime() + 8 * 3600 * 1000;
  const taipeiDt = new Date(taipeiMs);
  const year = taipeiDt.getUTCFullYear();
  const month = String(taipeiDt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(taipeiDt.getUTCDate()).padStart(2, '0');
  const hour = taipeiDt.getUTCHours();
  const minute = taipeiDt.getUTCMinutes();
  return {
    hour,
    minute,
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

/**
 * 3.3 偵測「深夜 (23:00~05:00) 與發薪日後 72 小時內」高風險防禦模式
 */
function getHighRiskModeStatus(db, referenceNowIso) {
  const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
  const tp = getTaipeiTimeParts(referenceNowIso);
  const hour = tp.hour;
  const localDateStr = tp.dateStr;

  const isLateNight = hour >= 23 || hour < 5;
  const metrics = getSurvivalDashboardMetrics(db, localDateStr);
  const isPostPayday72h = metrics.cycle.daysElapsed >= 1 && metrics.cycle.daysElapsed <= 3;
  const isForced = Boolean(settings.force_high_risk_mode);

  const isHighRisk = isLateNight || isPostPayday72h || isForced;
  const reasons = [];
  if (isLateNight) reasons.push(`深夜腦波弱時段 (${tp.timeStr}，23:00~05:00 嚴格管制)`);
  if (isPostPayday72h) reasons.push(`發薪日後 72 小時暴富錯覺期 (週期第 ${metrics.cycle.daysElapsed} 天)`);
  if (isForced && !isLateNight && !isPostPayday72h) reasons.push('手動開啟高風險防禦演習模式');

  return {
    isHighRisk,
    isLateNight,
    isPostPayday72h,
    isForced,
    taipeiHour: hour,
    taipeiTime: tp.timeStr,
    strictnessLevel: isHighRisk ? 'EXTREME' : 'STANDARD',
    reasons,
    warningBanner: isHighRisk
      ? `🚨【高風險防禦模式啟動中】目前處於「${reasons.join(' ＋ ')}」！此時段衝動網購後悔率極高，系統已將勸退標準調至最嚴格！`
      : null
  };
}

function generateSoulRoast({ itemName, amount, reason, itemType, hours, minutes, tierBefore, tierAfter, dailyAfter, isHighRisk }) {
  const r = String(reason || '').trim();
  const rebuttals = [];

  if (isHighRisk) {
    rebuttals.push('🛑 先把手機放下！現在是腦波最弱的高風險警戒時段，你以為的「心動」只是多巴胺在騙你的錢包！');
  }

  if (/特價|打折|優惠|限時|買一送一|免運|湊/.test(r)) {
    rebuttals.push(`🔥 經典商家陷阱！「因為${r}而買」不是省錢，是原本不用花 $0，現在卻要倒貼 $${amount}！為了湊免運或折扣多花的錢都是智商稅！`);
  } else if (/心情|壓力|犒賞|累|難過|生氣|獎勵/.test(r)) {
    rebuttals.push(`💔 情緒性消費警報！花 $${amount} 買「${itemName}」只能爽 15 分鐘，但月底看著帳戶餘額歸零、每天只剩 $${Math.max(0, dailyAfter)} 吃土時，你的心情會比現在痛苦十倍！`);
  } else if (/好看|可愛|帥|酷|喜歡|想買|新品|限量/.test(r)) {
    rebuttals.push(`🧊 外表好看不能當飯吃！家裡角落是不是已經堆了 3 個當初也覺得「超好看、非買不可」結果現在長灰塵的東西？`);
  } else if (itemType === 'NEED') {
    rebuttals.push(`🧐 你確定「${itemName}」真的是生存必需品 (Need)，還是被你包裝成需要的「想要 (Want)」？如果是今天不買明天就無法上班上課才叫需要！`);
  } else {
    rebuttals.push(`💀 靈魂拷問：買「${itemName}」的理由寫著「${r || '沒寫理由'}」，連你自己都說服不了自己對吧？`);
  }

  rebuttals.push(
    `⏱️ 血汗真相：這筆 $${amount} 等於你要在班表上辛苦多站【${hours} 小時 ${minutes} 分鐘】（相當於多上 ${(hours / 4).toFixed(1)} 個四小時晚班）！想像一下站到腳痠的時候，真的甘願把這筆血汗錢換成它嗎？`
  );

  if (tierAfter.code !== tierBefore.code || dailyAfter < 250) {
    rebuttals.push(
      `📉 生存衝擊：刷下去的瞬間，你本週期剩下的日子每天只剩 $${Math.max(0, dailyAfter)} 能活，生存狀態直接落入【${tierAfter.emoji} ${tierAfter.label}】！`
    );
  }

  return rebuttals.join('\n\n');
}

function evaluateImpulsePurchase(db, payload, options = {}) {
  const itemName = String(payload.itemName || '').trim();
  const amount = Math.max(1, Math.round(Number(payload.amount) || 0));
  const reason = String(payload.reason || '').trim();
  const itemType = String(payload.itemType || 'WANT').toUpperCase() === 'NEED' ? 'NEED' : 'WANT';
  const addToCart = payload.addToCart !== false;

  if (!itemName) throw new Error('請輸入想購買的商品名稱');

  const nowIso = options.nowIso || new Date().toISOString();
  const tp = getTaipeiTimeParts(nowIso);
  const refDate = tp.dateStr;
  const metrics = getSurvivalDashboardMetrics(db, refDate);
  const highRisk = getHighRiskModeStatus(db, nowIso);

  const hourlyWage = Math.max(1, Number(metrics.cycle.hourlyWage) || 200);
  const workHoursFloat = amount / hourlyWage;
  const hours = Math.floor(workHoursFloat);
  const minutes = Math.round((workHoursFloat - hours) * 60);
  const workTimeText = `${hours} 小時 ${minutes} 分鐘`;

  const dailyBefore = metrics.budget.dailySafeBudget;
  const remainingAfter = metrics.budget.remainingBudget - amount;
  const dailyAfter = Math.floor(remainingAfter / metrics.cycle.daysRemaining);
  const tierBefore = metrics.tier;
  const tierAfter = evaluateSurvivalTier(dailyAfter);

  const aiRoastMessage = generateSoulRoast({
    itemName, amount, reason, itemType,
    hours, minutes, tierBefore, tierAfter,
    dailyAfter, isHighRisk: highRisk.isHighRisk
  });

  const canBuyImmediately = itemType === 'NEED' && !highRisk.isHighRisk && dailyAfter >= 150;
  let cooldownRecord = null;

  if (addToCart && (itemType === 'WANT' || !canBuyImmediately)) {
    const unlockDt = new Date(new Date(nowIso).getTime() + 72 * 3600 * 1000);
    const unlockIso = unlockDt.toISOString();
    const res = db.prepare(`
      INSERT INTO cooldown_cart (
        item_name, amount, reason, item_type,
        work_hours_equivalent, work_time_text,
        daily_budget_before, daily_budget_after,
        tier_before, tier_after, ai_roast_message,
        created_at, unlock_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COOLING')
    `).run(
      itemName, amount, reason, itemType,
      Number(workHoursFloat.toFixed(2)), workTimeText,
      dailyBefore, dailyAfter,
      `${tierBefore.emoji} ${tierBefore.label}`, `${tierAfter.emoji} ${tierAfter.label}`,
      aiRoastMessage, nowIso, unlockIso
    );
    cooldownRecord = db.prepare('SELECT * FROM cooldown_cart WHERE id = ?').get(Number(res.lastInsertRowid));
  }

  return {
    itemName, amount, reason, itemType, hourlyWage,
    sweatWork: {
      hours, minutes, totalHours: Number(workHoursFloat.toFixed(2)),
      text: `買這個東西，等於你要在班表上多站 ${hours} 小時 ${minutes} 分鐘才能換到！`
    },
    survivalImpact: {
      daysRemaining: metrics.cycle.daysRemaining,
      dailyBudgetBefore: dailyBefore, dailyBudgetAfter: dailyAfter,
      tierBefore, tierAfter,
      text: `買下去後，你這個月剩下的 ${metrics.cycle.daysRemaining} 天每天只剩 $${dailyAfter} 可以活（${tierBefore.emoji}${tierBefore.label} ➔ ${tierAfter.emoji}${tierAfter.label}）`
    },
    highRiskMode: highRisk,
    aiRoastMessage,
    canBuyImmediately,
    lockedIn72hPool: Boolean(cooldownRecord),
    cooldownRecord
  };
}

function getCooldownCartSummary(db, referenceNowIso) {
  const nowIso = referenceNowIso || new Date().toISOString();
  const nowMs = new Date(nowIso).getTime();

  const items = db.prepare('SELECT * FROM cooldown_cart ORDER BY id DESC').all();
  for (const item of items) {
    if (item.status === 'COOLING' && new Date(item.unlock_at).getTime() <= nowMs) {
      db.prepare("UPDATE cooldown_cart SET status = 'UNLOCKED' WHERE id = ?").run(item.id);
      item.status = 'UNLOCKED';
    }
    const diffMs = Math.max(0, new Date(item.unlock_at).getTime() - nowMs);
    item.remainingHours = Number((diffMs / 3600000).toFixed(1));
    item.unlockPrompt = item.status === 'UNLOCKED'
      ? '🔓 已經過了 3 天（72 小時），你現在還非買不可嗎？點選「放棄購買」可將這筆錢計入防剁手成就榜！'
      : null;
  }

  const abandonedItems = items.filter(i => i.status === 'ABANDONED');
  const totalSavedAmount = abandonedItems.reduce((sum, i) => sum + Number(i.amount || 0), 0);
  const totalSavedHours = Number(abandonedItems.reduce((sum, i) => sum + Number(i.work_hours_equivalent || 0), 0).toFixed(1));

  return {
    activeItems: items.filter(i => i.status === 'COOLING' || i.status === 'UNLOCKED'),
    abandonedItems,
    purchasedItems: items.filter(i => i.status === 'PURCHASED'),
    achievement: {
      totalSavedAmount,
      totalSavedHours,
      abandonedCount: abandonedItems.length,
      badgeTitle: totalSavedAmount >= 5000 ? '🏆 鋼鐵防剁手宗師' : (totalSavedAmount >= 1500 ? '🛡️ 理智守財達人' : '🌱 防衝動覺醒者')
    }
  };
}

function fastForwardCooldownItem(db, itemId) {
  const pastIso = new Date(Date.now() - 1000).toISOString();
  db.prepare("UPDATE cooldown_cart SET unlock_at = ?, status = 'UNLOCKED' WHERE id = ?").run(pastIso, Number(itemId));
  return db.prepare('SELECT * FROM cooldown_cart WHERE id = ?').get(Number(itemId));
}

function resolveCooldownItem(db, itemId, decision) {
  const item = db.prepare('SELECT * FROM cooldown_cart WHERE id = ?').get(Number(itemId));
  if (!item) throw new Error('找不到該筆冷靜池商品');

  const nowIso = new Date().toISOString();
  const status = String(decision).toUpperCase() === 'PURCHASE' ? 'PURCHASED' : 'ABANDONED';
  db.prepare('UPDATE cooldown_cart SET status = ?, resolved_at = ? WHERE id = ?').run(status, nowIso, item.id);

  return {
    resolvedItem: db.prepare('SELECT * FROM cooldown_cart WHERE id = ?').get(item.id),
    summary: getCooldownCartSummary(db, nowIso)
  };
}
function getVampireAndSubscriptionRadar(db, referenceDateStr) {
  const refDate = (referenceDateStr || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const refMs = new Date(`${refDate}T00:00:00`).getTime();
  const sevenDaysAgoStr = new Date(refMs - 6 * 86400000).toISOString().slice(0, 10);

  const smallTxs = db.prepare(`
    SELECT * FROM transactions
    WHERE status IN ('PENDING', 'SETTLED')
      AND effective_amount > 0 AND effective_amount < 200
      AND tx_date >= ? AND tx_date <= ?
    ORDER BY tx_date DESC, id DESC
  `).all(sevenDaysAgoStr, refDate);

  const byGroup = new Map();
  for (const tx of smallTxs) {
    const key = tx.normalized_merchant || tx.category;
    if (!byGroup.has(key)) {
      byGroup.set(key, { name: key, category: tx.category, count: 0, totalAmount: 0, items: [] });
    }
    const g = byGroup.get(key);
    g.count += 1;
    g.totalAmount += Number(tx.effective_amount);
    g.items.push({ id: tx.id, date: tx.tx_date, amount: tx.effective_amount, rawMerchant: tx.raw_merchant });
  }

  const leaderboard = [...byGroup.values()]
    .map(g => ({ ...g, isVampireAlert: g.count > 4, isWarning: g.count >= 3 }))
    .sort((a, b) => b.count - a.count || b.totalAmount - a.totalAmount);

  const totalSmallCount = smallTxs.length;
  const totalSmallAmount = smallTxs.reduce((s, t) => s + Number(t.effective_amount), 0);

  const fixedList = db.prepare('SELECT * FROM fixed_expenses WHERE is_active = 1 ORDER BY billing_day ASC').all();
  const currentDay = Number(refDate.slice(8, 10));
  const metrics = getSurvivalDashboardMetrics(db, refDate);
  const estNetPay = Math.max(0, Number(metrics.budget.effectiveIncome) || Number(metrics.cycle.estimatedNetPay) || 0);

  const subscriptionAlerts = [];
  for (const exp of fixedList) {
    let diffDays = exp.billing_day - currentDay;
    if (diffDays < 0) diffDays += 30;
    exp.daysUntilBilling = diffDays;
    exp.preBillingAlert = (exp.expense_type === 'SUBSCRIPTION' && diffDays <= 3);
    if (exp.preBillingAlert) {
      subscriptionAlerts.push(
        `🔔 訂閱守門員提醒：【${exp.name} ($${exp.monthly_amount}/月)】將在 ${diffDays === 0 ? '今天' : diffDays + ' 天後'}（每月 ${exp.billing_day} 號）扣款，請考慮是否取消訂閱！`
      );
    }
  }

  const futureMonths = [1, 2, 3].map(offset => {
    const dt = new Date(refMs);
    dt.setMonth(dt.getMonth() + offset);
    const ym = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    let installmentAmt = 0, fixedSubAmt = 0;
    for (const exp of fixedList) {
      if (exp.expense_type === 'INSTALLMENT') {
        if ((exp.remaining_installments || 0) >= offset) installmentAmt += Number(exp.monthly_amount);
      } else {
        fixedSubAmt += Number(exp.monthly_amount);
      }
    }
    const lockedTotal = installmentAmt + fixedSubAmt;
    const preemptedPercent = estNetPay > 0
      ? Number(((lockedTotal / estNetPay) * 100).toFixed(1))
      : (lockedTotal > 0 ? 100 : 0);
    return {
      monthOffset: offset, yearMonth: ym, estimatedNetSalary: estNetPay,
      installmentAmount: installmentAmt, fixedAndSubAmount: fixedSubAmt,
      totalLockedAmount: lockedTotal, freeDisposableAmount: Math.max(0, estNetPay - lockedTotal),
      preemptedPercent,
      warningText: `${ym} 月份還沒開始，你的薪水已經被預支了 ${preemptedPercent}%（分期 $${installmentAmt} ＋ 固定/訂閱 $${fixedSubAmt}）！`
    };
  });

  return {
    vampireRadar: {
      windowStart: sevenDaysAgoStr, windowEnd: refDate,
      totalSmallTxCount: totalSmallCount, totalSmallTxAmount: totalSmallAmount,
      isOverallVampireTriggered: totalSmallCount > 4,
      overallAlertText: totalSmallCount > 4
        ? `🧛 隱形吸血鬼警報：過去 7 天內你有高達 ${totalSmallCount} 筆低於 $200 的小額消費，不知不覺失血了 $${totalSmallAmount} 元！`
        : null,
      leaderboard
    },
    subscriptionsAndInstallments: { items: fixedList, subscriptionAlerts, futureMonths }
  };
}

module.exports = {
  getHighRiskModeStatus, evaluateImpulsePurchase, getCooldownCartSummary,
  fastForwardCooldownItem, resolveCooldownItem, getVampireAndSubscriptionRadar
};


