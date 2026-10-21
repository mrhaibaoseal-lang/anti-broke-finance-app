'use strict';

let dashboardState = null;
let currentTxFilter = 'ALL';
let selectedImpulseType = 'WANT';

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const fmtMoney = n => '$' + Number(n || 0).toLocaleString();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NOTIFICATION_PRESETS = {
  atm_deposit: () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return `【玉山銀行】存款通知：您的玉山帳戶(末四碼1234)於 ${today} 15:20 於 ATM 現金存入 NT$5,000 元，帳戶可用餘額 NT$18,500 元。`;
  },
  cardless_deposit: () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return `【玉山Wallet】臺幣帳戶入帳通知：您的帳戶於 ${today} 18:10 完成無卡存款存入 新臺幣 3,000 元。`;
  },
  apple_pay_tap: () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return `【Apple Pay 感應刷卡】您的 玉山銀行卡 於 ${today} 15:30 在「星巴克」使用 Apple Pay 一般消費 NT$155 元。`;
  },
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

  const localHour = new Date().getHours();
  const isLocalLateNight = localHour >= 23 || localHour < 5;
  const isHighRiskActive = Boolean(highRiskMode?.isHighRisk || isLocalLateNight);

  document.body.classList.toggle('high-risk-mode', isHighRiskActive);
  const hrBanner = $('#highRiskBanner');
  if (isHighRiskActive) {
    const reasonText = (highRiskMode?.reasons && highRiskMode.reasons.length > 0)
      ? highRiskMode.reasons.join(' ＋ ')
      : `深夜腦波弱時段 (${String(localHour).padStart(2, '0')}:00，23:00~05:00 嚴格管制)`;
    hrBanner.textContent = `🌙 夜間高風險防禦自動開啟中：${reasonText}`;
    hrBanner.classList.remove('hidden');
    $('#highRiskBtnLabel').textContent = '防禦中';
  } else {
    hrBanner.classList.add('hidden');
    $('#highRiskBtnLabel').textContent = '夜間防禦';
  }

  const alertsHtml = [];
  if (survival.budget.bankruptcyWarningText) {
    alertsHtml.push(`
      <div class="rounded-2xl bg-rose-500/12 border border-rose-500/25 px-4 py-3 text-xs font-medium text-rose-300 flex items-center justify-between gap-3">
        <span>⚠️ ${esc(survival.budget.bankruptcyWarningText)}</span>
      </div>
    `);
  }
  for (const gh of (ghostHolds || [])) {
    alertsHtml.push(`
      <div class="rounded-2xl bg-amber-500/12 border border-amber-500/25 px-4 py-3 text-xs font-medium text-amber-300 flex items-center justify-between gap-3">
        <span>👻 ${esc(gh.merchant)} $${gh.amount} 逾 ${gh.ageDays} 天未請款</span>
        <button data-cancel-tx="${gh.transactionId}" class="btn-press shrink-0 px-3 py-1.5 rounded-full bg-amber-500/20 text-amber-200 font-semibold text-xs border border-amber-500/30">退單解圈</button>
      </div>
    `);
  }
  $('#alertStack').innerHTML = alertsHtml.join('');

  const mainCard = $('#survivalMainCard');
  mainCard.className = `bento-card p-6 sm:p-8 space-y-6 tier-glow-${survival.tier.code}`;
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

  if (survival.budget.atmDeposited > 0) {
    $('#actualSalaryNote').textContent = `🏧 本月金融卡累計存入 $${Number(survival.budget.atmDeposited || 0).toLocaleString()} (${survival.budget.depositCount || 0} 筆)`;
  } else if (survival.cycle.isSalarySettled) {
    $('#actualSalaryNote').textContent = `實領薪資 $${Number(survival.cycle.actualSalary || 0).toLocaleString()}`;
  } else {
    $('#actualSalaryNote').textContent = `預估實領 $${Number(survival.cycle.estimatedNetPay || 0).toLocaleString()} (×${survival.cycle.netPayFactor})`;
  }

  if ($('#todaySpentVal')) $('#todaySpentVal').textContent = fmtMoney(survival.budget.todaySpent);
  if ($('#pendingSpentVal')) $('#pendingSpentVal').textContent = fmtMoney(survival.budget.pendingSpent);
  if ($('#settledSpentVal')) $('#settledSpentVal').textContent = fmtMoney(survival.budget.settledSpent);
  if ($('#gapSpentVal')) $('#gapSpentVal').textContent = fmtMoney(survival.budget.gapSpent);
  if ($('#cashSpentVal')) $('#cashSpentVal').textContent = fmtMoney(survival.budget.cashSpent || 0);
  if ($('#cardDepositedTotalVal')) $('#cardDepositedTotalVal').textContent = '+' + fmtMoney(survival.budget.totalDeposited || 0);
  if ($('#depositCountBadge')) $('#depositCountBadge').textContent = survival.budget.depositCount || 0;
  if ($('#txSummaryDeposited')) $('#txSummaryDeposited').textContent = '+' + fmtMoney(survival.budget.totalDeposited || 0);
  if ($('#txSummaryCardSpent')) $('#txSummaryCardSpent').textContent = '-' + fmtMoney((survival.budget.totalSpent || 0));
  if ($('#txSummaryCashSpent')) $('#txSummaryCashSpent').textContent = '-' + fmtMoney(survival.budget.cashSpent || 0);

  renderTransactionsList(transactions);
  renderCooldownSection(cooldownCart);
  renderRadarSection(radar);
  renderPatchesSection(walletTank, splitBills);
  renderSettingsSection(settings);
  renderTimeMappingSection(survival.timeMapping, survival);

  // 若雲端週期含有已綁定的完整班表狀態，自動寫入本機 shiftpay.v1 讓內嵌與分頁排班表直接顯示完整資料
  try {
    const cloudFullState = survival?.cycle?.rawShiftPayload?.fullState;
    if (cloudFullState && cloudFullState.shifts && Object.keys(cloudFullState.shifts).length > 0) {
      const existingRaw = localStorage.getItem('shiftpay.v1');
      const existingObj = existingRaw ? JSON.parse(existingRaw) : null;
      const existingCount = existingObj?.shifts ? Object.keys(existingObj.shifts).length : 0;
      if (existingCount === 0) {
        localStorage.setItem('shiftpay.v1', JSON.stringify(cloudFullState));
        localStorage.setItem('shiftpay.v2.bridge', JSON.stringify({
          app: 'shiftpay-v2',
          updatedAt: survival.cycle.lastSyncedAt || new Date().toISOString(),
          month: survival.cycle.targetShiftMonth,
          state: cloudFullState
        }));
      }
    }
  } catch (_) {}
}

