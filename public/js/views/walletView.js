import { $, fmtMoney, esc } from '../utils/formatters.js';

/**
 * 分頁 2：【錢包】渲染器 (皮包現金 & 悠遊卡雙水庫、朋友代墊應收池、玉山可用餘額校正)
 */
export function renderWalletView(state) {
  const { walletTank, splitBills, budgetOverview } = state;

  if (walletTank) {
    $('#tankCashVal').textContent = fmtMoney(walletTank.cashBalance);
    $('#tankEasycardVal').textContent = fmtMoney(walletTank.easycardBalance);

    const tBanner = $('#tankAuditBanner');
    if (walletTank.needsAuditAlert && walletTank.auditAlertText) {
      tBanner.textContent = walletTank.auditAlertText;
      tBanner.classList.remove('hidden');
    } else {
      tBanner.classList.add('hidden');
    }

    const logs = walletTank.logs || [];
    const lastCash = logs.find(l => l.tank_type === 'CASH');
    const lastEasy = logs.find(l => l.tank_type === 'EASYCARD');
    $('#tankCashLastNote').innerHTML = lastCash
      ? `最新：<b class="${lastCash.delta_amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${lastCash.delta_amount >= 0 ? '+' : '-'}$${Math.abs(lastCash.delta_amount)}</b> (${esc(lastCash.note)})`
      : '可輸入 100、+100 加值或 -100 扣減';
    $('#tankEasyLastNote').innerHTML = lastEasy
      ? `最新：<b class="${lastEasy.delta_amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${lastEasy.delta_amount >= 0 ? '+' : '-'}$${Math.abs(lastEasy.delta_amount)}</b> (${esc(lastEasy.note)})`
      : '可輸入 100、+100 加值或 -100 扣減';

    $('#tankLogsList').innerHTML = logs.map(l => `
      <div class="flex items-center justify-between text-xs bg-black/25 rounded-xl px-3.5 py-2.5 border border-white/[0.06]">
        <span class="text-[#D1D5DB]">[${l.tank_type === 'EASYCARD' ? '悠遊卡' : '皮包現金'}] ${esc(l.note)}</span>
        <span class="font-semibold tabular-nums ${l.delta_amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}">
          ${l.delta_amount >= 0 ? '+' : ''}${l.delta_amount} (餘 $${l.balance_after})
        </span>
      </div>
    `).join('');
  }

  if (splitBills) {
    $('#receivableTotalVal').textContent = fmtMoney(splitBills.pendingReceivableTotal);
    const container = $('#splitBillsList');
    if (!splitBills.items || splitBills.items.length === 0) {
      container.innerHTML = `<div class="text-center py-4 text-xs text-[#8E95A5]">尚無朋友代墊拆帳紀錄</div>`;
    } else {
      container.innerHTML = splitBills.items.map(s => `
        <div class="apple-inset flex items-center justify-between gap-3 text-xs">
          <div class="space-y-1 min-w-0">
            <div class="font-semibold text-sm text-[#F5F5F7] truncate">${esc(s.normalized_merchant || '代墊消費')} · 總額 ${fmtMoney(s.total_amount)}</div>
            <div class="text-[#8E95A5]">自付 ${fmtMoney(s.self_amount)} · 應收 <b class="text-emerald-400">${fmtMoney(s.receivable_amount)}</b> (對象：${esc(s.debtor_name)})</div>
          </div>
          <div class="shrink-0">
            ${s.is_repaid
              ? `<span class="px-3 py-1 rounded-full bg-emerald-500/12 text-emerald-300 border border-emerald-500/25 text-xs font-medium">✅ 已沖銷收訖</span>`
              : `<button type="button" data-settle-split="${s.id}" class="btn-press btn-primary px-3.5 py-2 rounded-xl text-xs">收到還款結清</button>`
            }
          </div>
        </div>
      `).join('');
    }
  }

  if (budgetOverview) {
    $('#syncExpectedLabel').textContent = fmtMoney(budgetOverview.metrics.digitalRemainingBudget);
  }
}
