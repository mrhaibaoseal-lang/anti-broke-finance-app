'use strict';

let dashboardState = null;
let currentTxFilter = 'ALL';
let selectedImpulseType = 'WANT';

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const fmtMoney = n => '$' + Number(n || 0).toLocaleString();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NOTIFICATION_PRESETS = {
  credit_ubear: () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return `【消費通知】您的玉山Ｕ Bear信用卡(末四碼1234)於 ${today} 14:25 在「連加*麥當勞」一般消費 新臺幣 165.00 元，實際請款金額以帳單為準。`;
  },
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
    hrBanner.textContent = '🌙 深夜 / 發薪後 72h 高風險防禦開啟中';
    hrBanner.classList.remove('hidden');
    $('#highRiskBtnLabel').textContent = '防禦中';
  } else {
    hrBanner.classList.add('hidden');
    $('#highRiskBtnLabel').textContent = '夜間防禦';
  }

  const alertsHtml = [];
  if (survival.budget.bankruptcyWarningText) {
    alertsHtml.push(`
      <div class="rounded-2xl bg-rose-50 border border-rose-200 px-4 py-2.5 text-xs font-semibold text-rose-700 flex items-center justify-between gap-2">
        <span>⚠️ ${esc(survival.budget.bankruptcyWarningText)}</span>
      </div>
    `);
  }
  for (const gh of (ghostHolds || [])) {
    alertsHtml.push(`
      <div class="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-2.5 text-xs font-medium text-amber-800 flex items-center justify-between gap-2">
        <span>👻 ${esc(gh.merchant)} $${gh.amount} 逾 ${gh.ageDays} 天未請款</span>
        <button data-cancel-tx="${gh.transactionId}" class="btn-press shrink-0 px-2.5 py-1 rounded-full bg-amber-200/70 text-amber-900 font-semibold text-[11px]">退單解圈</button>
      </div>
    `);
  }
  $('#alertStack').innerHTML = alertsHtml.join('');

  const mainCard = $('#survivalMainCard');
  mainCard.className = `bento-card p-6 space-y-5 tier-glow-${survival.tier.code}`;
  $('#cycleDateLabel').textContent = `${survival.cycle.startDate.slice(5)} ~ ${survival.cycle.endDate.slice(5)}`;
  $('#tierBadge').textContent = `${survival.tier.emoji} ${survival.tier.label}`;
  $('#dailySafeAmount').textContent = fmtMoney(survival.budget.dailySafeBudget);
  $('#daysRemainingVal').textContent = survival.cycle.daysRemaining;
  $('#paydayDayVal').textContent = survival.cycle.paydayDay;
  $('#tierAdviceText').textContent = `${survival.tier.emoji} ${survival.tier.advice}`;

  $('#metricIncome').textContent = fmtMoney(survival.budget.effectiveIncome);
  $('#metricFixed').textContent = '-' + fmtMoney(survival.budget.fixedAndInstallments);
  $('#metricSpent').textContent = fmtMoney(survival.budget.totalSpent);
  $('#metricRemaining').textContent = fmtMoney(survival.budget.remainingBudget);
  $('#syncExpectedLabel').textContent = fmtMoney(survival.budget.remainingBudget);

  $('#shiftGrossVal').textContent = fmtMoney(survival.cycle.shiftGrossPay);
  $('#shiftWageVal').textContent = fmtMoney(survival.cycle.hourlyWage);
  $('#shiftHoursVal').textContent = survival.cycle.normalHours;
  $('#netFactorVal').textContent = `×${survival.cycle.netPayFactor}`;
  $('#shiftNetVal').textContent = fmtMoney(survival.budget.effectiveIncome);

  if (survival.cycle.isSalarySettled) {
    $('#actualSalaryNote').textContent = `實領薪資 $${Number(survival.cycle.actualSalary || 0).toLocaleString()}`;
  } else {
    $('#actualSalaryNote').textContent = `預估實領 $${Number(survival.cycle.estimatedNetPay || 0).toLocaleString()} (×${survival.cycle.netPayFactor})`;
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
    PENDING: '🟡 圈存預扣',
    SETTLED: '🟢 已結算',
    TEMP_HOLD: '⛽ 預授權',
    CANCELED: '❄️ 已退單',
    AUTH_VERIFY: '🪪 綁卡驗證',
    UNKNOWN_GAP: '🕳️ 待查黑洞'
  };
  return map[status] || status;
}

