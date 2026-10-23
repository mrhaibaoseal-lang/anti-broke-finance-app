import { $, $$, fmtMoney, esc } from '../utils/formatters.js';

let toastTimer = null;

/**
 * 顯示浮動 Toast 提示，支援附帶「↩️ 剛打錯？立即撤銷 (Undo)」按鈕！
 */
export function showToast(message, { undoEntryId = null, onUndo = null, duration = 6000 } = {}) {
  let container = $('#toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'fixed top-20 right-4 left-4 sm:left-auto sm:w-96 z-50 pointer-events-none flex flex-col gap-2';
    document.body.appendChild(container);
  }

  if (toastTimer) clearTimeout(toastTimer);
  container.innerHTML = `
    <div class="pointer-events-auto rounded-2xl bg-[#161A26]/95 border border-[#0A84FF]/40 px-4 py-3.5 shadow-2xl backdrop-blur-xl text-xs text-[#F5F5F7] flex items-center justify-between gap-3">
      <div class="leading-relaxed font-medium">${esc(message)}</div>
      ${undoEntryId ? `
        <button id="btnToastUndoNow" type="button" class="btn-press shrink-0 px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 font-semibold text-xs">
          ↩️ 立即撤銷
        </button>
      ` : ''}
    </div>
  `;

  if (undoEntryId && typeof onUndo === 'function') {
    $('#btnToastUndoNow')?.addEventListener('click', async () => {
      container.innerHTML = '';
      await onUndo(undoEntryId);
    });
  }

  toastTimer = setTimeout(() => {
    container.innerHTML = '';
  }, duration);
}

export function openModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.remove('hidden');
}

export function closeModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.add('hidden');
}

export function bindModalCloseButtons() {
  $$('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      closeModal(btn.dataset.closeModal);
    });
  });
}

/**
 * 打開「✏️ 修改紀錄 / ATM 存款金額」彈窗
 */
export function openEditEntryModal(entry) {
  if (!entry) return;
  $('#editEntryId').value = entry.id;
  $('#editEntryMerchant').value = entry.raw_merchant || entry.normalized_merchant || '';
  $('#editEntryAmount').value = entry.amount || 0;
  $('#editEntryFlowType').value = entry.flow_type || 'EXPENSE';
  $('#editEntryCategory').value = entry.category || '一般消費';
  $('#editEntryDate').value = (entry.tx_date || '').slice(0, 10);
  $('#editEntryNote').value = entry.note || '';

  const isAtmDeposit = entry.flow_type === 'INTERNAL_TRANSFER' &&
    (entry.category === 'ATM存款' || /ATM\s*存款|存入金融卡/.test((entry.normalized_merchant || '') + ' ' + (entry.note || '')));

  const atmWrap = $('#editAtmCashToggleWrap');
  if (atmWrap) {
    atmWrap.classList.toggle('hidden', !isAtmDeposit);
    $('#editChkDeductCash').checked = Number(entry.cash_delta) < 0;
  }

  openModal('modalEditEntry');
}

/**
 * 渲染「存入金融卡 (ATM 存款)」彈窗內的最近 5 筆存入紀錄（可直接改金額或撤銷退回！）
 */
export function renderRecentAtmDepositsInModal(entries = []) {
  const container = $('#recentAtmDepositsList');
  if (!container) return;

  const atmEntries = entries.filter(e =>
    (e.flow_type === 'INTERNAL_TRANSFER' && (e.category === 'ATM存款' || Number(e.budget_impact_amount) < 0)) ||
    e.flow_type === 'INCOME_DEPOSIT'
  ).slice(0, 5);

  if (atmEntries.length === 0) {
    container.innerHTML = `<div class="text-center py-3 text-xs text-[#8E95A5]">尚無最近 ATM 存入紀錄</div>`;
    return;
  }

  container.innerHTML = atmEntries.map(e => `
    <div class="apple-inset !p-3 flex items-center justify-between gap-2 text-xs">
      <div class="min-w-0 space-y-0.5">
        <div class="font-semibold text-[#F5F5F7] truncate">
          ${esc(e.normalized_merchant)} · <span class="text-emerald-400">+${fmtMoney(e.amount)}</span>
        </div>
        <div class="text-[11px] text-[#8E95A5]">
          ${esc(e.tx_date)} ${Number(e.cash_delta) < 0 ? '· 已扣皮包現金' : '· 未扣皮包現金'}
        </div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" data-edit-entry="${e.id}" class="btn-press btn-secondary px-2.5 py-1.5 rounded-lg text-[11px]">
          ✏️ 改金額
        </button>
        <button type="button" data-delete-entry="${e.id}" class="btn-press btn-danger-soft px-2.5 py-1.5 rounded-lg text-[11px]">
          ↩️ 撤銷
        </button>
      </div>
    </div>
  `).join('');
}
