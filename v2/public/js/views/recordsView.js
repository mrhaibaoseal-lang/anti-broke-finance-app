import { $, $$, fmtMoney, esc, flowTypeMeta } from '../utils/formatters.js';
import { getStore } from '../store.js';

/**
 * 分頁 3：【明細】渲染器
 * 支援依六大資金流向篩選、一鍵編輯修改金額/屬性 (含 ATM 存款反悔修改)、一鍵撤銷回滾刪除、聚餐拆帳與黑洞拆分
 */
export function renderRecordsView(state) {
  const { entries = [], budgetOverview } = state;
  const filter = getStore().recordFilter || 'ALL';

  if (budgetOverview) {
    $('#txSummaryDigitalSpent').textContent = '-' + fmtMoney(budgetOverview.metrics.digitalExpenseTotal);
    $('#txSummaryCashSpent').textContent = '-' + fmtMoney(budgetOverview.metrics.cashExpenseTotal);
    $('#txSummaryAtmDeposited').textContent = '+' + fmtMoney(budgetOverview.metrics.atmCashDepositedToCard);
  }

  $$('[data-tx-filter]').forEach(btn => {
    const active = btn.dataset.txFilter === filter;
    btn.className = active
      ? 'btn-press shrink-0 px-3.5 py-2 rounded-full text-xs font-semibold bg-[#0A84FF] text-white'
      : 'btn-press shrink-0 px-3.5 py-2 rounded-full text-xs font-medium bg-[#151821] border border-white/[0.08] text-[#D1D5DB]';
  });

  const filtered = entries.filter(e => {
    if (filter === 'ALL') return true;
    if (filter === 'SUSPECTED_DUPLICATE') return e.dedupe_status === 'SUSPECTED_DUPLICATE';
    if (filter === 'ADVANCE_ALL') return e.flow_type === 'ADVANCE_OUT' || e.flow_type === 'ADVANCE_IN' || Boolean(e.split_id);
    return e.flow_type === filter;
  });

  const container = $('#txListContainer');
  if (filtered.length === 0) {
    container.innerHTML = `<div class="bento-card text-center py-10 text-xs text-[#8E95A5]">此篩選分類下尚無明細紀錄</div>`;
    return;
  }

  container.innerHTML = filtered.map(e => {
    const meta = flowTypeMeta(e);
    const isPositiveFlow = e.flow_type === 'INCOME_DEPOSIT' || e.flow_type === 'ADVANCE_IN' || Number(e.budget_impact_amount) < 0;
    const amountColor = e.dedupe_status === 'SUSPECTED_DUPLICATE'
      ? 'text-amber-300'
      : (isPositiveFlow ? 'text-emerald-400' : (e.flow_type === 'INTERNAL_TRANSFER' || e.flow_type === 'ADVANCE_OUT' ? 'text-sky-300' : 'text-[#F5F5F7]'));
    const signPrefix = isPositiveFlow ? '+' : (e.flow_type === 'EXPENSE' || e.flow_type === 'UNKNOWN_GAP' ? '-' : '');

    return `
      <div class="bento-card !p-5 space-y-3.5 ${e.dedupe_status === 'SUSPECTED_DUPLICATE' ? 'border-amber-500/40' : ''}">
        <div class="flex items-start justify-between gap-3">
          <div class="space-y-1.5 min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="px-2.5 py-0.5 rounded-full text-[11px] font-medium ${meta.badgeClass}">${meta.label}</span>
              <span class="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-[11px] text-[#8E95A5]">${esc(e.category)}</span>
              <span class="text-[11px] text-[#8E95A5] tabular-nums">${esc(e.tx_date)}</span>
            </div>
            <div class="text-base font-semibold text-[#F5F5F7] truncate">${esc(e.normalized_merchant)}</div>
            <div class="text-xs text-[#8E95A5] leading-relaxed">${esc(e.note)}</div>
          </div>
          <div class="text-right shrink-0 space-y-1">
            <div class="text-lg font-bold tabular-nums ${amountColor}">${signPrefix}${fmtMoney(e.amount)}</div>
            <div class="text-[11px] text-[#8E95A5] tabular-nums">
              ${Number(e.budget_impact_amount) > 0
                ? `扣數位預算 -$${Number(e.budget_impact_amount).toLocaleString()}`
                : (Number(e.budget_impact_amount) < 0
                    ? `增數位預算 +$${Math.abs(Number(e.budget_impact_amount)).toLocaleString()}`
                    : '不影響數位預算')}
            </div>
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-white/[0.06]">
          ${e.dedupe_status === 'SUSPECTED_DUPLICATE' ? `
            <button type="button" data-resolve-dup="${e.id}|CONFIRM" class="btn-press btn-primary px-3 py-1.5 rounded-xl text-xs">
              ✅ 確認入帳
            </button>
          ` : ''}
          ${e.flow_type === 'EXPENSE' ? `
            <button type="button" data-open-split="${e.id}" class="btn-press btn-secondary px-3 py-1.5 rounded-xl text-xs">
              🤝 聚餐拆帳
            </button>
          ` : ''}
          ${e.flow_type === 'UNKNOWN_GAP' ? `
            <button type="button" data-open-gap-split="${e.id}" class="btn-press btn-primary px-3 py-1.5 rounded-xl text-xs">
              🔍 拆分黑洞明細
            </button>
          ` : ''}
          <button type="button" data-edit-entry="${e.id}" class="btn-press btn-secondary px-3 py-1.5 rounded-xl text-xs">
            ✏️ 修改
          </button>
          <button type="button" data-delete-entry="${e.id}" class="btn-press btn-danger-soft px-3 py-1.5 rounded-xl text-xs">
            ↩️ 撤銷/刪除
          </button>
        </div>
      </div>
    `;
  }).join('');
}