function renderTransactionsList(transactions = []) {
  const filtered = currentTxFilter === 'ALL'
    ? transactions
    : transactions.filter(t => t.status === currentTxFilter);

  const container = $('#txListContainer');
  if (filtered.length === 0) {
    container.innerHTML = `<div class="bento-card p-8 text-center text-xs text-slate-400">尚無符合條件的交易紀錄</div>`;
    return;
  }

  container.innerHTML = filtered.map(tx => {
    const lockBadge = tx.is_reconciled_locked
      ? `<span class="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-medium"><i class="fa-solid fa-lock mr-0.5"></i>已核銷</span>`
      : `<span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[11px] font-medium">待請款</span>`;

    const fxBadge = tx.fx_fee_diff !== 0
      ? `<span class="px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 text-[11px] font-medium">匯差 ${tx.fx_fee_diff > 0 ? '+' : ''}$${tx.fx_fee_diff}</span>`
      : '';

    const actions = [];
    if (tx.status === 'TEMP_HOLD') {
      actions.push(`<button data-gas-tx="${tx.id}" class="btn-press px-3 py-1.5 rounded-full bg-sky-600 text-white font-semibold text-xs">⛽ 輸入加油金額</button>`);
    }
    if (tx.status === 'PENDING' || tx.status === 'SETTLED') {
      actions.push(`<button data-split-tx="${tx.id}" data-split-amt="${tx.effective_amount}" data-split-name="${esc(tx.normalized_merchant)}" class="btn-press px-3 py-1.5 rounded-full bg-indigo-50 text-indigo-700 font-semibold text-xs">🤝 聚餐拆帳</button>`);
    }
    if (tx.status === 'PENDING') {
      actions.push(`<button data-cancel-tx="${tx.id}" class="btn-press px-3 py-1.5 rounded-full bg-slate-100 text-slate-600 font-semibold text-xs">❄️ 退單解圈</button>`);
    }
    if (tx.status === 'UNKNOWN_GAP') {
      actions.push(`<button data-gap-tx="${tx.id}" data-gap-amt="${tx.personal_amount}" class="btn-press px-3 py-1.5 rounded-full bg-rose-600 text-white font-semibold text-xs">✨ 拆分黑洞</button>`);
    }

    return `
      <details class="group bento-card p-5">
        <summary class="cursor-pointer list-none flex items-center justify-between gap-3">
          <div class="space-y-1.5 min-w-0">
            <div class="text-base font-semibold text-slate-900 truncate">${esc(tx.normalized_merchant)}</div>
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="px-2 py-0.5 rounded-full text-[11px] font-medium badge-${tx.status}">${statusLabelOf(tx.status)}</span>
              ${lockBadge}
              ${fxBadge}
              <span class="text-xs text-slate-400 tabular-nums">${esc(tx.tx_date.slice(5))}</span>
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-lg font-bold tabular-nums ${tx.personal_amount > 0 ? 'text-slate-900' : 'text-slate-400'}">
              ${tx.personal_amount > 0 ? '-' + fmtMoney(tx.personal_amount) : '$0'}
            </div>
            <div class="text-[11px] text-slate-400">細節 <i class="fa-solid fa-chevron-down text-[9px] group-open:rotate-180 transition-transform"></i></div>
          </div>
        </summary>
        <div class="mt-3 pt-3 border-t border-slate-100 space-y-2.5 text-xs text-slate-500">
          <div class="flex flex-wrap justify-between gap-2">
            <span>分類：${esc(tx.category)}</span>
            <span class="tabular-nums">圈存 $${tx.auth_amount}${tx.settled_amount !== null ? ` · 請款 $${tx.settled_amount}` : ''}</span>
          </div>
          ${tx.reconcile_note ? `<div class="bg-slate-50 rounded-xl p-2.5 text-slate-600">${esc(tx.reconcile_note)}</div>` : ''}
          ${actions.length > 0 ? `<div class="flex flex-wrap gap-2 pt-1">${actions.join('')}</div>` : ''}
        </div>
      </details>
    `;
  }).join('');
}

