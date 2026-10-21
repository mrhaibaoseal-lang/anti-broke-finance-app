'use strict';

let dashboardState = null;
let currentTxFilter = 'ALL';
let selectedImpulseType = 'WANT';

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const fmtMoney = n => '$' + Number(n || 0).toLocaleString();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NOTIFICATION_PRESETS = {
  maixiang_auth: () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return `【玉山銀行】您的玉山簽帳金融卡於 ${today} 在 統一超商 刷卡消費授權 NT$10 元（麥香紅茶圈存）。`;
  },
  maixiang_settle: () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return `【玉山銀行】簽帳卡消費扣款通知：您的帳戶於 ${today} 商店請款扣款「7-ELEVEN」金額 NT$10 元。`;
  },
  linepay_auth: () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return `【玉山Wallet】簽帳金融卡消費授權通知：${today} 於「連加*７－ＥＬＥＶＥＮ」消費 NT$85 元。`;
  },
  linepay_settle: () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return `【玉山銀行】帳戶扣款通知：${today} 簽帳卡消費請款「LINE PAY*統一超商」（原始交易日 ${today}）實際扣款 NT$85 元。`;
  },
  steam_settle: () => {
    const d2 = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return `【玉山銀行】簽帳卡消費扣款：${today} 商店請款「STEAMPOWERED」（原交易日 ${d2}）帳戶扣款 NT$1,023 元（含國外交易手續費）。`;
  },
  gas_settle: () => {
    const d1 = new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return `【玉山銀行】簽帳卡消費扣款：${today}「台灣中油」（原交易日 ${d1}）實際請款扣款 NT$135 元。`;
  },
  verify_1ntd: () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return `【玉山銀行】簽帳金融卡消費授權：${today} 於「優食*UBEREATS」刷卡 NT$1 元（卡片綁定驗證）。`;
  },
  easycard_topup: () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return `【玉山銀行】簽帳金融卡消費授權：${today} 於「悠遊卡自動加值」刷卡消費 NT$500 元。`;
  },
  salary_in: () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return `【玉山銀行】薪資入帳通知：您的玉山帳戶於 ${today} 收到薪資轉帳入帳 NT$24,800 元。`;
  }
};

const SNAPSHOT_STORAGE_KEY = 'anti_broke_cloud_snapshot_v2_clean';
try {
  localStorage.removeItem('anti_broke_cloud_snapshot_v1');
} catch (_) {}

function loadLocalSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function saveLocalSnapshot(snapshot) {
  try {
    if (snapshot && typeof snapshot === 'object' && snapshot.tables) {
      localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
    }
  } catch (_) {}
}

