export const $ = sel => document.querySelector(sel);
export const $$ = sel => Array.from(document.querySelectorAll(sel));

export function fmtMoney(n) {
  const num = Math.round(Number(n) || 0);
  if (num < 0) return '-$' + Math.abs(num).toLocaleString();
  return '$' + num.toLocaleString();
}

export function fmtSignedMoney(n) {
  const num = Math.round(Number(n) || 0);
  if (num > 0) return '+$' + num.toLocaleString();
  if (num < 0) return '-$' + Math.abs(num).toLocaleString();
  return '$0';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

export function flowTypeMeta(entry) {
  if (entry.dedupe_status === 'SUSPECTED_DUPLICATE') {
    return { badgeClass: 'badge-SUSPECTED_DUPLICATE', label: '⚠️ 疑似重複待確認' };
  }
  if (entry.payment_medium === 'CASH' && entry.flow_type === 'EXPENSE') {
    return { badgeClass: 'badge-EXPENSE', label: '💵 現金消費' };
  }
  const map = {
    EXPENSE: { badgeClass: 'badge-EXPENSE', label: '💸 一般消費' },
    INTERNAL_TRANSFER: { badgeClass: 'badge-INTERNAL_TRANSFER', label: '🔄 內部互轉/水庫' },
    ADVANCE_OUT: { badgeClass: 'badge-ADVANCE_OUT', label: '🤝 幫朋友代墊' },
    ADVANCE_IN: { badgeClass: 'badge-ADVANCE_IN', label: '💰 朋友還款沖銷' },
    INCOME_DEPOSIT: { badgeClass: 'badge-INCOME_DEPOSIT', label: '🏦 存款/入帳紀錄' },
    UNKNOWN_GAP: { badgeClass: 'badge-UNKNOWN_GAP', label: '🕳️ 待查漏帳黑洞' }
  };
  return map[entry.flow_type] || { badgeClass: 'badge-EXPENSE', label: entry.flow_type };
}