function renderCooldownSection(cooldownCart) {
  if (!cooldownCart) return;
  const ach = cooldownCart.achievement || {};
  $('#achieveBadgeTitle').textContent = ach.badgeTitle || '🌱 防衝動覺醒者';
  $('#savedTotalVal').textContent = fmtMoney(ach.totalSavedAmount || 0);
  $('#savedHoursVal').textContent = ach.totalSavedHours || 0;
  $('#savedCountVal').textContent = ach.abandonedCount || 0;

  const container = $('#cooldownListContainer');
  const list = [...(cooldownCart.activeItems || []), ...(cooldownCart.abandonedItems || [])];

  if (list.length === 0) {
    container.innerHTML = `<div class="bento-card p-8 text-center text-xs text-slate-400">目前冷卻清單為空，點選「➕ 我又想買東西了」開始防剁手評估</div>`;
    return;
  }

  container.innerHTML = list.map(item => {
    const coffeeCups = Math.max(1, Math.round((Number(item.amount) || 0) / 65));
    const hoursNum = Number(item.work_hours_equivalent || 0).toFixed(1);

    if (item.status === 'ABANDONED') {
      return `
        <div class="bento-card p-5 flex items-center justify-between gap-3 border-emerald-100">
          <div class="space-y-1.5 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-base font-semibold text-slate-900 truncate">${esc(item.item_name)}</span>
              <span class="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-semibold">🏆 已忍住不買</span>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <span class="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-medium">⏱️ 省下 ${hoursNum}h 工時</span>
              <span class="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[11px] font-medium">☕ ${coffeeCups} 杯咖啡</span>
            </div>
          </div>
          <div class="text-xl font-bold text-emerald-600 tabular-nums shrink-0">+${fmtMoney(item.amount)}</div>
        </div>
      `;
    }

    const isUnlocked = item.status === 'UNLOCKED';
    return `
      <div class="bento-card p-5 space-y-3 ${isUnlocked ? 'border-amber-200' : ''}">
        <div class="flex items-start justify-between gap-3">
          <div class="space-y-1.5 min-w-0">
            <div class="text-base font-semibold text-slate-900">${esc(item.item_name)}</div>
            <div class="flex flex-wrap gap-1.5">
              <span class="px-2.5 py-0.5 rounded-full ${isUnlocked ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700'} text-[11px] font-semibold">
                ${isUnlocked ? '🔓 已滿 72h 可決定' : `⏳ 倒數 ${item.remainingHours}h`}
              </span>
              <span class="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[11px] font-medium">⏱️ ${hoursNum}h 工時</span>
              <span class="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[11px] font-medium">☕ ${coffeeCups} 杯咖啡</span>
            </div>
          </div>
          <div class="text-xl font-bold text-slate-900 tabular-nums shrink-0">${fmtMoney(item.amount)}</div>
        </div>

        <details class="group">
          <summary class="cursor-pointer list-none text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1">
            <span>查看靈魂拷問與預算衝擊</span>
            <i class="fa-solid fa-chevron-down text-[9px] group-open:rotate-180 transition-transform"></i>
          </summary>
          <div class="mt-2 rounded-2xl bg-slate-50 p-3 text-xs text-slate-600 whitespace-pre-line leading-relaxed border border-slate-100">${esc(item.ai_roast_message)}</div>
        </details>

        <div class="flex gap-2 pt-1">
          <button data-cd-resolve="${item.id}|ABANDON" class="btn-press flex-1 py-2.5 rounded-2xl bg-emerald-600 text-white font-semibold text-xs shadow-xs">
            💪 放棄購買（省下 ${fmtMoney(item.amount)}）
          </button>
          ${!isUnlocked ? `
            <button data-cd-ff="${item.id}" class="btn-press px-3 py-2.5 rounded-2xl bg-slate-100 text-slate-600 font-semibold text-xs">
              ⏩ 滿72h
            </button>
          ` : `
            <button data-cd-resolve="${item.id}|PURCHASE" class="btn-press px-3 py-2.5 rounded-2xl bg-rose-50 text-rose-600 font-semibold text-xs">
              仍要買
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
    lb.innerHTML = `<div class="text-center py-4 text-xs text-slate-400">本週尚無單筆低於 $200 的小額消費</div>`;
  } else {
    lb.innerHTML = vr.leaderboard.map((g, idx) => `
      <div class="rounded-2xl ${g.isVampireAlert ? 'bg-rose-50/70 border-rose-200' : 'bg-slate-50 border-slate-100'} border p-3.5 flex items-center justify-between">
        <div>
          <div class="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
            <span class="px-1.5 py-0.5 rounded-md bg-white border border-slate-200 text-[10px] text-slate-500">#${idx + 1}</span>
            <span>${esc(g.name)}</span>
            ${g.isVampireAlert ? '<span class="px-2 py-0.5 rounded-full bg-rose-600 text-white text-[10px] font-semibold">高頻失血</span>' : ''}
          </div>
          <div class="text-[11px] text-slate-400 mt-0.5">7 天內 ${g.count} 次 · ${esc(g.category)}</div>
        </div>
        <div class="text-sm font-bold text-rose-600 tabular-nums">-${fmtMoney(g.totalAmount)}</div>
      </div>
    `).join('');
  }

  $('#subAlertsWrap').innerHTML = (sub.subscriptionAlerts || []).map(a => `
    <div class="rounded-2xl bg-amber-50 border border-amber-200 px-3.5 py-2.5 text-xs font-semibold text-amber-800">${esc(a)}</div>
  `).join('');

  $('#futureSalaryBars').innerHTML = (sub.futureMonths || []).map(m => {
    const pct = Math.min(100, Math.max(0, Number(m.preemptedPercent) || 0));
    return `
      <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3.5 space-y-2">
        <div class="flex items-center justify-between text-xs">
          <span class="font-semibold text-slate-800">${esc(m.yearMonth)} 薪水預支</span>
          <span class="font-bold tabular-nums ${pct >= 30 ? 'text-rose-600' : 'text-amber-600'}">${m.preemptedPercent}% (${fmtMoney(m.totalLockedAmount)})</span>
        </div>
        <div class="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
          <div class="h-full rounded-full ${pct >= 30 ? 'bg-rose-500' : 'bg-amber-500'}" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');

  const fxItems = sub.items || [];
  $('#fixedExpenseList').innerHTML = fxItems.length === 0
    ? `<div class="text-center py-3 text-xs text-slate-400">尚未設定固定扣款或分期</div>`
    : fxItems.map(f => `
      <div class="rounded-2xl bg-slate-50 border border-slate-100 px-3.5 py-2.5 flex items-center justify-between text-xs">
        <div class="flex items-center gap-2 min-w-0">
          <span class="px-2 py-0.5 rounded-full bg-white border border-slate-200 text-slate-600 text-[10px] font-medium">
            ${f.expense_type === 'SUBSCRIPTION' ? '訂閱' : (f.expense_type === 'INSTALLMENT' ? `分期餘${f.remaining_installments}期` : '固定')}
          </span>
          <span class="font-semibold text-slate-900 truncate">${esc(f.name)}</span>
          <span class="text-slate-400">${f.billing_day}號</span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="font-bold text-slate-900 tabular-nums">${fmtMoney(f.monthly_amount)}</span>
          <button data-del-fixed="${f.id}" class="text-slate-400 hover:text-rose-600 px-1">✕</button>
        </div>
      </div>
    `).join('');
}

function renderPatchesSection(walletTank, splitBills) {
  if (walletTank) {
    $('#tankEasycardVal').textContent = fmtMoney(walletTank.easycardBalance);
    $('#tankCashVal').textContent = fmtMoney(walletTank.cashBalance);

    const tBanner = $('#tankAuditBanner');
    if (walletTank.needsAuditAlert && walletTank.auditAlertText) {
      tBanner.textContent = walletTank.auditAlertText;
      tBanner.classList.remove('hidden');
    } else {
      tBanner.classList.add('hidden');
    }

    $('#tankLogsList').innerHTML = (walletTank.logs || []).map(l => `
      <div class="flex items-center justify-between text-xs bg-white rounded-xl px-2.5 py-1.5 border border-slate-100">
        <span class="text-slate-600">[${l.tank_type === 'EASYCARD' ? '悠遊卡' : '現金'}] ${esc(l.note)}</span>
        <span class="font-bold tabular-nums ${l.delta_amount >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${l.delta_amount >= 0 ? '+' : ''}${l.delta_amount} (餘 $${l.balance_after})</span>
      </div>
    `).join('');
  }

  if (splitBills) {
    $('#receivableTotalVal').textContent = fmtMoney(splitBills.pendingReceivableTotal);
    const container = $('#splitBillsList');
    if (!splitBills.items || splitBills.items.length === 0) {
      container.innerHTML = `<div class="text-center py-3 text-xs text-slate-400">尚無代墊拆帳紀錄</div>`;
    } else {
      container.innerHTML = splitBills.items.map(s => `
        <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3 flex items-center justify-between gap-2 text-xs">
          <div class="space-y-0.5 min-w-0">
            <div class="font-semibold text-slate-900 truncate">${esc(s.normalized_merchant || '聚餐消費')} · 總額 ${fmtMoney(s.total_amount)}</div>
            <div class="text-slate-500">自付 ${fmtMoney(s.self_amount)} · 應收 <b class="text-emerald-600">${fmtMoney(s.receivable_amount)}</b> (${esc(s.debtor_name)})</div>
          </div>
          <div class="shrink-0">
            ${s.is_repaid
              ? `<span class="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-semibold">✅ 已收訖</span>`
              : `<button data-settle-split="${s.id}" class="btn-press px-3 py-1.5 rounded-full bg-emerald-600 text-white font-semibold text-xs">結清</button>`
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

function switchMainTab(target) {
  $$('[data-nav-tab]').forEach(b => {
    const active = b.dataset.navTab === target;
    b.className = `nav-tab-btn btn-press py-1.5 rounded-2xl flex flex-col items-center gap-1 ${active ? 'text-slate-900 font-semibold' : 'text-slate-400 font-medium'}`;
  });
  $$('.tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${target}`));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function switchRecordSubtab(subtab) {
  $$('[data-record-subtab]').forEach(b => {
    const active = b.dataset.recordSubtab === subtab;
    b.className = `record-subtab-btn btn-press py-2 rounded-xl text-xs font-semibold ${active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`;
  });
  $('#subtab-cooldown')?.classList.toggle('hidden', subtab !== 'cooldown');
  $('#subtab-transactions')?.classList.toggle('hidden', subtab !== 'transactions');
}

function openShiftModal() {
  if (dashboardState?.survival?.budget?.effectiveIncome > 0) {
    $('#manualNetSalaryInput').value = dashboardState.survival.budget.effectiveIncome;
  }
  if (dashboardState?.survival?.cycle?.hourlyWage) {
    $('#manualHourlyWageInput').value = dashboardState.survival.cycle.hourlyWage;
  }
  $('#modalShiftSync')?.classList.remove('hidden');
}

function showAutoToast(message) {
  let bar = document.getElementById('autoSyncToastBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'autoSyncToastBar';
    bar.className = 'fixed top-14 left-1/2 -translate-x-1/2 z-50 max-w-sm w-[92%] rounded-2xl bg-slate-900/95 text-white px-4 py-2.5 text-xs font-semibold shadow-xl border border-slate-700 transition-opacity duration-300';
    document.body.appendChild(bar);
  }
  bar.textContent = message;
  bar.style.opacity = '1';
  clearTimeout(bar._hideTimer);
  bar._hideTimer = setTimeout(() => {
    bar.style.opacity = '0';
  }, 3600);
}

function readLocalShiftPayBridgePayload() {
  try {
    const bridgeRaw = localStorage.getItem('shiftpay.v2.bridge');
    if (bridgeRaw) {
      const parsed = JSON.parse(bridgeRaw);
      if (parsed && (parsed.state || parsed.shifts)) return parsed;
    }
    const v1Raw = localStorage.getItem('shiftpay.v1');
    if (v1Raw) {
      const parsed = JSON.parse(v1Raw);
      if (parsed && parsed.shifts) return parsed;
    }
  } catch (_) {}
  return null;
}

async function autoSyncShiftFromBridge(explicitPayload = null, showNotice = false) {
  try {
    const payload = explicitPayload || readLocalShiftPayBridgePayload();
    if (!payload) return null;
    const res = await apiCall('/api/shift/sync', 'POST', {
      rawJsonPayload: payload,
      autoSync: !showNotice
    });
    if (res && res.dashboard) {
      renderDashboard(res.dashboard);
      if (showNotice) {
        showAutoToast(`📅 ${res.message || '已自動同步「打工薪水帳 V2」最新排班與薪資！'}`);
      }
    }
    return res;
  } catch (_) {
    return null;
  }
}

let lastAutoClipboardText = '';
async function checkClipboardForBankNotification() {
  try {
    if (localStorage.getItem('anti_broke_auto_clipboard') === '0') return;
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') return;
    const clip = (await navigator.clipboard.readText() || '').trim();
    if (!clip || clip.length < 12 || clip.length > 1500 || clip === lastAutoClipboardText) return;
    const isSwipeNotif = /玉山|信用卡|簽帳金融卡|簽帳卡|消費通知|刷卡|帳戶扣款|商店請款|薪資入帳/.test(clip)
      && /(?:NT\$|TWD|新[台臺]幣|\$)\s*[0-9,]+|[0-9,]+\s*元/i.test(clip);
    if (!isSwipeNotif) return;

    lastAutoClipboardText = clip;
    const res = await apiCall('/api/notifications/webhook', 'POST', {
      source: 'clipboard_auto_sense',
      text: clip
    });
    if (res && res.dashboard) {
      renderDashboard(res.dashboard);
      if (res.result && res.result.resultType !== 'DEBOUNCE_IGNORED') {
        showAutoToast(`⚡ 自動偵測到刷卡通知：${res.result.parsed?.normalizedMerchant || ''} $${res.result.parsed?.amount || ''}`);
      }
    }
  } catch (_) {}
}

document.addEventListener('DOMContentLoaded', async () => {
  const whDisplay = $('#webhookUrlDisplay');
  const webhookUrl = window.location?.origin
    ? `${window.location.origin}/api/notifications/webhook`
    : 'https://anti-broke-finance-app.mr-haibaoseal.workers.dev/api/notifications/webhook';
  if (whDisplay) {
    whDisplay.textContent = `POST ${webhookUrl}`;
  }

  const chkClip = $('#chkAutoClipboard');
  if (chkClip) {
    chkClip.checked = localStorage.getItem('anti_broke_auto_clipboard') !== '0';
    chkClip.addEventListener('change', () => {
      localStorage.setItem('anti_broke_auto_clipboard', chkClip.checked ? '1' : '0');
    });
  }

  try {
    const localShift = readLocalShiftPayBridgePayload();
    const data = await apiCall('/api/dashboard', localShift ? 'POST' : 'GET', localShift ? { autoShiftState: localShift } : null);
    renderDashboard(data);
  } catch (err) {
    console.error(err);
  }

  // 監聽「打工薪水帳 V2」跨分頁 / 內嵌視窗即時同步事件 (免手動輸入 JSON)
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const bc = new BroadcastChannel('anti_broke_shift_sync');
      bc.addEventListener('message', ev => {
        if (ev.data && ev.data.type === 'SHIFT_STATE_UPDATED' && ev.data.payload) {
          autoSyncShiftFromBridge(ev.data.payload, true);
        }
      });
    }
  } catch (_) {}

  window.addEventListener('message', ev => {
    if (ev.data && ev.data.type === 'SHIFT_STATE_UPDATED' && ev.data.payload) {
      autoSyncShiftFromBridge(ev.data.payload, true);
    }
  });

  window.addEventListener('storage', ev => {
    if (ev.key === 'shiftpay.v1' || ev.key === 'shiftpay.v2.bridge') {
      autoSyncShiftFromBridge(null, true);
    }
  });

  // 定期 15 秒即時同步雲端與本機自動入帳的刷卡紀錄與排班薪資
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const prevTopTxId = dashboardState?.transactions?.[0]?.id || 0;
      const prevSpent = dashboardState?.survival?.budget?.totalSpent || 0;
      const prevIncome = dashboardState?.survival?.budget?.effectiveIncome || 0;
      const latest = await apiCall('/api/dashboard');
      const newTopTxId = latest?.transactions?.[0]?.id || 0;
      const newSpent = latest?.survival?.budget?.totalSpent || 0;
      const newIncome = latest?.survival?.budget?.effectiveIncome || 0;
      if (newTopTxId !== prevTopTxId || newSpent !== prevSpent || newIncome !== prevIncome) {
        renderDashboard(latest);
        if (newTopTxId > prevTopTxId && latest.transactions?.[0]) {
          const topTx = latest.transactions[0];
          showAutoToast(`💳 自動偵測新刷卡：${topTx.normalized_merchant} $${topTx.effective_amount}`);
        } else if (newIncome !== prevIncome) {
          showAutoToast(`📅 薪資預算已自動同步更新為 $${newIncome.toLocaleString()}`);
        }
      }
    } catch (_) {}
  }, 15000);

  window.addEventListener('focus', () => {
    checkClipboardForBankNotification();
    autoSyncShiftFromBridge(null, false);
  });

  $$('[data-nav-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchMainTab(btn.dataset.navTab));
  });

  $$('[data-record-subtab]').forEach(btn => {
    btn.addEventListener('click', () => switchRecordSubtab(btn.dataset.recordSubtab));
  });

  $('#cardGoCooldown')?.addEventListener('click', () => {
    switchMainTab('records');
    switchRecordSubtab('cooldown');
  });

  $('#cardGoTransactions')?.addEventListener('click', () => {
    switchMainTab('records');
    switchRecordSubtab('transactions');
  });

  const openImpulse = () => {
    $('#impulseEvalOutput')?.classList.add('hidden');
    $('#modalImpulse')?.classList.remove('hidden');
  };
  $('#btnOpenImpulseModal')?.addEventListener('click', openImpulse);
  $('#btnOpenImpulseFromList')?.addEventListener('click', openImpulse);

  const openNotif = () => $('#modalNotifParser')?.classList.remove('hidden');
  $('#btnOpenNotifModal')?.addEventListener('click', openNotif);
  $('#btnOpenNotifFromList')?.addEventListener('click', openNotif);
  $('#btnHomeAutoSwipeCenter')?.addEventListener('click', openNotif);

  $('#btnOpenShiftSync')?.addEventListener('click', openShiftModal);
  $('#btnOpenShiftSyncHome')?.addEventListener('click', openShiftModal);
  $('#btnOpenShiftSyncCard')?.addEventListener('click', openShiftModal);

  const openEmbeddedShift = () => {
    $('#modalShiftSync')?.classList.add('hidden');
    const modal = $('#modalEmbeddedShiftApp');
    const iframe = $('#shiftAppIframe');
    if (iframe && (!iframe.src || iframe.src === 'about:blank')) {
      iframe.src = '/shift-pay';
    }
    modal?.classList.remove('hidden');
  };
  $('#btnHomeOpenShiftEmbed')?.addEventListener('click', openEmbeddedShift);
  $('#btnOpenEmbeddedShiftApp')?.addEventListener('click', openEmbeddedShift);

  $('#btnOpenBalanceSync')?.addEventListener('click', () => $('#modalBalanceSync')?.classList.remove('hidden'));
  $('#btnOpenFixedModal')?.addEventListener('click', () => $('#modalFixedExpense')?.classList.remove('hidden'));

  $('#presetButtonsWrap')?.addEventListener('click', e => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const fn = NOTIFICATION_PRESETS[b.dataset.preset];
    if (fn) $('#notifInput').value = fn();
  });

  $('#btnParseNotif')?.addEventListener('click', async () => {
    const text = $('#notifInput').value.trim();
    if (!text) return alert('請先貼上通知文字或點選上方測試範本！');
    try {
      const res = await apiCall('/api/notifications/parse', 'POST', { text });
      const box = $('#notifResultBox');
      box.classList.remove('hidden');
      box.className = 'rounded-2xl p-3.5 text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 font-semibold';
      box.textContent = `【${res.result.resultType}】${res.result.message}`;
      $('#notifInput').value = '';
      renderDashboard(res.dashboard);
    } catch (err) {
      alert(err.message);
    }
  });

  $('#txFilterBar')?.addEventListener('click', e => {
    const b = e.target.closest('[data-tx-filter]');
    if (!b) return;
    currentTxFilter = b.dataset.txFilter;
    $$('#txFilterBar [data-tx-filter]').forEach(btn => {
      const on = btn.dataset.txFilter === currentTxFilter;
      btn.className = `btn-press shrink-0 px-3 py-1.5 rounded-full text-xs ${on ? 'font-semibold bg-slate-900 text-white' : 'font-medium bg-white border border-slate-200 text-slate-600'}`;
    });
    if (dashboardState) renderTransactionsList(dashboardState.transactions);
  });

  document.body.addEventListener('click', async e => {
    if (e.target.id && e.target.id.startsWith('modal')) {
      e.target.classList.add('hidden');
      return;
    }

    const closeModal = e.target.closest('[data-close-modal]');
    if (closeModal) {
      document.getElementById(closeModal.dataset.closeModal)?.classList.add('hidden');
      return;
    }

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
      const selfAmt = prompt(`【朋友聚餐一鍵拆帳】\n本筆「${splitBtn.dataset.splitName}」刷卡總額 $${total}。\n請輸入「你自己實際負擔」的金額 (NT$)：`, String(Math.round(total / 2)));
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
      const reason = prompt('請輸入取消訂單/退單原因（移入凍結觀察區）：', '網購取消訂單待解圈');
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
    }
  });

  $$('[data-imp-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedImpulseType = btn.dataset.impType;
      $$('[data-imp-type]').forEach(b => {
        const on = b.dataset.impType === selectedImpulseType;
        b.className = `imp-type-btn btn-press py-2.5 rounded-2xl text-xs font-semibold ${on ? (selectedImpulseType === 'WANT' ? 'bg-rose-600 text-white shadow-xs' : 'bg-emerald-600 text-white shadow-xs') : 'bg-slate-100 text-slate-500'}`;
      });
    });
  });

  $('#btnEvaluateImpulse')?.addEventListener('click', async () => {
    const itemName = $('#impItemName').value.trim();
    const amount = Number($('#impAmount').value);
    const reason = $('#impReason').value.trim();
    if (!itemName || !amount) return alert('請輸入商品名稱與金額！');

    try {
      const res = await apiCall('/api/impulse/evaluate', 'POST', {
        itemName, amount, reason, itemType: selectedImpulseType, addToCart: true
      });
      const ev = res.evaluation;
      const coffeeCups = Math.max(1, Math.round(amount / 65));
      const out = $('#impulseEvalOutput');
      out.classList.remove('hidden');
      out.innerHTML = `
        <div class="flex flex-wrap gap-1.5">
          <span class="px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 text-xs font-semibold">⏱️ 需站班表 ${esc(ev.sweatWork.hours)}h ${esc(ev.sweatWork.minutes)}m</span>
          <span class="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-semibold">☕ 約 ${coffeeCups} 杯咖啡</span>
          <span class="px-2.5 py-1 rounded-full bg-slate-200/70 text-slate-700 text-xs font-semibold">📉 日預算 $${ev.survivalImpact.dailyBudgetBefore} ➔ $${ev.survivalImpact.dailyBudgetAfter}</span>
        </div>
        <div class="text-xs text-slate-700 whitespace-pre-line leading-relaxed bg-white p-3.5 rounded-2xl border border-slate-100">${esc(ev.aiRoastMessage)}</div>
        <div class="flex items-center justify-between pt-1">
          <span class="text-xs font-semibold ${ev.lockedIn72hPool ? 'text-amber-700' : 'text-emerald-700'}">
            ${ev.lockedIn72hPool ? '🔒 已鎖入 72h 冷卻清單' : '✅ 評估完成'}
          </span>
          <button type="button" id="btnViewCooldownNow" class="btn-press px-3 py-1.5 rounded-full bg-slate-900 text-white text-xs font-semibold">查看冷卻清單</button>
        </div>
      `;
      $('#impItemName').value = '';
      $('#impAmount').value = '';
      $('#impReason').value = '';
      $('#btnViewCooldownNow')?.addEventListener('click', () => {
        $('#modalImpulse')?.classList.add('hidden');
        switchMainTab('records');
        switchRecordSubtab('cooldown');
      });
      renderDashboard(res.dashboard);
    } catch (err) {
      alert(err.message);
    }
  });

  $('#btnAddFixedExpense')?.addEventListener('click', async () => {
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
    $('#modalFixedExpense')?.classList.add('hidden');
    renderDashboard(res.dashboard);
  });

  $('#btnAuditTank')?.addEventListener('click', async () => {
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

  $('#btnConfirmShiftSync')?.addEventListener('click', async () => {
    const manualNetSalary = $('#manualNetSalaryInput').value.trim();
    const manualHourlyWage = $('#manualHourlyWageInput').value.trim();
    const raw = $('#shiftJsonInput').value.trim();
    try {
      const res = await apiCall('/api/shift/sync', 'POST', {
        manualNetSalary: manualNetSalary !== '' ? Number(manualNetSalary) : null,
        manualHourlyWage: manualHourlyWage !== '' ? Number(manualHourlyWage) : null,
        rawJsonPayload: raw || null
      });
      $('#modalShiftSync')?.classList.add('hidden');
      renderDashboard(res.dashboard);
    } catch (err) {
      alert('薪資設定失敗：' + err.message);
    }
  });

  $('#btnConfirmBalanceSync')?.addEventListener('click', async () => {
    const val = $('#actualEsunInput').value;
    if (val === '') return alert('請輸入玉山 Wallet 可用餘額！');
    try {
      const res = await apiCall('/api/balance/sync', 'POST', { actualEsunBalance: Number(val) });
      $('#modalBalanceSync')?.classList.add('hidden');
      $('#actualEsunInput').value = '';
      alert(res.syncResult.message);
      renderDashboard(res.dashboard);
    } catch (err) {
      alert(err.message);
    }
  });

  $('#btnToggleHighRisk')?.addEventListener('click', async () => {
    const cur = dashboardState?.settings?.force_high_risk_mode ? 0 : 1;
    const res = await apiCall('/api/settings', 'POST', { forceHighRiskMode: cur });
    renderDashboard(res.dashboard);
  });

  $('#btnSaveSettings')?.addEventListener('click', async () => {
    const res = await apiCall('/api/settings', 'POST', {
      paydayDay: Number($('#setPayday').value),
      netPayFactor: Number($('#setNetFactor').value),
      laborHealthDeduction: Number($('#setLaborDeduct').value),
      shiftAppPath: $('#setShiftPath').value.trim(),
      gmailUser: $('#setGmailUser').value.trim(),
      gmailAppPassword: $('#setGmailPass').value.trim()
    });
    alert('✅ 設定已儲存！');
    renderDashboard(res.dashboard);
  });

  $('#btnPollGmail')?.addEventListener('click', async () => {
    const res = await apiCall('/api/notifications/gmail-poll', 'POST', {});
    renderDashboard(res.dashboard);
    showAutoToast(res.imap.message);
  });

  $('#btnPollGmailNow')?.addEventListener('click', async () => {
    const btn = $('#btnPollGmailNow');
    if (btn) btn.textContent = '⏳ 正在掃描 Gmail...';
    try {
      const res = await apiCall('/api/notifications/gmail-poll', 'POST', {});
      renderDashboard(res.dashboard);
      const box = $('#notifResultBox');
      if (box) {
        box.classList.remove('hidden');
        box.className = 'rounded-2xl p-3.5 text-xs bg-indigo-50 border border-indigo-200 text-indigo-800 font-semibold';
        box.textContent = res.imap.message;
      }
      showAutoToast(res.imap.message);
    } finally {
      if (btn) btn.textContent = '🔄 立即掃描 Gmail 刷卡信';
    }
  });

  $('#btnCopyWebhookUrl')?.addEventListener('click', async () => {
    const url = window.location?.origin
      ? `${window.location.origin}/api/notifications/webhook`
      : 'https://anti-broke-finance-app.mr-haibaoseal.workers.dev/api/notifications/webhook';
    try {
      await navigator.clipboard.writeText(url);
      showAutoToast('✅ 已複製自動入帳 Webhook 網址！可貼至 iOS 捷徑自動化');
    } catch (_) {
      prompt('請複製以下 Webhook 網址：', url);
    }
  });

  $('#btnCopyGasScript')?.addEventListener('click', async () => {
    const code = dashboardState?.automation?.gasScriptCode || '';
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showAutoToast('✅ 已複製 Google 雲端 24h 自動收信腳本！請貼至 script.google.com');
    } catch (_) {
      alert('複製失敗，請至設定查看');
    }
  });

  $('#btnOpenEmbeddedShiftApp')?.addEventListener('click', () => {
    $('#modalShiftSync')?.classList.add('hidden');
    const modal = $('#modalEmbeddedShiftApp');
    const iframe = $('#shiftAppIframe');
    if (iframe && (!iframe.src || iframe.src === 'about:blank')) {
      iframe.src = '/shift-pay';
    }
    modal?.classList.remove('hidden');
  });

  $('#btnCloseEmbeddedShiftApp')?.addEventListener('click', async () => {
    $('#modalEmbeddedShiftApp')?.classList.add('hidden');
    await autoSyncShiftFromBridge(null, true);
  });

  $('#btnAutoPullShiftNow')?.addEventListener('click', async () => {
    const res = await autoSyncShiftFromBridge(null, true);
    if (res) {
      $('#modalShiftSync')?.classList.add('hidden');
    } else {
      const apiRes = await apiCall('/api/shift/sync', 'POST', {});
      renderDashboard(apiRes.dashboard);
      showAutoToast(apiRes.message || '✅ 已重新同步班表薪資！');
      $('#modalShiftSync')?.classList.add('hidden');
    }
  });

  $('#btnResetDemo')?.addEventListener('click', async () => {
    const res = await apiCall('/api/demo/reset', 'POST', { withDemoData: true });
    renderDashboard(res.dashboard);
  });

  $('#btnClearAllData')?.addEventListener('click', async () => {
    if (!confirm('確定要清空所有紀錄並歸零嗎？')) return;
    const res = await apiCall('/api/demo/reset', 'POST', { withDemoData: false });
    renderDashboard(res.dashboard);
  });
});