async function apiCall(path, method = 'GET', body = null) {
  const localSnap = loadLocalSnapshot();
  let actualMethod = method;
  let payload = body ? { ...body } : null;

  if (path === '/api/dashboard' && localSnap) {
    actualMethod = 'POST';
    payload = { ...(payload || {}), _clientState: localSnap };
  } else if (actualMethod === 'POST') {
    payload = { ...(payload || {}), _clientState: localSnap };
  }

  const opts = { method: actualMethod, headers: { 'Content-Type': 'application/json' } };
  if (payload) opts.body = JSON.stringify(payload);
  try {
    const res = await fetch(path, opts);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('NON_JSON_RESPONSE');
    }
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || '請求失敗');
    }
    if (data._stateSnapshot) {
      saveLocalSnapshot(data._stateSnapshot);
    }
    return data;
  } catch (err) {
    if (window.AntiBrokeBrowserEngine && (err.message === 'NON_JSON_RESPONSE' || err.name === 'TypeError')) {
      return window.AntiBrokeBrowserEngine.handleLocalApi(path, actualMethod, payload || {});
    }
    throw err;
  }
}
function renderDashboard(state) {
  dashboardState = state;
  const { survival, highRiskMode, ghostHolds, transactions, cooldownCart, radar, splitBills, walletTank, settings } = state;

  document.body.classList.toggle('high-risk-mode', Boolean(highRiskMode.isHighRisk));
  const hrBanner = $('#highRiskBanner');
  if (highRiskMode.isHighRisk) {
    hrBanner.textContent = highRiskMode.warningBanner;
    hrBanner.classList.remove('hidden');
    $('#highRiskBtnLabel').textContent = '高風險防禦開啟中';
  } else {
    hrBanner.classList.add('hidden');
    $('#highRiskBtnLabel').textContent = '模擬高風險模式';
  }

  const alertsHtml = [];
  if (survival.budget.bankruptcyWarningText) {
    alertsHtml.push(`
      <div class="rounded-2xl bg-rose-500/20 border border-rose-500/50 px-4 py-3 text-xs sm:text-sm font-bold text-rose-200 flex items-center justify-between gap-2">
        <span>${esc(survival.budget.bankruptcyWarningText)}</span>
        <span class="shrink-0 px-2 py-0.5 rounded bg-rose-500 text-black text-[11px] font-black">燃燒預警</span>
      </div>
    `);
  }
  for (const gh of (ghostHolds || [])) {
    alertsHtml.push(`
      <div class="rounded-2xl bg-amber-500/15 border border-amber-400/50 px-4 py-2.5 text-xs font-semibold text-amber-200 flex flex-wrap items-center justify-between gap-2">
        <span>${esc(gh.alertText)}</span>
        <button data-cancel-tx="${gh.transactionId}" class="btn-press px-2.5 py-1 rounded-lg bg-amber-400 text-black font-bold text-xs">移入凍結觀察區 (已退單)</button>
      </div>
    `);
  }
  $('#alertStack').innerHTML = alertsHtml.join('');

  const mainCard = $('#survivalMainCard');
  mainCard.className = `lg:col-span-7 glass-card p-5 flex flex-col justify-between tier-glow-${survival.tier.code}`;
  $('#cycleDateLabel').textContent = `${survival.cycle.startDate} ~ ${survival.cycle.endDate}`;
  $('#tierBadge').textContent = `${survival.tier.emoji} ${survival.tier.label}（${survival.tier.rangeText}）`;
  $('#dailySafeAmount').textContent = fmtMoney(survival.budget.dailySafeBudget);
  $('#daysRemainingVal').textContent = survival.cycle.daysRemaining;
  $('#paydayDayVal').textContent = survival.cycle.paydayDay;
  $('#tierAdviceText').textContent = `${survival.tier.emoji} 生存建議：${survival.tier.advice}`;

  $('#metricIncome').textContent = fmtMoney(survival.budget.effectiveIncome);
  $('#metricFixed').textContent = '-' + fmtMoney(survival.budget.fixedAndInstallments);
  $('#metricSpent').textContent = '-' + fmtMoney(survival.budget.totalSpent);
  $('#metricRemaining').textContent = fmtMoney(survival.budget.remainingBudget);
  $('#syncExpectedLabel').textContent = fmtMoney(survival.budget.remainingBudget);

  $('#shiftGrossVal').textContent = fmtMoney(survival.cycle.shiftGrossPay);
  $('#shiftWageVal').textContent = fmtMoney(survival.cycle.hourlyWage);
  $('#shiftHoursVal').textContent = survival.cycle.normalHours;
  $('#netFactorVal').textContent = `×${survival.cycle.netPayFactor}`;
  $('#shiftNetVal').textContent = fmtMoney(survival.budget.effectiveIncome);

  if (survival.cycle.isSalarySettled) {
    $('#salaryStatusBadge').textContent = '✅ 真實薪資已入帳覆蓋';
    $('#salaryStatusBadge').className = 'text-[11px] px-2 py-0.5 rounded-md bg-emerald-500/25 text-emerald-300 font-bold';
    $('#actualSalaryNote').textContent = `已由玉山薪轉入帳 $${survival.cycle.actualSalary.toLocaleString()} 覆蓋預估值`;
  } else {
    $('#salaryStatusBadge').textContent = `唯讀連動 (${survival.cycle.shiftSyncSource})`;
    $('#salaryStatusBadge').className = 'text-[11px] px-2 py-0.5 rounded-md bg-indigo-500/20 text-indigo-300 font-semibold';
    $('#actualSalaryNote').textContent = `原預估實領 $${survival.cycle.estimatedNetPay.toLocaleString()}（收到薪轉自動覆蓋）`;
  }

  $('#todaySpentVal').textContent = fmtMoney(survival.budget.todaySpent);
  $('#pendingSpentVal').textContent = fmtMoney(survival.budget.pendingSpent);
  $('#settledSpentVal').textContent = fmtMoney(survival.budget.settledSpent);
  $('#gapSpentVal').textContent = fmtMoney(survival.budget.gapSpent);

  renderTransactionsList(transactions);
  renderCooldownSection(cooldownCart);
  renderRadarSection(radar);
  renderPatchesSection(walletTank, splitBills);
  renderSettingsSection(settings);
}
function statusLabelOf(status) {
  const map = {
    PENDING: '🟡 圈存中 PENDING (已扣預算)',
    SETTLED: '🟢 已請款結算 SETTLED',
    TEMP_HOLD: '⛽ 特殊預授權 TEMP_HOLD (暫不扣全額)',
    CANCELED: '❄️ 凍結觀察區 CANCELED (退單待解圈)',
    AUTH_VERIFY: '🪪 綁卡驗證 ($1~$2 不扣預算)',
    UNKNOWN_GAP: '🕳️ 未知漏帳黑洞 (餘額校正)'
  };
  return map[status] || status;
}

