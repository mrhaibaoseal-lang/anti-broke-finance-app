import { $, fmtMoney, esc } from '../utils/formatters.js';

/**
 * 分頁 4：【自律防剁】渲染器
 * 呈現省錢戰績榜與 72 小時冷卻清單（「快轉滿 72h」測試按鈕已移入設定頁開發測試區）
 */
export function renderImpulseView(state) {
  const { cooldownCart } = state;
  if (!cooldownCart) return;

  $('#achieveBadgeTitle').textContent = cooldownCart.achievementTitle;
  $('#savedTotalVal').textContent = fmtMoney(cooldownCart.savedTotalAmount);
  $('#savedHoursVal').textContent = cooldownCart.savedWorkHours;
  $('#savedCountVal').textContent = cooldownCart.abandonedCount;

  const list = cooldownCart.coolingItems || [];
  const container = $('#cooldownListContainer');
  if (list.length === 0) {
    container.innerHTML = `
      <div class="bento-card text-center py-10 text-xs text-[#8E95A5]">
        目前冷卻池空空如也！想買非必需品時點上方「➕ 我又想買東西了」啟動 72h 冷卻鎖。
      </div>
    `;
    return;
  }

  container.innerHTML = list.map(item => {
    const isUnlocked = Boolean(item.isUnlocked);
    const coffeeCups = Math.max(1, Math.round((Number(item.amount) || 0) / 65));
    return `
      <div class="bento-card p-6 space-y-4 ${isUnlocked ? 'border-amber-500/35' : ''}">
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-2 min-w-0">
            <div class="text-base font-semibold text-[#F5F5F7]">${esc(item.item_name)}</div>
            <div class="flex flex-wrap gap-2">
              <span class="px-2.5 py-0.5 rounded-full ${isUnlocked ? 'bg-amber-500/15 text-amber-300 border border-amber-500/25' : 'bg-rose-500/15 text-rose-300 border border-rose-500/25'} text-xs font-medium">
                ${isUnlocked ? '🔓 已滿 72h 可決定' : `⏳ 冷卻倒數 ${item.remainingHours}h`}
              </span>
              <span class="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-[#D1D5DB] text-xs font-medium">⏱️ ${item.work_hours_equivalent}h 工時</span>
              <span class="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-[#8E95A5] text-xs font-medium">☕ ${coffeeCups} 杯咖啡</span>
            </div>
          </div>
          <div class="text-xl font-bold text-[#F5F5F7] tabular-nums shrink-0">${fmtMoney(item.amount)}</div>
        </div>

        <details class="group">
          <summary class="cursor-pointer text-xs text-[#8E95A5] hover:text-[#F5F5F7] flex items-center gap-1.5">
            <span>查看靈魂拷問與預算衝擊</span>
            <i class="fa-solid fa-chevron-down text-[10px] group-open:rotate-180 transition-transform"></i>
          </summary>
          <div class="mt-3 apple-inset !p-4 text-xs text-[#D1D5DB] whitespace-pre-line leading-relaxed">${esc(item.ai_roast_message)}</div>
        </details>

        <div class="flex gap-3 pt-1">
          <button type="button" data-cd-resolve="${item.id}|ABANDON" class="btn-press btn-primary flex-1 py-3 text-xs">
            💪 放棄購買（立省 ${fmtMoney(item.amount)}）
          </button>
          ${isUnlocked ? `
            <button type="button" data-cd-resolve="${item.id}|PURCHASE" class="btn-press btn-danger-soft px-4 py-3 text-xs">
              仍要買 (轉支出)
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}