function statusLabelOf(status) {
  const map = {
    DEPOSIT: '💰 金融卡存款',
    CASH_SPENT: '💵 現金消費',
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
    : (currentTxFilter === 'SPENT_ALL'
        ? transactions.filter(t => ['PENDING', 'SETTLED', 'CASH_SPENT', 'UNKNOWN_GAP'].includes(t.status))
        : transactions.filter(t => t.status === currentTxFilter));

  const recentContainer = $('#homeRecentTxList');
  if (recentContainer) {
    const recent3 = (transactions || []).slice(0, 3);
    if (recent3.length === 0) {
      recentContainer.innerHTML = '<div class="text-center py-4 text-xs text-[#8E95A5]">尚無交易紀錄，所有消費與存款將即時顯示於此</div>';
    } else {
      recentContainer.innerHTML = recent3.map(t => {
        const isDeposit = t.status === 'DEPOSIT';
        const isCash = t.status === 'CASH_SPENT';
        const amtColor = isDeposit ? 'text-emerald-400' : 'text-[#F5F5F7]';
        const amtSign = isDeposit ? '+' : '-';
        const icon = isDeposit ? 'fa-building-columns text-emerald-400' : (isCash ? 'fa-money-bill-1-wave text-emerald-400' : 'fa-credit-card text-[#0A84FF]');
        return `
          <div class="apple-inset !py-3 !px-4 flex items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <span class="w-8 h-8 rounded-xl bg-white/[0.06] grid place-items-center text-xs shrink-0">
                <i class="fa-solid ${icon}"></i>
              </span>
              <div class="min-w-0 space-y-0.5">
                <div class="text-xs font-semibold text-[#F5F5F7] truncate">${esc(t.merchant_clean || t.merchant_raw || '交易')}</div>
                <div class="text-[11px] text-[#8E95A5]">${esc(t.card_last4 ? '末四碼 ' + t.card_last4 : (isCash ? '現金支出' : statusLabelOf(t.status)))} · ${esc(t.transacted_at ? t.transacted_at.slice(5, 16) : '')}</div>
              </div>
            </div>
            <div class="text-right shrink-0">
              <div class="text-sm font-bold ${amtColor} tabular-nums">${amtSign}$${fmtMoney(t.amount)}</div>
              <div class="text-[10px] text-[#8E95A5]">${statusLabelOf(t.status)}</div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  const container = $('#txListContainer');
  if (!container) return;
  if (filtered.length === 0) {
    container.innerHTML = '<div class="bento-card p-8 text-center text-sm text-[#8E95A5]">尚無符合條件的交易或存款紀錄</div>';
    return;
  }

  container.innerHTML = filtered.map(tx => {
    const isDeposit = tx.status === 'DEPOSIT';
    const isCashSpent = tx.status === 'CASH_SPENT';

    const lockBadge = isDeposit
      ? `<span class="px-2.5 py-0.5 rounded-full bg-emerald-500/12 text-emerald-300 border border-emerald-500/25 text-xs font-medium"><i class="fa-solid fa-building-columns mr-1"></i>已入帳</span>`
      : (isCashSpent
          ? `<span class="px-2.5 py-0.5 rounded-full bg-amber-500/12 text-amber-300 border border-amber-500/25 text-xs font-medium">💵 皮包扣現</span>`
          : (tx.is_reconciled_locked
              ? `<span class="px-2.5 py-0.5 rounded-full bg-emerald-500/12 text-emerald-300 border border-emerald-500/25 text-xs font-medium"><i class="fa-solid fa-lock mr-1"></i>已核銷</span>`
              : `<span class="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-[#8E95A5] text-xs font-medium">待請款</span>`));

    const fxBadge = tx.fx_fee_diff !== 0
      ? `<span class="px-2.5 py-0.5 rounded-full bg-sky-500/12 text-sky-300 border border-sky-500/25 text-xs font-medium">匯差 ${tx.fx_fee_diff > 0 ? '+' : ''}$${tx.fx_fee_diff}</span>`
      : '';

    const isApplePayTx = /APPLE\s*PAY|感應刷卡/i.test(`${tx.channel_a_raw || ''} ${tx.reconcile_note || ''} ${tx.raw_merchant || ''}`);
    const applePayBadge = isApplePayTx
      ? `<span class="px-2.5 py-0.5 rounded-full bg-white/[0.12] text-[#F5F5F7] text-xs font-semibold"><i class="fa-brands fa-apple mr-1"></i>Apple Pay</span>`
      : '';

    const actions = [];
    if (tx.status === 'TEMP_HOLD') {
      actions.push(`<button data-gas-tx="${tx.id}" class="btn-press btn-primary px-3.5 py-2 rounded-xl text-xs">⛽ 輸入加油金額</button>`);
    }
    if (tx.status === 'PENDING' || tx.status === 'SETTLED') {
      actions.push(`<button data-split-tx="${tx.id}" data-split-amt="${tx.effective_amount}" data-split-name="${esc(tx.normalized_merchant)}" class="btn-press btn-secondary px-3.5 py-2 rounded-xl text-xs">🤝 聚餐拆帳</button>`);
    }
    if (tx.status === 'PENDING') {
      actions.push(`<button data-cancel-tx="${tx.id}" class="btn-press btn-secondary px-3.5 py-2 rounded-xl text-xs">❄️ 退單解圈</button>`);
    }
    if (tx.status === 'UNKNOWN_GAP') {
      actions.push(`<button data-gap-tx="${tx.id}" data-gap-amt="${tx.personal_amount}" class="btn-press btn-primary px-3.5 py-2 rounded-xl text-xs">✨ 拆分黑洞</button>`);
    }
    actions.push(`<button data-del-tx="${tx.id}" class="btn-press btn-danger-soft px-3.5 py-2 rounded-xl text-xs">🗑️ 刪除此筆紀錄</button>`);

    let amountHtml;
    if (isDeposit) {
      amountHtml = `<div class="text-xl font-bold tabular-nums text-emerald-400">+${fmtMoney(tx.effective_amount)}</div>`;
    } else if (isCashSpent) {
      amountHtml = `<div class="text-xl font-bold tabular-nums text-sky-400">-${fmtMoney(tx.effective_amount)}</div>`;
    } else {
      amountHtml = `
        <div class="text-xl font-bold tabular-nums ${tx.personal_amount > 0 ? 'text-[#F5F5F7]' : 'text-[#8E95A5]'}">
          ${tx.personal_amount > 0 ? '-' + fmtMoney(tx.personal_amount) : '$0'}
        </div>
      `;
    }

    const detailRightMeta = isDeposit
      ? `存入金額 +$${tx.effective_amount}`
      : (isCashSpent
          ? `現金消費 $${tx.effective_amount}${tx.personal_amount > 0 ? ' (同步扣預算)' : ' (僅扣皮包現金)'}`
          : `圈存 $${tx.auth_amount}${tx.settled_amount !== null ? ` · 請款 $${tx.settled_amount}` : ''}`);

    return `
      <details class="group bento-card p-6 ${isDeposit ? 'border-emerald-500/25' : ''}">
        <summary class="cursor-pointer list-none flex items-center justify-between gap-4">
          <div class="space-y-2 min-w-0">
            <div class="text-base font-semibold text-[#F5F5F7] truncate">${esc(tx.normalized_merchant)}</div>
            <div class="flex flex-wrap items-center gap-2">
              <span class="px-2.5 py-0.5 rounded-full text-xs font-medium badge-${tx.status}">${statusLabelOf(tx.status, tx)}</span>
              ${applePayBadge}
              ${lockBadge}
              ${fxBadge}
              <span class="text-xs text-[#8E95A5] tabular-nums">${esc(tx.tx_date.slice(5))}</span>
            </div>
          </div>
          <div class="text-right shrink-0 space-y-1">
            ${amountHtml}
            <div class="text-xs text-[#8E95A5]">細節 <i class="fa-solid fa-chevron-down text-[10px] group-open:rotate-180 transition-transform"></i></div>
          </div>
        </summary>
        <div class="mt-4 pt-4 border-t border-white/[0.07] space-y-3 text-xs text-[#8E95A5]">
          <div class="flex flex-wrap justify-between gap-2">
            <span>分類：${esc(tx.category)}</span>
            <span class="tabular-nums text-[#D1D5DB]">${detailRightMeta}</span>
          </div>
          ${tx.reconcile_note ? `<div class="apple-inset !p-3 text-[#D1D5DB] leading-relaxed">${esc(tx.reconcile_note)}</div>` : ''}
          ${actions.length > 0 ? `<div class="flex flex-wrap gap-2.5 pt-1">${actions.join('')}</div>` : ''}
        </div>
      </details>
    `;
  }).join('');
}

function renderCooldownSection(cooldownCart) {
  if (!cooldownCart) return;
  const ach = cooldownCart.achievement || {};
  if ($('#achieveBadgeTitle')) $('#achieveBadgeTitle').textContent = ach.badgeTitle || '🌱 防衝動覺醒者';
  if ($('#savedTotalVal')) $('#savedTotalVal').textContent = fmtMoney(ach.totalSavedAmount || 0);
  if ($('#savedHoursVal')) $('#savedHoursVal').textContent = ach.totalSavedHours || 0;
  if ($('#savedCountVal')) $('#savedCountVal').textContent = ach.abandonedCount || 0;

  const container = $('#cooldownListContainer');
  const list = [...(cooldownCart.activeItems || []), ...(cooldownCart.abandonedItems || [])];

  if (list.length === 0) {
    container.innerHTML = `<div class="bento-card p-8 text-center text-sm text-[#8E95A5]">目前冷卻清單為空，點選「➕ 我又想買東西了」開始防剁手評估</div>`;
    return;
  }

  container.innerHTML = list.map(item => {
    const coffeeCups = Math.max(1, Math.round((Number(item.amount) || 0) / 65));
    const hoursNum = Number(item.work_hours_equivalent || 0).toFixed(1);

    if (item.status === 'ABANDONED') {
      return `
        <div class="bento-card p-6 flex items-center justify-between gap-4 border-emerald-500/20">
          <div class="space-y-2 min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-base font-semibold text-[#F5F5F7] truncate">${esc(item.item_name)}</span>
              <span class="px-2.5 py-0.5 rounded-full bg-emerald-500/12 text-emerald-300 border border-emerald-500/25 text-xs font-medium">🏆 已忍住不買</span>
            </div>
            <div class="flex flex-wrap gap-2">
              <span class="px-2.5 py-0.5 rounded-full bg-emerald-500/12 text-emerald-300 text-xs font-medium">⏱️ 省下 ${hoursNum}h 工時</span>
              <span class="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-[#8E95A5] text-xs font-medium">☕ ${coffeeCups} 杯咖啡</span>
            </div>
          </div>
          <div class="text-xl font-bold text-emerald-400 tabular-nums shrink-0">+${fmtMoney(item.amount)}</div>
        </div>
      `;
    }

    const isUnlocked = item.status === 'UNLOCKED';
    return `
      <div class="bento-card p-6 space-y-4 ${isUnlocked ? 'border-amber-500/30' : ''}">
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-2 min-w-0">
            <div class="text-base font-semibold text-[#F5F5F7]">${esc(item.item_name)}</div>
            <div class="flex flex-wrap gap-2">
              <span class="px-2.5 py-0.5 rounded-full ${isUnlocked ? 'bg-amber-500/15 text-amber-300 border border-amber-500/25' : 'bg-rose-500/15 text-rose-300 border border-rose-500/25'} text-xs font-medium">
                ${isUnlocked ? '🔓 已滿 72h 可決定' : `⏳ 倒數 ${item.remainingHours}h`}
              </span>
              <span class="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-[#D1D5DB] text-xs font-medium">⏱️ ${hoursNum}h 工時</span>
              <span class="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-[#8E95A5] text-xs font-medium">☕ ${coffeeCups} 杯咖啡</span>
            </div>
          </div>
          <div class="text-xl font-bold text-[#F5F5F7] tabular-nums shrink-0">${fmtMoney(item.amount)}</div>
        </div>

        <details class="group">
          <summary class="cursor-pointer list-none text-xs text-[#8E95A5] hover:text-[#F5F5F7] flex items-center gap-1.5">
            <span>查看靈魂拷問與預算衝擊</span>
            <i class="fa-solid fa-chevron-down text-[10px] group-open:rotate-180 transition-transform"></i>
          </summary>
          <div class="mt-3 apple-inset !p-4 text-xs text-[#D1D5DB] whitespace-pre-line leading-relaxed">${esc(item.ai_roast_message)}</div>
        </details>

        <div class="flex gap-3 pt-1">
          <button data-cd-resolve="${item.id}|ABANDON" class="btn-press btn-primary flex-1 py-3 text-xs">
            💪 放棄購買（省下 ${fmtMoney(item.amount)}）
          </button>
          ${!isUnlocked ? `
            <button data-cd-ff="${item.id}" class="btn-press btn-secondary px-4 py-3 text-xs">
              ⏩ 滿 72h
            </button>
          ` : `
            <button data-cd-resolve="${item.id}|PURCHASE" class="btn-press btn-danger-soft px-4 py-3 text-xs">
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
    lb.innerHTML = `<div class="text-center py-6 text-xs text-[#8E95A5]">本週尚無單筆低於 $200 的小額消費</div>`;
  } else {
    lb.innerHTML = vr.leaderboard.map((g, idx) => `
      <div class="apple-inset ${g.isVampireAlert ? 'border-rose-500/30 bg-rose-500/10' : ''} flex items-center justify-between gap-3">
        <div class="space-y-1">
          <div class="text-sm font-semibold text-[#F5F5F7] flex items-center gap-2">
            <span class="px-2 py-0.5 rounded-md bg-white/[0.06] border border-white/[0.08] text-xs text-[#8E95A5] tabular-nums">#${idx + 1}</span>
            <span>${esc(g.name)}</span>
            ${g.isVampireAlert ? '<span class="px-2.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-medium">高頻失血</span>' : ''}
          </div>
          <div class="text-xs text-[#8E95A5]">7 天內 ${g.count} 次 · ${esc(g.category)}</div>
        </div>
        <div class="text-base font-bold text-rose-400 tabular-nums">-${fmtMoney(g.totalAmount)}</div>
      </div>
    `).join('');
  }

  if ($('#subAlertsWrap')) $('#subAlertsWrap').innerHTML = (sub.subscriptionAlerts || []).map(a => `
    <div class="rounded-xl bg-amber-500/12 border border-amber-500/25 px-4 py-3 text-xs font-medium text-amber-300">${esc(a)}</div>
  `).join('');

  if ($('#futureSalaryBars')) $('#futureSalaryBars').innerHTML = (sub.futureMonths || []).map(m => {
    const pct = Math.min(100, Math.max(0, Number(m.preemptedPercent) || 0));
    return `
      <div class="apple-inset space-y-2.5">
        <div class="flex items-center justify-between text-xs">
          <span class="font-semibold text-[#D1D5DB]">${esc(m.yearMonth)} 薪水預支</span>
          <span class="font-bold tabular-nums ${pct >= 30 ? 'text-rose-400' : 'text-amber-400'}">${m.preemptedPercent}% (${fmtMoney(m.totalLockedAmount)})</span>
        </div>
        <div class="w-full h-2 rounded-full bg-white/[0.08] overflow-hidden">
          <div class="h-full rounded-full ${pct >= 30 ? 'bg-rose-400' : 'bg-amber-400'}" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');

  const fxItems = sub.items || [];
  $('#fixedExpenseList').innerHTML = fxItems.length === 0
    ? `<div class="text-center py-4 text-xs text-[#8E95A5]">尚未設定固定扣款或分期</div>`
    : fxItems.map(f => `
      <div class="apple-inset !py-3 !px-4 flex items-center justify-between gap-3 text-xs">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="px-2.5 py-0.5 rounded-full bg-white/[0.06] border border-white/[0.08] text-[#D1D5DB] text-xs font-medium shrink-0">
            ${f.expense_type === 'SUBSCRIPTION' ? '訂閱' : (f.expense_type === 'INSTALLMENT' ? `分期餘${f.remaining_installments}期` : '固定')}
          </span>
          <span class="font-semibold text-sm text-[#F5F5F7] truncate">${esc(f.name)}</span>
          <span class="text-[#8E95A5] shrink-0">${f.billing_day}號</span>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <span class="font-bold text-sm text-[#F5F5F7] tabular-nums">${fmtMoney(f.monthly_amount)}</span>
          <button data-del-fixed="${f.id}" class="text-[#8E95A5] hover:text-rose-400 px-1.5 py-1 rounded-lg hover:bg-white/[0.06] transition-colors">✕</button>
        </div>
      </div>
    `).join('');
}

function renderPatchesSection(walletTank, splitBills) {
  if (walletTank) {
    $('#tankEasycardVal').textContent = fmtMoney(walletTank.easycardBalance);
    $('#tankCashVal').textContent = fmtMoney(walletTank.cashBalance);
    if ($('#homeCashVal')) $('#homeCashVal').textContent = fmtMoney(walletTank.cashBalance);
    if ($('#homeEasyVal')) $('#homeEasyVal').textContent = fmtMoney(walletTank.easycardBalance);

    const logs = walletTank.logs || [];
    const lastCashLog = logs.find(l => l.tank_type === 'CASH');
    const lastEasyLog = logs.find(l => l.tank_type === 'EASYCARD');
    if ($('#tankCashLastNote')) {
      $('#tankCashLastNote').innerHTML = lastCashLog
        ? `最新：<b class="${lastCashLog.delta_amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${lastCashLog.delta_amount >= 0 ? '+' : '-'}$${Math.abs(lastCashLog.delta_amount)}</b> (${esc(lastCashLog.note)})`
        : '可輸入 60、+60 加值或 -60 扣款';
    }
    if ($('#tankEasyLastNote')) {
      $('#tankEasyLastNote').innerHTML = lastEasyLog
        ? `最新：<b class="${lastEasyLog.delta_amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${lastEasyLog.delta_amount >= 0 ? '+' : '-'}$${Math.abs(lastEasyLog.delta_amount)}</b> (${esc(lastEasyLog.note)})`
        : '可輸入 60、+60 加值或 -60 扣款';
    }

    const tBanner = $('#tankAuditBanner');
    if (walletTank.needsAuditAlert && walletTank.auditAlertText) {
      tBanner.textContent = walletTank.auditAlertText;
      tBanner.classList.remove('hidden');
    } else {
      tBanner.classList.add('hidden');
    }

    $('#tankLogsList').innerHTML = logs.map(l => `
      <div class="flex items-center justify-between text-xs bg-black/25 rounded-xl px-3.5 py-2.5 border border-white/[0.06]">
        <span class="text-[#D1D5DB]">[${l.tank_type === 'EASYCARD' ? '悠遊卡' : '現金'}] ${esc(l.note)}</span>
        <span class="font-semibold tabular-nums ${l.delta_amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${l.delta_amount >= 0 ? '+' : ''}${l.delta_amount} (餘 $${l.balance_after})</span>
      </div>
    `).join('');
  }

  if (splitBills) {
    $('#receivableTotalVal').textContent = fmtMoney(splitBills.pendingReceivableTotal);
    const container = $('#splitBillsList');
    if (!splitBills.items || splitBills.items.length === 0) {
      container.innerHTML = `<div class="text-center py-4 text-xs text-[#8E95A5]">尚無代墊拆帳紀錄</div>`;
    } else {
      container.innerHTML = splitBills.items.map(s => `
        <div class="apple-inset flex items-center justify-between gap-3 text-xs">
          <div class="space-y-1 min-w-0">
            <div class="font-semibold text-sm text-[#F5F5F7] truncate">${esc(s.normalized_merchant || '聚餐消費')} · 總額 ${fmtMoney(s.total_amount)}</div>
            <div class="text-[#8E95A5]">自付 ${fmtMoney(s.self_amount)} · 應收 <b class="text-emerald-400">${fmtMoney(s.receivable_amount)}</b> (${esc(s.debtor_name)})</div>
          </div>
          <div class="shrink-0">
            ${s.is_repaid
              ? `<span class="px-3 py-1 rounded-full bg-emerald-500/12 text-emerald-300 border border-emerald-500/25 text-xs font-medium">✅ 已收訖</span>`
              : `<button data-settle-split="${s.id}" class="btn-press btn-primary px-3.5 py-2 rounded-xl text-xs">結清</button>`
            }
          </div>
        </div>
      `).join('');
    }
  }
}

function renderTimeMappingSection(tm, survival) {
  if (!tm) return;
  const isNextMonthPay = tm.mappingMode !== 'SAME_MONTH_PAY';
  const cur = tm.currentCycle || {};
  const up = tm.upcomingCycle || {};
  const prevSh = cur.prevMonthShift || {};
  const currSh = up.currMonthShift || {};

  const earnedM = Number(String(cur.earnedShiftMonth || '').slice(5)) || '--';
  const workM = Number(String(up.workMonth || '').slice(5)) || '--';
  const curPaydayLabel = String(cur.paydayDate || '').slice(5).replace('-', '/');
  const nextPaydayLabel = String(up.paydayDate || '').slice(5).replace('-', '/');

  if ($('#tmTodayMeta')) {
    $('#tmTodayMeta').textContent = `現實時間 ${String(tm.realToday || '').slice(5).replace('-', '/')} · 每月 ${tm.paydayDay} 號發薪`;
  }
  if ($('#btnToggleMappingMode')) {
    $('#btnToggleMappingMode').textContent = isNextMonthPay
      ? '🕒 次月發薪制（點此切換）'
      : '⚡ 當月抵用制（點此切換）';
    $('#btnToggleMappingMode').className = isNextMonthPay
      ? 'btn-press px-3 py-1 rounded-full bg-emerald-500/12 border border-emerald-500/25 text-emerald-300 text-xs font-semibold'
      : 'btn-press px-3 py-1 rounded-full bg-[#0A84FF]/15 border border-[#0A84FF]/30 text-sky-300 text-xs font-semibold';
  }

  if ($('#tmCurrentCycleRange')) {
    $('#tmCurrentCycleRange').textContent = `${String(cur.startDate || '').slice(5).replace('-', '/')}~${String(cur.endDate || '').slice(5).replace('-', '/')}`;
  }
  if ($('#tmCurrentSourceTitle')) {
    if (cur.activeSourceType === 'MANUAL_SETTLED') {
      $('#tmCurrentSourceTitle').textContent = `💵 手動設定本月已領薪水`;
    } else if (isNextMonthPay) {
      $('#tmCurrentSourceTitle').textContent = `📅 ${earnedM}月班表 ➔ ${curPaydayLabel} 已發薪`;
    } else {
      $('#tmCurrentSourceTitle').textContent = `⚡ ${workM}月班表（當月直接抵用）`;
    }
  }
  if ($('#tmCurrentIncomeVal')) {
    $('#tmCurrentIncomeVal').textContent = fmtMoney(cur.effectiveIncome || 0);
  }
  if ($('#tmCurrentSubMeta')) {
    if (cur.activeSourceType === 'MANUAL_SETTLED') {
      $('#tmCurrentSubMeta').textContent = `本週期固定預算 · 不受 ${workM} 月新排班覆蓋`;
    } else if (isNextMonthPay) {
      if ((prevSh.shiftCount || 0) > 0) {
        $('#tmCurrentSubMeta').textContent = `${earnedM}月排班 ${prevSh.shiftCount} 天 (${prevSh.normalHours}h) · 帳面 ${fmtMoney(prevSh.totalPay)}`;
      } else {
        $('#tmCurrentSubMeta').textContent = `${earnedM}月無班表紀錄 · 請在下方設定目前手頭預算`;
      }
    } else {
      $('#tmCurrentSubMeta').textContent = `直接以 ${workM} 月班表 (${currSh.shiftCount || 0}天) 作為目前預算`;
    }
  }

  if ($('#tmNextCountdownBadge')) {
    $('#tmNextCountdownBadge').textContent = `${nextPaydayLabel} 發薪 (倒數 ${up.daysUntilPayday} 天)`;
  }
  if ($('#tmUpcomingSourceTitle')) {
    $('#tmUpcomingSourceTitle').textContent = `📅 ${workM}月班表累積 ➔ ${nextPaydayLabel} 領`;
  }
  if ($('#tmUpcomingNetVal')) {
    $('#tmUpcomingNetVal').textContent = fmtMoney(currSh.estimatedNetPay || 0);
  }
  if ($('#tmUpcomingSubMeta')) {
    $('#tmUpcomingSubMeta').textContent = `${workM}月已排 ${currSh.shiftCount || 0} 天 (${currSh.normalHours || 0}h) · 下月可用 ${fmtMoney(up.projectedDailySafe || 0)}/天`;
  }

  if ($('#tmExplainText')) {
    if (isNextMonthPay) {
      $('#tmExplainText').innerHTML = `💡 <b>次月發薪對照中</b>：你現在打開班表 App 登記的 <b>${workM} 月份排班（預估實領 ${fmtMoney(currSh.estimatedNetPay || 0)}）</b>會在下個月 <b>${nextPaydayLabel}</b> 才發薪！現在（${String(cur.startDate || '').slice(5).replace('-', '/')}~${String(cur.endDate || '').slice(5).replace('-', '/')}）手頭實際可花的錢請直接填在下方：`;
    } else {
      $('#tmExplainText').innerHTML = `⚡ <b>當月直接抵用中</b>：目前直接將 <b>${workM} 月份班表（${fmtMoney(currSh.estimatedNetPay || 0)}）</b>當作現在的預算。若你的薪水是下個月（${nextPaydayLabel}）才發，可點右上角切回「<b>🕒 次月發薪制</b>」！`;
    }
  }

  if ($('#modalMappingModeBadge')) {
    $('#modalMappingModeBadge').textContent = isNextMonthPay ? '次月發薪制（推薦）' : '當月直接抵用';
  }
  if ($('#modalTimeMappingSummary')) {
    $('#modalTimeMappingSummary').innerHTML = `
      • <b>現在能花的錢 (${String(cur.startDate || '').slice(5).replace('-', '/')}~${String(cur.endDate || '').slice(5).replace('-', '/')})</b>：${esc(cur.activeSourceLabel || '')} ➔ <b>${fmtMoney(cur.effectiveIncome || 0)}</b><br/>
      • <b>下個月才領的錢 (${nextPaydayLabel} 發薪)</b>：對應 <b>${workM} 月班表 (${currSh.shiftCount || 0} 天 / ${currSh.normalHours || 0}h)</b> ➔ 預估實領 <b>${fmtMoney(currSh.estimatedNetPay || 0)}</b>
    `;
  }
  $$('[data-set-mapping-mode]').forEach(btn => {
    const active = btn.dataset.setMappingMode === tm.mappingMode;
    btn.className = `mapping-mode-btn btn-press py-2 px-3 rounded-xl text-xs ${active ? 'btn-primary' : 'btn-secondary'}`;
  });
}

function renderSettingsSection(settings) {
  if (!settings) return;
  const setValIfNotFocused = (sel, val) => {
    const el = $(sel);
    if (!el) return;
    el.classList.remove('hidden');
    if (document.activeElement !== el) {
      el.value = val;
    }
  };
  setValIfNotFocused('#setPayday', settings.payday_day);
  setValIfNotFocused('#setNetFactor', settings.net_pay_factor);
  setValIfNotFocused('#setLaborDeduct', settings.labor_health_deduction);
  if ($('#setShiftPath')) $('#setShiftPath').value = settings.shift_app_path;
  setValIfNotFocused('#setGmailUser', settings.gmail_user || '');
  setValIfNotFocused('#modalGmailUser', settings.gmail_user || '');
  $('#modalGmailPass')?.classList.remove('hidden');
}

function switchMainTab(target) {
  $$('[data-nav-tab]').forEach(b => {
    const active = b.dataset.navTab === target;
    b.className = `nav-tab-btn btn-press py-1.5 rounded-xl flex flex-col items-center gap-1 ${active ? 'text-[#0A84FF] font-semibold' : 'text-[#8E95A5] font-medium'}`;
  });
  $$('.tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${target}`));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function switchRecordSubtab(subtab) {
  $$('[data-record-subtab]').forEach(b => {
    const active = b.dataset.recordSubtab === subtab;
    b.className = `record-subtab-btn btn-press py-2.5 rounded-xl text-xs ${active ? 'font-semibold bg-[#252A38] text-[#F5F5F7] shadow-sm' : 'font-medium text-[#8E95A5]'}`;
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
    bar.className = 'fixed top-16 left-1/2 -translate-x-1/2 z-50 max-w-md w-[92%] rounded-2xl bg-[#1D212D]/95 backdrop-blur-xl text-[#F5F5F7] px-4 py-3 text-xs font-medium shadow-2xl border border-white/[0.12] transition-opacity duration-300';
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
      const shiftsObj = parsed?.state?.shifts || parsed?.shifts;
      if (parsed && ((shiftsObj && Object.keys(shiftsObj).length > 0) || Number(parsed.totalPay) > 0)) {
        return parsed;
      }
    }
    const v1Raw = localStorage.getItem('shiftpay.v1');
    if (v1Raw) {
      const parsed = JSON.parse(v1Raw);
      if (parsed && parsed.shifts && Object.keys(parsed.shifts).length > 0) {
        return parsed;
      }
    }
  } catch (_) {}
  return null;
}

async function importShiftPayloadAndBind(rawInput, sourceLabel = '手動匯入') {
  const data = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  if (!data || typeof data !== 'object') {
    throw new Error('無效的班表 JSON 格式');
  }

  const fullState = (data.state && typeof data.state === 'object' && data.state.shifts)
    ? data.state
    : ((data.fullState && typeof data.fullState === 'object' && data.fullState.shifts)
        ? data.fullState
        : (data.shifts && typeof data.shifts === 'object'
            ? {
                settings: data.settings || {},
                stamps: Array.isArray(data.stamps) ? data.stamps : undefined,
                shifts: data.shifts
              }
            : null));

  if (!fullState && typeof data.totalPay !== 'number') {
    throw new Error('找不到班表排班紀錄 (shifts) 或薪資資料，請確認檔案為「打工薪水帳」匯出之備份檔或 JSON');
  }

  if (fullState) {
    try {
      // 保留既有 Gemini API Key 避免被空字串覆蓋
      const prevRaw = localStorage.getItem('shiftpay.v1');
      const prevObj = prevRaw ? JSON.parse(prevRaw) : null;
      if (prevObj?.settings?.apiKey && fullState.settings && !fullState.settings.apiKey) {
        fullState.settings.apiKey = prevObj.settings.apiKey;
      }
    } catch (_) {}

    localStorage.setItem('shiftpay.v1', JSON.stringify(fullState));
    localStorage.setItem('shiftpay.v2.bridge', JSON.stringify({
      app: 'shiftpay-v2',
      updatedAt: new Date().toISOString(),
      month: data.month || undefined,
      state: fullState
    }));
  }

  const res = await apiCall('/api/shift/sync', 'POST', {
    rawJsonPayload: data,
    autoSync: false
  });

  if (res && res.dashboard) {
    renderDashboard(res.dashboard);
  }

  const iframe = $('#shiftAppIframe');
  if (iframe && iframe.src && iframe.src !== 'about:blank') {
    try {
      iframe.contentWindow?.location?.reload();
    } catch (_) {
      iframe.src = '/shift-pay?t=' + Date.now();
    }
  }

  showAutoToast(`🎉 已從${sourceLabel}成功導入班表與薪資！目前可用預算 $${Number(res?.cycle?.estimated_net_pay || res?.dashboard?.survival?.budget?.effectiveIncome || 0).toLocaleString()}`);
  return res;
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
    if (!clip || clip.length < 12 || clip === lastAutoClipboardText) return;

    // 1. 自動偵測剪貼簿中的「打工薪水帳 V2」JSON（匯出備份或小工具 JSON）
    if (clip.startsWith('{') && (clip.includes('"shiftpay-v2"') || (clip.includes('"shifts"') && clip.includes('"hourlyWage"')))) {
      lastAutoClipboardText = clip;
      await importShiftPayloadAndBind(clip, '手機剪貼簿');
      return;
    }

    if (clip.length > 1500) return;
    const isSwipeNotif = /玉山|信用卡|簽帳金融卡|簽帳卡|消費通知|刷卡|帳戶扣款|商店請款|薪資入帳|存款通知|存入通知|帳戶入帳|帳戶金額異動|轉帳轉出|轉帳支出|轉帳入帳|轉帳存入|ATM|無卡存款|跨行存款/.test(clip)
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
        const isDep = res.result.resultType === 'DEPOSIT_RECORDED';
        showAutoToast(isDep
          ? `🏧 自動偵測金融卡存款：${res.result.parsed?.normalizedMerchant || ''} +$${res.result.parsed?.amount || ''}`
          : `⚡ 自動偵測到刷卡通知：${res.result.parsed?.normalizedMerchant || ''} $${res.result.parsed?.amount || ''}`);
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
    const data = await apiCall('/api/dashboard');
    renderDashboard(data);
  } catch (err) {
    console.error(err);
  }

  // 監聽選用之「打工薪水帳 V2」內嵌視窗同步事件（僅更新班表領現參考，絕不覆蓋 ATM 存款預算）
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const bc = new BroadcastChannel('anti_broke_shift_sync');
      bc.addEventListener('message', ev => {
        if (ev.data && ev.data.type === 'SHIFT_STATE_UPDATED' && ev.data.payload) {
          autoSyncShiftFromBridge(ev.data.payload, false);
        }
      });
    }
  } catch (_) {}

  window.addEventListener('message', ev => {
    if (ev.data && ev.data.type === 'SHIFT_STATE_UPDATED' && ev.data.payload) {
      autoSyncShiftFromBridge(ev.data.payload, false);
    }
  });

  // 定期 15 秒即時同步雲端與本機自動入帳的 ATM 存款與刷卡扣款紀錄
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
          if (topTx.status === 'DEPOSIT') {
            showAutoToast(`🏧 自動偵測金融卡存款：${topTx.normalized_merchant} +$${topTx.effective_amount}`);
          } else {
            showAutoToast(`💳 自動偵測新扣款：${topTx.normalized_merchant} -$${topTx.effective_amount}`);
          }
        } else if (newIncome !== prevIncome) {
          showAutoToast(`🏦 本月可用預算已更新為 $${newIncome.toLocaleString()}`);
        }
      }
    } catch (_) {}
  }, 15000);

  window.addEventListener('focus', () => {
    checkClipboardForBankNotification();
  });

  $$('[data-nav-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchMainTab(btn.dataset.navTab));
  });

  $$('[data-record-subtab]').forEach(btn => {
    btn.addEventListener('click', () => switchRecordSubtab(btn.dataset.recordSubtab));
  });

  const setTxFilterAndRender = filterKey => {
    currentTxFilter = filterKey;
    $$('#txFilterBar [data-tx-filter]').forEach(btn => {
      const on = btn.dataset.txFilter === currentTxFilter;
      btn.className = `btn-press shrink-0 px-3.5 py-2 rounded-full text-xs ${on ? 'font-semibold bg-[#0A84FF] text-white' : 'font-medium bg-[#151821] border border-white/[0.08] text-[#8E95A5]'}`;
    });
    if (dashboardState) renderTransactionsList(dashboardState.transactions);
  };

  $('#btnHomeQuickCash')?.addEventListener('click', () => {
    switchMainTab('wallet');
    setTimeout(() => $('#cashExpenseNameInput')?.focus(), 250);
  });
  $('#btnHomeQuickAtm')?.addEventListener('click', () => {
    switchMainTab('wallet');
    setTimeout(() => $('#quickAtmDepositInput')?.focus(), 250);
  });
  $('#btnHomeQuickImpulse')?.addEventListener('click', () => openImpulse());
  $('#btnHomeQuickNotif')?.addEventListener('click', () => openNotif());
  $('#btnHomeGoWalletCash')?.addEventListener('click', () => switchMainTab('wallet'));
  $('#btnHomeGoWalletEasy')?.addEventListener('click', () => switchMainTab('wallet'));
  $('#btnHomeViewAllTx')?.addEventListener('click', () => switchMainTab('records'));

  $('#cardGoCooldown')?.addEventListener('click', () => {
    switchMainTab('impulse');
  });

  $('#cardGoDeposits')?.addEventListener('click', () => {
    switchMainTab('records');
    setTxFilterAndRender('DEPOSIT');
  });

  $('#cardGoTransactions')?.addEventListener('click', () => {
    switchMainTab('records');
    setTxFilterAndRender('SPENT_ALL');
  });

  const openImpulse = () => {
    $('#impulseEvalOutput')?.classList.add('hidden');
    $('#modalImpulse')?.classList.remove('hidden');
  };
  $('#btnOpenImpulseModal')?.addEventListener('click', openImpulse);
  $('#btnOpenImpulseFromList')?.addEventListener('click', openImpulse);

  const openNotif = () => {
    $('#modalGmailUser')?.classList.remove('hidden');
    $('#modalGmailPass')?.classList.remove('hidden');
    $('#modalNotifParser')?.classList.remove('hidden');
  };
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
      box.className = 'rounded-xl p-4 text-xs bg-emerald-500/12 border border-emerald-500/25 text-emerald-300 font-medium';
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
      btn.className = `btn-press shrink-0 px-3.5 py-2 rounded-full text-xs ${on ? 'font-semibold bg-[#0A84FF] text-white' : 'font-medium bg-[#151821] border border-white/[0.08] text-[#8E95A5]'}`;
    });
    if (dashboardState) renderTransactionsList(dashboardState.transactions);
  });

  const MODAL_OVERLAY_IDS = new Set([
    'modalImpulse',
    'modalNotifParser',
    'modalShiftSync',
    'modalBalanceSync',
    'modalFixedExpense'
  ]);

  document.body.addEventListener('click', async e => {
    if (e.target.id && MODAL_OVERLAY_IDS.has(e.target.id)) {
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
      const dAmt = Number(deltaAmount) || 0;
      const res = await apiCall('/api/wallet-tank/adjust', 'POST', { tankType, deltaAmount: dAmt, note });
      renderDashboard(res.dashboard);
      const label = tankType === 'EASYCARD' ? '💳 悠遊卡' : '💵 皮包現金';
      const bal = tankType === 'EASYCARD' ? res.walletTank?.easycardBalance : res.walletTank?.cashBalance;
      showAutoToast(
        dAmt >= 0
          ? `${label}已加值 +$${Math.abs(dAmt).toLocaleString()}（目前餘額 $${Number(bal || 0).toLocaleString()}）`
          : `${label}已扣款 -$${Math.abs(dAmt).toLocaleString()}（目前餘額 $${Number(bal || 0).toLocaleString()}）`
      );
      return;
    }

    const settleSplit = e.target.closest('[data-settle-split]');
    if (settleSplit) {
      const res = await apiCall('/api/split-bills/settle', 'POST', { splitBillId: Number(settleSplit.dataset.settleSplit) });
      renderDashboard(res.dashboard);
      return;
    }

    const delTx = e.target.closest('[data-del-tx]');
    if (delTx) {
      const res = await apiCall('/api/transactions/delete', 'POST', { txId: Number(delTx.dataset.delTx) });
      renderDashboard(res.dashboard);
      showAutoToast('🗑️ 已刪除該筆紀錄並同步更新餘額！');
      return;
    }
  });

  $$('[data-imp-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedImpulseType = btn.dataset.impType;
      $$('[data-imp-type]').forEach(b => {
        const on = b.dataset.impType === selectedImpulseType;
        b.className = `imp-type-btn btn-press py-3 rounded-xl text-xs ${on ? 'font-semibold bg-[#0A84FF] text-white shadow-sm' : 'font-medium bg-[#232836] text-[#8E95A5] border border-white/[0.08]'}`;
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
        <div class="flex flex-wrap gap-2">
          <span class="px-3 py-1 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/25 text-xs font-medium">⏱️ 需站班表 ${esc(ev.sweatWork.hours)}h ${esc(ev.sweatWork.minutes)}m</span>
          <span class="px-3 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/25 text-xs font-medium">☕ 約 ${coffeeCups} 杯咖啡</span>
          <span class="px-3 py-1 rounded-full bg-white/[0.06] text-[#D1D5DB] text-xs font-medium">📉 日預算 $${ev.survivalImpact.dailyBudgetBefore} ➔ $${ev.survivalImpact.dailyBudgetAfter}</span>
        </div>
        <div class="text-xs text-[#D1D5DB] whitespace-pre-line leading-relaxed bg-black/30 p-4 rounded-xl border border-white/[0.06]">${esc(ev.aiRoastMessage)}</div>
        <div class="flex items-center justify-between pt-1">
          <span class="text-xs font-medium ${ev.lockedIn72hPool ? 'text-amber-300' : 'text-emerald-300'}">
            ${ev.lockedIn72hPool ? '🔒 已鎖入 72h 冷卻清單' : '✅ 評估完成'}
          </span>
          <button type="button" id="btnViewCooldownNow" class="btn-press btn-primary px-4 py-2 rounded-full text-xs">查看冷卻清單</button>
        </div>
      `;
      $('#impItemName').value = '';
      $('#impAmount').value = '';
      $('#impReason').value = '';
      $('#btnViewCooldownNow')?.addEventListener('click', () => {
        $('#modalImpulse')?.classList.add('hidden');
        switchMainTab('impulse');
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

  const handleCustomTankDelta = async (tankType, inputSel) => {
    const inputEl = $(inputSel);
    if (!inputEl) return;
    const cleaned = String(inputEl.value || '')
      .trim()
      .replace(/[＋]/g, '+')
      .replace(/[－﹣—–]/g, '-')
      .replace(/[$,，\s元]/g, '');
    if (!cleaned) return;
    const isNegative = cleaned.startsWith('-');
    const numPart = cleaned.replace(/^[+-]+/, '');
    const num = Math.round(Number(numPart));
    if (!numPart || !Number.isFinite(num) || num === 0) return;

    // 輸入正數 (60) 或明確加號 (+60) 皆為加值存入；輸入負數 (-60) 則為扣款消費
    const deltaAmount = isNegative ? -Math.abs(num) : Math.abs(num);
    const note = deltaAmount < 0 ? '自訂金額扣款' : '自訂金額加值';
    const res = await apiCall('/api/wallet-tank/adjust', 'POST', { tankType, deltaAmount, note });
    inputEl.value = '';
    renderDashboard(res.dashboard);
    const label = tankType === 'EASYCARD' ? '💳 悠遊卡' : '💵 皮包現金';
    const bal = tankType === 'EASYCARD' ? res.walletTank?.easycardBalance : res.walletTank?.cashBalance;
    showAutoToast(
      deltaAmount >= 0
        ? `${label}已加值 +$${Math.abs(deltaAmount).toLocaleString()}（目前餘額 $${Number(bal || 0).toLocaleString()}）`
        : `${label}已扣款 -$${Math.abs(deltaAmount).toLocaleString()}（目前餘額 $${Number(bal || 0).toLocaleString()}）`
    );
  };

  $('#btnCustomEasyAdjust')?.addEventListener('click', () => handleCustomTankDelta('EASYCARD', '#customEasyDeltaInput'));
  $('#btnCustomCashAdjust')?.addEventListener('click', () => handleCustomTankDelta('CASH', '#customCashDeltaInput'));
  $('#customEasyDeltaInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleCustomTankDelta('EASYCARD', '#customEasyDeltaInput');
  });
  $('#customCashDeltaInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleCustomTankDelta('CASH', '#customCashDeltaInput');
  });

  $('#btnAuditTank')?.addEventListener('click', async () => {
    const easyVal = $('#auditEasyInput').value.trim();
    const cashVal = $('#auditCashInput').value.trim();
    if (easyVal === '' && cashVal === '') return;
    const res = await apiCall('/api/wallet-tank/audit', 'POST', {
      easycardBalance: easyVal !== '' ? easyVal : undefined,
      cashBalance: cashVal !== '' ? cashVal : undefined
    });
    $('#auditEasyInput').value = '';
    $('#auditCashInput').value = '';
    renderDashboard(res.dashboard);
  });

  // ✍️ 首頁直接登記「使用現金消費」
  const handleQuickRecordCashExpense = async () => {
    const itemName = ($('#cashExpenseNameInput')?.value || '').trim() || '現金消費';
    const rawAmt = ($('#cashExpenseAmountInput')?.value || '').trim();
    const amount = Math.round(Number(rawAmt));
    const category = $('#cashExpenseCategorySelect')?.value || '餐飲外食';
    const countInBudget = Boolean($('#chkCashCountInBudget')?.checked);

    if (!rawAmt || !Number.isFinite(amount) || amount <= 0) {
      return alert('請輸入大於 0 的現金消費金額！');
    }
    try {
      const res = await apiCall('/api/cash/spend', 'POST', {
        itemName,
        amount,
        category,
        countInBudget
      });
      if ($('#cashExpenseNameInput')) $('#cashExpenseNameInput').value = '';
      if ($('#cashExpenseAmountInput')) $('#cashExpenseAmountInput').value = '';
      renderDashboard(res.dashboard);
      showAutoToast(`💵 已登記現金消費：${itemName} -$${amount.toLocaleString()}（皮包餘 $${res.walletTank?.cashBalance ?? 0}）`);
    } catch (err) {
      alert(err.message);
    }
  };

  $('#btnQuickRecordCashExpense')?.addEventListener('click', handleQuickRecordCashExpense);
  $('#cashExpenseAmountInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleQuickRecordCashExpense();
  });

  // 🏧 首頁直接登記「往金融卡存錢 (ATM 存款)」
  const handleQuickAtmDeposit = async () => {
    const rawAmt = ($('#quickAtmDepositInput')?.value || '').trim();
    const amount = Math.round(Number(rawAmt));
    const deductFromWalletCash = Boolean($('#chkAtmDeductCash')?.checked);

    if (!rawAmt || !Number.isFinite(amount) || amount <= 0) {
      return alert('請輸入存入金融卡的金額！');
    }
    try {
      const res = await apiCall('/api/deposits/add', 'POST', {
        amount,
        merchant: '玉山 ATM 存款',
        category: 'ATM存款',
        deductFromWalletCash
      });
      if ($('#quickAtmDepositInput')) $('#quickAtmDepositInput').value = '';
      renderDashboard(res.dashboard);
      showAutoToast(`🏧 已存入金融卡 +$${amount.toLocaleString()}！本月可用預算與存款紀錄已同步更新`);
    } catch (err) {
      alert(err.message);
    }
  };

  $('#btnQuickAtmDeposit')?.addEventListener('click', handleQuickAtmDeposit);
  $('#quickAtmDepositInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleQuickAtmDeposit();
  });

  // ⏳ 薪資班表 ↔ 現實發薪時間對照模式切換與目前預算設定
  const switchMappingMode = async targetMode => {
    const res = await apiCall('/api/shift/sync', 'POST', {
      mappingMode: targetMode,
      clearManualSalary: targetMode === 'SAME_MONTH_PAY',
      recalculateOnly: true
    });
    renderDashboard(res.dashboard);
    showAutoToast(
      targetMode === 'NEXT_MONTH_PAY'
        ? '🕒 已切換為「次月發薪制」：本月排班歸入下月發薪預估！'
        : '⚡ 已切換為「當月抵用制」：直接以本月排班作為目前可用預算！'
    );
  };

  $('#btnToggleMappingMode')?.addEventListener('click', async () => {
    const curMode = dashboardState?.survival?.timeMapping?.mappingMode || 'NEXT_MONTH_PAY';
    const nextMode = curMode === 'NEXT_MONTH_PAY' ? 'SAME_MONTH_PAY' : 'NEXT_MONTH_PAY';
    await switchMappingMode(nextMode);
  });

  $$('[data-set-mapping-mode]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await switchMappingMode(btn.dataset.setMappingMode);
    });
  });

  const handleSetQuickCurrentSalary = async () => {
    const inputEl = $('#quickCurrentSalaryInput');
    if (!inputEl) return;
    const val = inputEl.value.trim();
    if (val === '') return alert('請輸入目前（本週期）手頭實際可用的薪水預算金額！');
    const res = await apiCall('/api/shift/sync', 'POST', {
      manualNetSalary: Number(val),
      mappingMode: 'NEXT_MONTH_PAY'
    });
    inputEl.value = '';
    renderDashboard(res.dashboard);
    showAutoToast(`💵 已設定目前週期可用預算 $${Number(val).toLocaleString()}（本月排班將繼續累積於下月發薪預估）！`);
  };

  $('#btnSetQuickCurrentSalary')?.addEventListener('click', handleSetQuickCurrentSalary);
  $('#quickCurrentSalaryInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSetQuickCurrentSalary();
  });

  // 📲 導入手機主畫面「打工薪水帳」備份檔 (.json) 或剪貼簿資料
  const triggerShiftFilePicker = () => $('#shiftBackupFileInput')?.click();
  $('#btnTriggerShiftFileImport')?.addEventListener('click', triggerShiftFilePicker);
  $('#btnEmbedImportShift')?.addEventListener('click', triggerShiftFilePicker);

  $('#shiftBackupFileInput')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      await importShiftPayloadAndBind(text, `備份檔 (${file.name})`);
      $('#modalShiftSync')?.classList.add('hidden');
    } catch (err) {
      alert('匯入班表備份檔失敗：' + err.message);
    }
  });

  $('#btnImportShiftFromClipboard')?.addEventListener('click', async () => {
    let raw = '';
    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        raw = (await navigator.clipboard.readText() || '').trim();
      }
    } catch (_) {}
    if (!raw || !raw.startsWith('{')) {
      raw = (prompt('請長按貼上從主畫面「打工薪水帳」複製的班表 JSON 數據：') || '').trim();
    }
    if (!raw) return;
    try {
      await importShiftPayloadAndBind(raw, '剪貼簿');
      $('#modalShiftSync')?.classList.add('hidden');
    } catch (err) {
      alert('從剪貼簿導入失敗：' + err.message);
    }
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
        box.className = 'rounded-xl p-4 text-xs bg-[#0A84FF]/15 border border-[#0A84FF]/30 text-sky-300 font-medium';
        box.textContent = res.imap.message;
      }
      showAutoToast(res.imap.message);
    } finally {
      if (btn) btn.textContent = '🔄 立即掃描 Gmail 刷卡信';
    }
  });

  $('#btnCopyIosAiPrompt')?.addEventListener('click', async () => {
    const base = window.location?.origin || 'https://anti-broke-finance-app.mr-haibaoseal.workers.dev';
    const aiPrompt = `當收到玉山銀行app時 發送給${base}/api/notifications/webhook`;
    try {
      await navigator.clipboard.writeText(aiPrompt);
      showAutoToast('✨ 已複製實測可用的 iOS 捷徑提示詞！');
    } catch (_) {
      prompt('請複製以下提示詞貼入「描述捷徑」：', aiPrompt);
    }
  });

  $('#btnCopyMethodBAiPrompt')?.addEventListener('click', async () => {
    const base = window.location?.origin || 'https://anti-broke-finance-app.mr-haibaoseal.workers.dev';
    const aiPrompt = `使用「取得 URL 內容」對 ${base}/api/notifications/webhook 發送 POST 要求，要求主體選擇 JSON，新增文字欄位 text 並設為「捷徑輸入」`;
    try {
      await navigator.clipboard.writeText(aiPrompt);
      showAutoToast('✨ 已複製「方式 B：全通路刷卡通知」捷徑 AI 提示詞！請貼入「描述捷徑」');
    } catch (_) {
      prompt('請複製以下「方式 B」iOS 捷徑 AI 提示詞貼入「描述捷徑」：', aiPrompt);
    }
  });

  $('#btnSaveAndPollGmailModal')?.addEventListener('click', async () => {
    const gmailUser = ($('#modalGmailUser')?.value || '').trim();
    const gmailAppPassword = ($('#modalGmailPass')?.value || '').trim();
    if (!gmailUser) {
      return alert('請先輸入你的 Gmail 信箱帳號！');
    }
    const btn = $('#btnSaveAndPollGmailModal');
    if (btn) btn.textContent = '⏳ 正在儲存並掃描 Gmail...';
    try {
      await apiCall('/api/settings', 'POST', {
        gmailUser,
        gmailAppPassword: gmailAppPassword || undefined
      });
      const res = await apiCall('/api/notifications/gmail-poll', 'POST', {});
      renderDashboard(res.dashboard);
      const box = $('#notifResultBox');
      if (box) {
        box.classList.remove('hidden');
        box.className = 'rounded-xl p-4 text-xs bg-emerald-500/12 border border-emerald-500/25 text-emerald-300 font-medium';
        box.textContent = res.imap.message;
      }
      showAutoToast(res.imap.message);
    } catch (err) {
      alert(err.message);
    } finally {
      if (btn) btn.textContent = '⚡ 儲存 Gmail 並立即啟動每分鐘全自動抓信';
    }
  });

  $('#btnCopyApplePayUrl')?.addEventListener('click', async () => {
    const base = window.location?.origin || 'https://anti-broke-finance-app.mr-haibaoseal.workers.dev';
    const url = `${base}/api/notifications/apple-pay`;
    try {
      await navigator.clipboard.writeText(url);
      showAutoToast('🍎 已複製 Apple Pay 專用網址！請於「取得 URL 內容」貼上並設為 POST');
    } catch (_) {
      prompt('請複製以下 Apple Pay 自動入帳網址：', url);
    }
  });

  $('#btnSimulateApplePay')?.addEventListener('click', async () => {
    try {
      const res = await apiCall('/api/notifications/apple-pay', 'POST', {
        source: 'apple_pay_auto',
        merchant: '星巴克 STARBUCKS',
        amount: 155,
        card: '玉山 U Bear (Apple Pay)'
      });
      const box = $('#notifResultBox');
      if (box) {
        box.classList.remove('hidden');
        box.className = 'rounded-xl p-4 text-xs bg-emerald-500/12 border border-emerald-500/25 text-emerald-300 font-medium';
        box.textContent = `🍎【Apple Pay 自動入帳成功】${res.result.message}`;
      }
      renderDashboard(res.dashboard);
      showAutoToast(`🍎 Apple Pay 感應入帳：${res.result.parsed?.normalizedMerchant} -$${res.result.parsed?.amount}`);
    } catch (err) {
      alert(err.message);
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