function renderTransactionsList(transactions = []) {
  const filtered = currentTxFilter === 'ALL'
    ? transactions
    : transactions.filter(t => t.status === currentTxFilter);

  const container = $('#txListContainer');
  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-center py-8 text-xs text-white/40">此篩選條件下尚無交易紀錄</div>`;
    return;
  }

  container.innerHTML = filtered.map(tx => {
    const lockTag = tx.is_reconciled_locked
      ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold"><i class="fa-solid fa-lock mr-0.5"></i>1-to-1 已鎖定${tx.reconcile_score ? ` (${tx.reconcile_score}%)` : ''}</span>`
      : `<span class="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/60">待通道B請款核銷</span>`;

    const fxTag = tx.fx_fee_diff !== 0
      ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 font-bold">海外匯差 ${tx.fx_fee_diff > 0 ? '+' : ''}$${tx.fx_fee_diff}</span>`
      : '';

    const actions = [];
    if (tx.status === 'TEMP_HOLD') {
      actions.push(`<button data-gas-tx="${tx.id}" class="btn-press px-2.5 py-1 rounded-lg bg-sky-500 text-black font-bold text-xs">⛽ 輸入實際加油金額</button>`);
    }
    if (tx.status === 'PENDING' || tx.status === 'SETTLED') {
      actions.push(`<button data-split-tx="${tx.id}" data-split-amt="${tx.effective_amount}" data-split-name="${esc(tx.normalized_merchant)}" class="btn-press px-2.5 py-1 rounded-lg bg-indigo-500/20 border border-indigo-400/40 text-indigo-200 font-semibold text-xs">🤝 幫人代墊/拆帳</button>`);
    }
    if (tx.status === 'PENDING') {
      actions.push(`<button data-cancel-tx="${tx.id}" class="btn-press px-2.5 py-1 rounded-lg bg-white/10 text-white/70 font-semibold text-xs">❄️ 標記退單待解圈</button>`);
    }
    if (tx.status === 'UNKNOWN_GAP') {
      actions.push(`<button data-gap-tx="${tx.id}" data-gap-amt="${tx.personal_amount}" class="btn-press px-2.5 py-1 rounded-lg bg-rose-500 text-black font-bold text-xs">✨ 拆分補齊黑洞明細</button>`);
    }

    return `
      <div class="rounded-2xl bg-white/5 border border-white/10 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="space-y-1 min-w-0">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-[11px] font-bold px-2 py-0.5 rounded-md badge-${tx.status}">${statusLabelOf(tx.status)}</span>
            ${lockTag}
            ${fxTag}
            <span class="text-xs text-white/40 tabular-nums"><i class="fa-regular fa-calendar mr-1"></i>原始刷卡日：${esc(tx.tx_date)}</span>
          </div>
          <div class="text-sm font-extrabold text-white flex flex-wrap items-center gap-2">
            <span>${esc(tx.normalized_merchant)}</span>
            ${tx.raw_merchant !== tx.normalized_merchant ? `<span class="text-xs font-normal text-white/40">（原始店名：${esc(tx.raw_merchant)}）</span>` : ''}
            <span class="text-[11px] px-2 py-0.5 rounded bg-white/10 text-white/70 font-medium">${esc(tx.category)}</span>
          </div>
          <div class="text-xs text-white/60">${esc(tx.reconcile_note || '')}</div>
        </div>

        <div class="flex sm:flex-col items-end justify-between gap-2 shrink-0">
          <div class="text-right">
            <div class="text-lg font-black tabular-nums ${tx.personal_amount > 0 ? 'text-rose-400' : 'text-white/40'}">
              ${tx.personal_amount > 0 ? '-' + fmtMoney(tx.personal_amount) : '$0 (不扣個人預算)'}
            </div>
            <div class="text-[11px] text-white/40 tabular-nums">
              圈存 $${tx.auth_amount}${tx.settled_amount !== null ? ` · 請款 $${tx.settled_amount}` : ''}
            </div>
          </div>
          <div class="flex flex-wrap gap-1.5">${actions.join('')}</div>
        </div>
      </div>
    `;
  }).join('');
}
function renderCooldownSection(cooldownCart) {
  if (!cooldownCart) return;
  const ach = cooldownCart.achievement || {};
  $('#achieveBadgeTitle').textContent = ach.badgeTitle || '🏆 防剁手省錢成就榜';
  $('#savedTotalVal').textContent = fmtMoney(ach.totalSavedAmount || 0);
  $('#savedHoursVal').textContent = ach.totalSavedHours || 0;
  $('#savedCountVal').textContent = ach.abandonedCount || 0;

  const list = [...(cooldownCart.activeItems || []), ...(cooldownCart.abandonedItems || []).slice(0, 3)];
  const container = $('#cooldownListContainer');
  if (list.length === 0) {
    container.innerHTML = `<div class="text-center py-8 text-xs text-white/40">目前冷靜池沒有商品，左側評估器輸入「想要 (Want)」商品即會強制鎖入 72 小時！</div>`;
    return;
  }

  container.innerHTML = list.map(item => {
    if (item.status === 'ABANDONED') {
      return `
        <div class="rounded-2xl bg-emerald-500/10 border border-emerald-500/30 p-3.5 flex items-center justify-between">
          <div>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500 text-black">🏆 已成功放棄購買（省下血汗錢！）</span>
            <div class="text-sm font-bold text-white mt-1">${esc(item.item_name)} <span class="text-emerald-300">${fmtMoney(item.amount)}</span></div>
            <div class="text-xs text-white/50">成功拯救了 ${esc(item.work_time_text)} 的排班工時！</div>
          </div>
          <div class="text-2xl">🎉</div>
        </div>
      `;
    }

    const isUnlocked = item.status === 'UNLOCKED';
    return `
      <div class="rounded-2xl ${isUnlocked ? 'bg-amber-500/15 border-amber-400/50' : 'bg-white/5 border-white/10'} border p-3.5 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-extrabold ${isUnlocked ? 'text-amber-300' : 'text-rose-300'}">
            ${isUnlocked ? '🔓 已滿 72 小時解鎖！請做最終決定' : `🔒 72h 冷靜期鎖定中（剩餘 ${item.remainingHours} 小時）`}
          </span>
          <span class="text-sm font-black text-white tabular-nums">${fmtMoney(item.amount)}</span>
        </div>
        <div class="text-sm font-bold text-white">${esc(item.item_name)} <span class="text-xs font-normal text-white/50">｜需站班表 ${esc(item.work_time_text)}</span></div>
        <div class="text-xs text-white/60">當初理由：「${esc(item.reason || '無')}」｜買後吃土等級：${esc(item.tier_after)}</div>
        ${isUnlocked ? `<div class="text-xs font-bold text-amber-200 bg-black/30 p-2 rounded-lg">${esc(item.unlockPrompt)}</div>` : ''}
        <div class="flex flex-wrap gap-2 pt-1">
          <button data-cd-resolve="${item.id}|ABANDON" class="btn-press flex-1 py-2 rounded-xl bg-emerald-500 text-black font-extrabold text-xs">
            💪 放棄購買（省下 ${fmtMoney(item.amount)} 計入成就榜！）
          </button>
          ${!isUnlocked ? `
            <button data-cd-ff="${item.id}" class="btn-press px-3 py-2 rounded-xl bg-white/10 text-white/80 font-bold text-xs">
              ⏩ 模擬滿72h
            </button>
          ` : `
            <button data-cd-resolve="${item.id}|PURCHASE" class="btn-press px-3 py-2 rounded-xl bg-rose-500/25 border border-rose-500/40 text-rose-200 font-bold text-xs">
              仍要購買
            </button>
          `}
        </div>
      </div>
    `;
  }).join('');
}
function renderRadarSection(radar) {
  if (!radar) return;
  const vr = radar.vampireRadar || {};
  const sub = radar.subscriptionsAndInstallments || {};

  const vBanner = $('#vampireAlertBanner');
  if (vr.overallAlertText) {
    vBanner.textContent = vr.overallAlertText;
    vBanner.classList.remove('hidden');
  } else {
    vBanner.classList.add('hidden');
  }

  const lb = $('#vampireLeaderboard');
  if (!vr.leaderboard || vr.leaderboard.length === 0) {
    lb.innerHTML = `<div class="text-center py-6 text-xs text-white/40">本週尚無單筆低於 $200 的小額消費</div>`;
  } else {
    lb.innerHTML = vr.leaderboard.map((g, idx) => `
      <div class="rounded-xl ${g.isVampireAlert ? 'bg-rose-500/20 border-rose-500/50' : 'bg-white/5 border-white/10'} border p-3 flex items-center justify-between">
        <div>
          <div class="text-xs font-extrabold text-white flex items-center gap-1.5">
            <span class="px-1.5 py-0.5 rounded bg-white/10 text-[10px]">#${idx + 1}</span>
            <span>${esc(g.name)}</span>
            ${g.isVampireAlert ? '<span class="px-1.5 py-0.5 rounded bg-rose-500 text-black text-[10px] font-black">🧛 高頻失血 (>4次)</span>' : ''}
          </div>
          <div class="text-[11px] text-white/50 mt-0.5">7 天內出現 <b>${g.count}</b> 次 · 分類：${esc(g.category)}</div>
        </div>
        <div class="text-right">
          <div class="text-sm font-black text-rose-300 tabular-nums">-${fmtMoney(g.totalAmount)}</div>
        </div>
      </div>
    `).join('');
  }

  $('#subAlertsWrap').innerHTML = (sub.subscriptionAlerts || []).map(a => `
    <div class="rounded-xl bg-amber-500/15 border border-amber-400/40 p-2.5 text-xs font-bold text-amber-200">${esc(a)}</div>
  `).join('');

  $('#futureSalaryBars').innerHTML = (sub.futureMonths || []).map(fm => `
    <div class="rounded-xl bg-black/40 border border-white/10 p-3 space-y-1.5">
      <div class="flex items-center justify-between text-xs">
        <span class="font-bold text-white">${esc(fm.warningText)}</span>
        <span class="font-mono text-amber-300 font-bold">${fm.preemptedPercent}% 已預支</span>
      </div>
      <div class="w-full h-3 rounded-full bg-white/10 overflow-hidden flex">
        <div class="bg-rose-500 h-full" style="width:${Math.min(100, fm.preemptedPercent)}%"></div>
      </div>
      <div class="flex justify-between text-[11px] text-white/50 tabular-nums">
        <span>已鎖定扣款：${fmtMoney(fm.totalLockedAmount)}</span>
        <span>預估可自由支配：${fmtMoney(fm.freeDisposableAmount)} / ${fmtMoney(fm.estimatedNetSalary)}</span>
      </div>
    </div>
  `).join('');

  $('#fixedExpenseList').innerHTML = (sub.items || []).map(exp => `
    <div class="rounded-xl bg-white/5 border border-white/10 px-3 py-2 flex items-center justify-between text-xs">
      <div>
        <span class="font-bold text-white">${esc(exp.name)}</span>
        <span class="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/70">${esc(exp.expense_type)}</span>
        <span class="text-white/50 ml-1">每月 ${exp.billing_day} 號扣款${exp.remaining_installments ? ` · 剩餘 ${exp.remaining_installments} 期` : ''}</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="font-extrabold text-amber-300 tabular-nums">${fmtMoney(exp.monthly_amount)}/月</span>
        <button data-del-fixed="${exp.id}" class="text-rose-400 hover:text-rose-300 px-1.5">✕</button>
      </div>
    </div>
  `).join('');
}
function renderPatchesSection(walletTank, splitBills) {
  if (walletTank) {
    $('#tankEasycardVal').textContent = fmtMoney(walletTank.easycardBalance);
    $('#tankCashVal').textContent = fmtMoney(walletTank.cashBalance);
    const banner = $('#tankAuditBanner');
    if (walletTank.needsAuditAlert && walletTank.auditAlertText) {
      banner.textContent = walletTank.auditAlertText;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
    $('#tankLogsList').innerHTML = (walletTank.logs || []).map(l => `
      <div class="flex items-center justify-between text-xs bg-white/5 rounded-lg px-2.5 py-1.5">
        <span class="text-white/70">[${l.tank_type === 'EASYCARD' ? '悠遊卡' : '現金'}] ${esc(l.note)}</span>
        <span class="font-bold tabular-nums ${l.delta_amount >= 0 ? 'text-emerald-300' : 'text-rose-300'}">${l.delta_amount >= 0 ? '+' : ''}${l.delta_amount} (餘 $${l.balance_after})</span>
      </div>
    `).join('');
  }

  if (splitBills) {
    $('#receivableTotalVal').textContent = fmtMoney(splitBills.pendingReceivableTotal);
    const container = $('#splitBillsList');
    if (!splitBills.items || splitBills.items.length === 0) {
      container.innerHTML = `<div class="text-center py-8 text-xs text-white/40">尚無代墊拆帳紀錄。可於交易明細旁點選「🤝 幫人代墊/拆帳」新增！</div>`;
    } else {
      container.innerHTML = splitBills.items.map(s => `
        <div class="rounded-xl bg-white/5 border border-white/10 p-3 flex items-center justify-between gap-2">
          <div class="text-xs space-y-0.5">
            <div class="font-bold text-white">${esc(s.normalized_merchant || '聚餐消費')} · 刷卡總額 ${fmtMoney(s.total_amount)}</div>
            <div class="text-white/60">自己負擔 ${fmtMoney(s.self_amount)} ｜ 應收代墊 <b class="text-amber-300">${fmtMoney(s.receivable_amount)}</b>（欠款人：${esc(s.debtor_name)}）</div>
          </div>
          <div>
            ${s.is_repaid
              ? `<span class="px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-bold">✅ 已收款結清</span>`
              : `<button data-settle-split="${s.id}" class="btn-press px-3 py-1.5 rounded-xl bg-emerald-500 text-black font-extrabold text-xs">勾選已收款結清</button>`
            }
          </div>
        </div>
      `).join('');
    }
  }
}

function renderSettingsSection(settings) {
  if (!settings) return;
  $('#setPayday').value = settings.payday_day;
  $('#setNetFactor').value = settings.net_pay_factor;
  $('#setLaborDeduct').value = settings.labor_health_deduction;
  $('#setShiftPath').value = settings.shift_app_path;
  $('#setGmailUser').value = settings.gmail_user || '';
}
document.addEventListener('DOMContentLoaded', async () => {
  const whDisplay = $('#webhookUrlDisplay');
  if (whDisplay && window.location?.origin) {
    whDisplay.textContent = `POST ${window.location.origin}/api/notifications/webhook`;
  }
  try {
    const data = await apiCall('/api/dashboard');
    renderDashboard(data);
  } catch (err) {
    console.error(err);
  }

  $$('[data-nav-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.navTab;
      $$('[data-nav-tab]').forEach(b => {
        const active = b.dataset.navTab === target;
        b.className = `nav-tab-btn btn-press shrink-0 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold ${active ? 'bg-cyan-500 text-black shadow' : 'bg-white/5 text-white/70'}`;
      });
      $$('.tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${target}`));
    });
  });

  $('#presetButtonsWrap').addEventListener('click', e => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const fn = NOTIFICATION_PRESETS[b.dataset.preset];
    if (fn) $('#notifInput').value = fn();
  });

  $('#btnParseNotif').addEventListener('click', async () => {
    const text = $('#notifInput').value.trim();
    if (!text) return alert('請先貼上通知文字或點選上方測試範本！');
    try {
      const res = await apiCall('/api/notifications/parse', 'POST', { text });
      const box = $('#notifResultBox');
      box.classList.remove('hidden');
      box.className = 'rounded-xl p-3.5 text-xs sm:text-sm border bg-emerald-500/15 border-emerald-400/40 text-emerald-200 font-semibold';
      box.textContent = `【${res.result.resultType}】${res.result.message}`;
      renderDashboard(res.dashboard);
    } catch (err) {
      alert(err.message);
    }
  });

  $('#txFilterBar').addEventListener('click', e => {
    const b = e.target.closest('[data-tx-filter]');
    if (!b) return;
    currentTxFilter = b.dataset.txFilter;
    $$('#txFilterBar [data-tx-filter]').forEach(btn => {
      const on = btn.dataset.txFilter === currentTxFilter;
      btn.className = `btn-press px-3 py-1 rounded-lg text-xs font-bold ${on ? 'bg-white text-black' : 'bg-white/5 text-white/70'}`;
    });
    if (dashboardState) renderTransactionsList(dashboardState.transactions);
  });

  document.body.addEventListener('click', async e => {
    const gasBtn = e.target.closest('[data-gas-tx]');
    if (gasBtn) {
      const amt = prompt('請輸入本次實際加油金額 (NT$)：', '135');
      if (amt === null) return;
      const res = await apiCall('/api/transactions/gas-resolve', 'POST', { txId: gasBtn.dataset.gasTx, actualAmount: Number(amt) });
      renderDashboard(res.dashboard);
      return;
    }

    const splitBtn = e.target.closest('[data-split-tx]');
    if (splitBtn) {
      const total = Number(splitBtn.dataset.splitAmt) || 0;
      const selfAmt = prompt(`【朋友聚餐一鍵拆帳】\n本筆「${splitBtn.dataset.splitName}」刷卡總額 $${total}。\n請輸入「你自己實際負擔」的金額 (NT$)：`, String(Math.round(total / 4)));
      if (selfAmt === null) return;
      const debtor = prompt('請輸入欠款朋友名單與備註：', '朋友聚餐代墊') || '朋友代墊';
      const res = await apiCall('/api/transactions/split', 'POST', {
        transactionId: Number(splitBtn.dataset.splitTx),
        selfAmount: Number(selfAmt),
        debtorName: debtor
      });
      renderDashboard(res.dashboard);
      return;
    }

    const cancelBtn = e.target.closest('[data-cancel-tx]');
    if (cancelBtn) {
      const reason = prompt('請輸入取消訂單/退單原因（將移入凍結觀察區，待玉山解圈）：', '網購取消訂單待解圈');
      if (reason === null) return;
      const res = await apiCall('/api/transactions/cancel', 'POST', { txId: Number(cancelBtn.dataset.cancelTx), reason });
      renderDashboard(res.dashboard);
      return;
    }

    const gapBtn = e.target.closest('[data-gap-tx]');
    if (gapBtn) {
      const gapAmt = Number(gapBtn.dataset.gapAmt) || 0;
      const merchant = prompt(`補齊未知漏帳黑洞 ($${gapAmt}) 明細名稱：`, '忘記記帳之餐飲消費');
      if (!merchant) return;
      const res = await apiCall('/api/balance/split-gap', 'POST', {
        gapTxId: Number(gapBtn.dataset.gapTx),
        items: [{ merchant, amount: gapAmt, category: '餐飲外食' }]
      });
      renderDashboard(res.dashboard);
      return;
    }
    const cdFf = e.target.closest('[data-cd-ff]');
    if (cdFf) {
      const res = await apiCall('/api/cooldown/fast-forward', 'POST', { itemId: Number(cdFf.dataset.cdFf) });
      renderDashboard(res.dashboard);
      return;
    }

    const cdResolve = e.target.closest('[data-cd-resolve]');
    if (cdResolve) {
      const [itemId, decision] = cdResolve.dataset.cdResolve.split('|');
      const res = await apiCall('/api/cooldown/resolve', 'POST', { itemId: Number(itemId), decision });
      renderDashboard(res.dashboard);
      return;
    }

    const delFixed = e.target.closest('[data-del-fixed]');
    if (delFixed) {
      const res = await apiCall('/api/fixed-expenses/delete', 'POST', { id: Number(delFixed.dataset.delFixed) });
      renderDashboard(res.dashboard);
      return;
    }

    const tankQuick = e.target.closest('[data-tank-quick]');
    if (tankQuick) {
      const [tankType, deltaAmount, note] = tankQuick.dataset.tankQuick.split('|');
      const res = await apiCall('/api/wallet-tank/adjust', 'POST', { tankType, deltaAmount: Number(deltaAmount), note });
      renderDashboard(res.dashboard);
      return;
    }

    const settleSplit = e.target.closest('[data-settle-split]');
    if (settleSplit) {
      const res = await apiCall('/api/split-bills/settle', 'POST', { splitBillId: Number(settleSplit.dataset.settleSplit) });
      renderDashboard(res.dashboard);
      return;
    }

    const closeModal = e.target.closest('[data-close-modal]');
    if (closeModal) {
      document.getElementById(closeModal.dataset.closeModal)?.classList.add('hidden');
    }
  });

  $$('[data-imp-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedImpulseType = btn.dataset.impType;
      $$('[data-imp-type]').forEach(b => {
        const on = b.dataset.impType === selectedImpulseType;
        b.className = `imp-type-btn btn-press py-2.5 rounded-xl text-xs font-extrabold ${on ? (selectedImpulseType === 'WANT' ? 'bg-rose-500 text-white' : 'bg-emerald-500 text-black') : 'bg-white/5 text-white/60'}`;
      });
    });
  });

  $('#btnEvaluateImpulse').addEventListener('click', async () => {
    const itemName = $('#impItemName').value.trim();
    const amount = Number($('#impAmount').value);
    const reason = $('#impReason').value.trim();
    if (!itemName || !amount) return alert('請輸入商品名稱與金額！');

    try {
      const res = await apiCall('/api/impulse/evaluate', 'POST', {
        itemName, amount, reason, itemType: selectedImpulseType, addToCart: true
      });
      const ev = res.evaluation;
      const out = $('#impulseEvalOutput');
      out.classList.remove('hidden');
      out.innerHTML = `
        <div class="text-sm font-black text-rose-300">⏱️ ${esc(ev.sweatWork.text)}</div>
        <div class="text-xs font-bold text-amber-200">📉 ${esc(ev.survivalImpact.text)}</div>
        <div class="text-xs text-white/90 whitespace-pre-line leading-relaxed bg-white/5 p-3 rounded-xl border border-white/10">${esc(ev.aiRoastMessage)}</div>
        <div class="text-xs font-extrabold ${ev.lockedIn72hPool ? 'text-amber-300' : 'text-emerald-300'}">
          ${ev.lockedIn72hPool ? '🔒 已強制鎖入右側「72 小時冷靜期購物車」，禁止當下購買！' : '✅ 評估完成'}
        </div>
      `;
      renderDashboard(res.dashboard);
    } catch (err) {
      alert(err.message);
    }
  });
  $('#btnAddFixedExpense').addEventListener('click', async () => {
    const name = $('#fxName').value.trim();
    const expenseType = $('#fxType').value;
    const monthlyAmount = Number($('#fxAmount').value);
    const billingDay = Number($('#fxDay').value) || 15;
    const remainingInstallments = Number($('#fxRemain').value) || 6;
    if (!name || !monthlyAmount) return alert('請輸入項目名稱與每月金額！');

    const res = await apiCall('/api/fixed-expenses', 'POST', {
      name, expenseType, monthlyAmount, billingDay, totalInstallments: remainingInstallments, remainingInstallments
    });
    $('#fxName').value = '';
    $('#fxAmount').value = '';
    renderDashboard(res.dashboard);
  });

  $('#btnAuditTank').addEventListener('click', async () => {
    const easyVal = $('#auditEasyInput').value;
    const cashVal = $('#auditCashInput').value;
    const res = await apiCall('/api/wallet-tank/audit', 'POST', {
      easycardBalance: easyVal !== '' ? Number(easyVal) : undefined,
      cashBalance: cashVal !== '' ? Number(cashVal) : undefined
    });
    $('#auditEasyInput').value = '';
    $('#auditCashInput').value = '';
    renderDashboard(res.dashboard);
  });

  $('#btnOpenShiftSync').addEventListener('click', () => {
    if (dashboardState?.survival?.budget?.effectiveIncome > 0) {
      $('#manualNetSalaryInput').value = dashboardState.survival.budget.effectiveIncome;
    }
    if (dashboardState?.survival?.cycle?.hourlyWage) {
      $('#manualHourlyWageInput').value = dashboardState.survival.cycle.hourlyWage;
    }
    $('#modalShiftSync').classList.remove('hidden');
  });
  $('#btnOpenBalanceSync').addEventListener('click', () => $('#modalBalanceSync').classList.remove('hidden'));

  $('#btnConfirmShiftSync').addEventListener('click', async () => {
    const manualNetSalary = $('#manualNetSalaryInput').value.trim();
    const manualHourlyWage = $('#manualHourlyWageInput').value.trim();
    const raw = $('#shiftJsonInput').value.trim();
    try {
      const res = await apiCall('/api/shift/sync', 'POST', {
        manualNetSalary: manualNetSalary !== '' ? Number(manualNetSalary) : null,
        manualHourlyWage: manualHourlyWage !== '' ? Number(manualHourlyWage) : null,
        rawJsonPayload: raw || null
      });
      $('#modalShiftSync').classList.add('hidden');
      alert(res.message);
      renderDashboard(res.dashboard);
    } catch (err) {
      alert('薪資設定失敗：' + err.message);
    }
  });

  $('#btnConfirmBalanceSync').addEventListener('click', async () => {
    const val = $('#actualEsunInput').value;
    if (val === '') return alert('請輸入玉山 Wallet 可用餘額！');
    try {
      const res = await apiCall('/api/balance/sync', 'POST', { actualEsunBalance: Number(val) });
      $('#modalBalanceSync').classList.add('hidden');
      $('#actualEsunInput').value = '';
      alert(res.syncResult.message);
      renderDashboard(res.dashboard);
    } catch (err) {
      alert(err.message);
    }
  });

  $('#btnToggleHighRisk').addEventListener('click', async () => {
    const cur = dashboardState?.settings?.force_high_risk_mode ? 0 : 1;
    const res = await apiCall('/api/settings', 'POST', { forceHighRiskMode: cur });
    renderDashboard(res.dashboard);
  });

  $('#btnSaveSettings').addEventListener('click', async () => {
    const res = await apiCall('/api/settings', 'POST', {
      paydayDay: Number($('#setPayday').value),
      netPayFactor: Number($('#setNetFactor').value),
      laborHealthDeduction: Number($('#setLaborDeduct').value),
      shiftAppPath: $('#setShiftPath').value.trim(),
      gmailUser: $('#setGmailUser').value.trim(),
      gmailAppPassword: $('#setGmailPass').value.trim()
    });
    alert('✅ 設定已儲存並重算當月生存額度！');
    renderDashboard(res.dashboard);
  });

  $('#btnPollGmail').addEventListener('click', async () => {
    const res = await apiCall('/api/notifications/gmail-poll', 'POST', {});
    alert(res.imap.message);
  });

  $('#btnResetDemo').addEventListener('click', async () => {
    const res = await apiCall('/api/demo/reset', 'POST', { withDemoData: true });
    renderDashboard(res.dashboard);
  });

  $('#btnClearAllData').addEventListener('click', async () => {
    if (!confirm('確定要清空所有交易紀錄，從空白帳本開始嗎？')) return;
    const res = await apiCall('/api/demo/reset', 'POST', { withDemoData: false });
    renderDashboard(res.dashboard);
  });
});








