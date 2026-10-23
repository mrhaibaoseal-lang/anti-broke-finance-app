import { $, fmtMoney, esc } from '../utils/formatters.js';
import { renderRecentAtmDepositsInModal } from './modals.js';

/**
 * 分頁 1：【首頁總覽】渲染器
 * 獨立並排顯示三大核心資產指標：
 *  1. 💳 本月數位可用預算 (決定四級生存狀態)
 *  2. 💵 實體水庫總額 (皮包現金 + 悠遊卡)
 *  3. 💰 最終總可用剩餘 (數位預算 + 實體水庫)
 */
export function renderHomeView(state) {
  const { budgetOverview, highRiskMode, cooldownCart, entries } = state;
  const { cycle, metrics, tier } = budgetOverview;

  // 頂部週期與高風險防禦狀態
  $('#cycleDateLabel').textContent = `${cycle.startDate.slice(5)} ~ ${cycle.endDate.slice(5)}`;
  document.body.classList.toggle('high-risk-mode', Boolean(highRiskMode?.isHighRisk));

  const hrBanner = $('#highRiskBanner');
  if (highRiskMode?.isHighRisk) {
    hrBanner.textContent = highRiskMode.warningBanner;
    hrBanner.classList.remove('hidden');
    $('#highRiskBtnLabel').textContent = '防禦中';
  } else {
    hrBanner.classList.add('hidden');
    $('#highRiskBtnLabel').textContent = '夜間防禦';
  }

  // 警示堆疊：破產預警 + 10 分鐘疑似重複入帳待確認橫幅
  const alertsHtml = [];
  if (metrics.bankruptcyWarningText) {
    alertsHtml.push(`
      <div class="rounded-2xl bg-rose-500/12 border border-rose-500/25 px-4 py-3 text-xs font-medium text-rose-300">
        ${esc(metrics.bankruptcyWarningText)}
      </div>
    `);
  }

  const suspectedList = (entries || []).filter(e => e.dedupe_status === 'SUSPECTED_DUPLICATE');
  for (const item of suspectedList) {
    alertsHtml.push(`
      <div class="rounded-2xl bg-amber-500/15 border border-amber-500/35 px-4 py-3 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-3">
        <div class="space-y-0.5">
          <div class="font-semibold text-amber-300">⚠️ 偵測到 10 分鐘內疑似重複入帳（暫未扣減預算）</div>
          <div>${esc(item.normalized_merchant)} · <b>${fmtMoney(item.amount)}</b> (${esc(item.tx_date)})</div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button type="button" data-resolve-dup="${item.id}|DELETE" class="btn-press btn-danger-soft px-3 py-1.5 rounded-xl text-xs">
            🗑️ 是重複的，刪除
          </button>
          <button type="button" data-resolve-dup="${item.id}|CONFIRM" class="btn-press btn-primary px-3 py-1.5 rounded-xl text-xs">
            ✅ 真的買兩次，確認入帳
          </button>
        </div>
      </div>
    `);
  }
  $('#alertStack').innerHTML = alertsHtml.join('');

  // 主卡片四級生存動態外發光與三大核心指標並排顯示
  const mainCard = $('#survivalMainCard');
  mainCard.className = `bento-card p-6 sm:p-8 space-y-6 tier-glow-${tier.code}`;

  $('#tierBadge').textContent = `${tier.emoji} ${tier.label}`;
  $('#dailySafeAmount').textContent = fmtMoney(metrics.dailySafeBudget);
  $('#daysRemainingVal').textContent = cycle.daysRemaining;
  $('#paydayDayVal').textContent = cycle.paydayDay;

  // 三大資產指標：💳 數位可用預算 / 💵 實體水庫總額 / 💰 最終總可用剩餘
  $('#metricDigitalRemaining').textContent = fmtMoney(metrics.digitalRemainingBudget);
  $('#metricPhysicalTankTotal').textContent = fmtMoney(metrics.physicalTankTotal);
  $('#metricGrandTotalAvailable').textContent = fmtMoney(metrics.grandTotalAvailable);

  // 次要細項指標
  $('#metricBaseBudget').textContent = fmtMoney(cycle.baseBudget);
  $('#metricFixedTotal').textContent = '-' + fmtMoney(metrics.fixedTotal);
  $('#metricTodaySpent').textContent = fmtMoney(metrics.todayDigitalSpent + metrics.todayCashSpent);
  $('#tierAdviceText').textContent = tier.advice;

  // 雙水庫速覽卡與下方概覽卡
  $('#homeCashVal').textContent = fmtMoney(metrics.cashBalance);
  $('#homeEasyVal').textContent = fmtMoney(metrics.easycardBalance);
  $('#homeDigitalSpentTotal').textContent = fmtMoney(metrics.digitalExpenseTotal);
  $('#homeCashSpentTotal').textContent = fmtMoney(metrics.cashExpenseTotal);
  $('#homeAtmDepositedTotal').textContent = '+' + fmtMoney(metrics.atmCashDepositedToCard);

  if (cooldownCart) {
    $('#homeSavedTotalVal').textContent = fmtMoney(cooldownCart.savedTotalAmount);
    $('#homeSavedCountVal').textContent = cooldownCart.abandonedCount;
    $('#homeCoolingCountVal').textContent = (cooldownCart.coolingItems || []).length;
  }

  // 同步更新 ATM 存款彈窗內的最近存入清單
  renderRecentAtmDepositsInModal(entries || []);
}
