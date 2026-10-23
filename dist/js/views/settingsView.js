import { $, fmtMoney, esc } from '../utils/formatters.js';

/**
 * 分頁 5：【設定與抓漏分析】渲染器
 * 包含：每月起始數位預算設定、打工薪水試算手動帶入、每月固定扣款/訂閱管理、7天小額吸血鬼雷達、相簿零殘留 iOS 捷徑教學與開發測試區
 */
export function renderSettingsView(state) {
  const { settings, budgetOverview, radar } = state;

  if (budgetOverview && settings) {
    const cycle = budgetOverview.cycle;
    $('#settingBaseBudgetDisplay').textContent = fmtMoney(cycle.baseBudget);
    $('#settingBudgetNoteDisplay').textContent = cycle.budgetNote || '手動設定';
    $('#settingWageDisplay').textContent = fmtMoney(settings.default_hourly_wage);

    const setIfNotFocused = (sel, val) => {
      const el = $(sel);
      if (el && document.activeElement !== el) el.value = val;
    };
    setIfNotFocused('#inputBaseBudget', cycle.baseBudget);
    setIfNotFocused('#inputHourlyWage', settings.default_hourly_wage);
    setIfNotFocused('#setPayday', settings.payday_day);
    setIfNotFocused('#setNetFactor', settings.net_pay_factor);
    setIfNotFocused('#setLaborDeduct', settings.labor_health_deduction);
    setIfNotFocused('#setDedupeWindow', settings.dedupe_window_minutes);
  }

  if (radar) {
    const vr = radar.vampireRadar || {};
    const fx = radar.fixedExpenses || {};

    const vBanner = $('#vampireAlertBanner');
    if (vr.alertText) {
      vBanner.textContent = vr.alertText;
      vBanner.classList.remove('hidden');
    } else {
      vBanner.classList.add('hidden');
    }

    const lb = $('#vampireLeaderboard');
    if (!vr.leaderboard || vr.leaderboard.length === 0) {
      lb.innerHTML = `<div class="text-center py-5 text-xs text-[#8E95A5]">過去 7 天尚無單筆低於 $200 的小額消費</div>`;
    } else {
      lb.innerHTML = vr.leaderboard.map((g, idx) => `
        <div class="apple-inset ${g.isVampireAlert ? 'border-rose-500/35 bg-rose-500/10' : ''} flex items-center justify-between gap-3">
          <div class="space-y-1">
            <div class="text-sm font-semibold text-[#F5F5F7] flex items-center gap-2">
              <span class="px-2 py-0.5 rounded-md bg-white/[0.06] text-xs text-[#8E95A5] tabular-nums">#${idx + 1}</span>
              <span>${esc(g.name)}</span>
              ${g.isVampireAlert ? '<span class="px-2.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-medium">高頻失血</span>' : ''}
            </div>
            <div class="text-xs text-[#8E95A5]">7 天內 ${g.count} 次 · ${esc(g.category)}</div>
          </div>
          <div class="text-base font-bold text-rose-400 tabular-nums">-${fmtMoney(g.totalAmount)}</div>
        </div>
      `).join('');
    }

    $('#subAlertsWrap').innerHTML = (fx.subscriptionAlerts || []).map(a => `
      <div class="rounded-xl bg-amber-500/12 border border-amber-500/25 px-4 py-3 text-xs font-medium text-amber-300">${esc(a)}</div>
    `).join('');

    const fxItems = fx.items || [];
    $('#fixedExpenseList').innerHTML = fxItems.length === 0
      ? `<div class="text-center py-4 text-xs text-[#8E95A5]">尚未設定每月固定扣款或訂閱</div>`
      : fxItems.map(f => `
        <div class="apple-inset !py-3 !px-4 flex items-center justify-between gap-3 text-xs">
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="px-2.5 py-0.5 rounded-full bg-white/[0.06] border border-white/[0.08] text-[#D1D5DB] text-xs font-medium shrink-0">
              ${f.expense_type === 'SUBSCRIPTION' ? '訂閱' : '固定'}
            </span>
            <span class="font-semibold text-sm text-[#F5F5F7] truncate">${esc(f.name)}</span>
            <span class="text-[#8E95A5] shrink-0">每月 ${f.billing_day} 號</span>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span class="font-bold text-sm text-[#F5F5F7] tabular-nums">${fmtMoney(f.monthly_amount)}</span>
            <button type="button" data-del-fixed="${f.id}" class="text-[#8E95A5] hover:text-rose-400 px-2 py-1 rounded-lg hover:bg-white/[0.06]">✕</button>
          </div>
        </div>
      `).join('');
  }
}
