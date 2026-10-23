import { $, $$, fmtMoney, esc } from './utils/formatters.js';
import { apiCall } from './apiClient.js';
import { getStore, setDashboardState, subscribeDashboard } from './store.js';
import { renderHomeView } from './views/homeView.js';
import { renderWalletView } from './views/walletView.js';
import { renderRecordsView } from './views/recordsView.js';
import { renderImpulseView } from './views/impulseView.js';
import { renderSettingsView } from './views/settingsView.js';
import { showToast, openModal, closeModal, bindModalCloseButtons, openEditEntryModal } from './views/modals.js';

const OCR_PRESETS = {
  ocr_out_expense: () => ({
    direction: 'OUT',
    flowType: 'EXPENSE',
    text: `9:41 5G 88%\n【玉山行動銀行】臺幣轉帳成功\n轉帳金額 NT$ 450 元\n手續費優惠減免 0 元\n轉出帳號 ***1234\n轉入銀行 808 玉山銀行\n轉入帳號 ***5678\n交易備註 房租水電分攤\n帳戶可用餘額 NT$18,550 元\n首頁 帳務 信用卡 設定`
  }),
  ocr_out_advance: () => ({
    direction: 'OUT',
    flowType: 'ADVANCE_OUT',
    text: `【玉山銀行】轉帳成功\n交易金額 $800\n收款人 小杰\n交易備註 幫買演唱會門票代墊`
  }),
  ocr_in_repay: () => ({
    direction: 'IN',
    flowType: 'ADVANCE_IN',
    text: `【玉山Wallet】收到轉帳通知\n轉出帳號 822-***9988\n您的轉入帳號 808-***1234\n轉入金額 NT$800 元\n備註 小杰還門票錢`
  }),
  ocr_internal_atm: () => ({
    direction: 'OUT',
    flowType: 'INTERNAL_TRANSFER',
    text: `【玉山銀行】ATM 提款通知：您的帳戶於今日 14:20 完成 ATM 現金提領 NT$2,000 元，手續費 0 元。`
  })
};

function renderAllViews(dashboard) {
  if (!dashboard) return;
  renderHomeView(dashboard);
  renderWalletView(dashboard);
  renderRecordsView(dashboard);
  renderImpulseView(dashboard);
  renderSettingsView(dashboard);
}

export function switchMainTab(targetTab) {
  getStore().activeTab = targetTab;
  $$('[data-nav-tab]').forEach(btn => {
    const active = btn.dataset.navTab === targetTab;
    btn.className = `nav-tab-btn btn-press py-1.5 rounded-xl flex flex-col items-center gap-1 ${active ? 'text-[#0A84FF] font-semibold' : 'text-[#8E95A5] font-medium'}`;
  });
  $$('.tab-pane').forEach(pane => {
    pane.classList.toggle('hidden', pane.id !== `tab-${targetTab}`);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function handleUndoDeleteEntry(entryId) {
  try {
    const res = await apiCall('/api/ledger/delete', 'POST', { entryId });
    setDashboardState(res.dashboard);
    showToast(res.message || '↩️ 已成功反悔撤銷該筆紀錄，預算與水庫餘額已完整復原！');
  } catch (err) {
    alert(err.message);
  }
}

function updateOcrSelectorButtons() {
  const { ocrDirection, ocrFlowType } = getStore();
  $$('[data-ocr-preset-mode]').forEach(btn => {
    const [dir, flow] = btn.dataset.ocrPresetMode.split('|');
    const active = dir === ocrDirection && flow === ocrFlowType;
    btn.className = active
      ? 'btn-press py-2.5 px-3 rounded-xl text-xs font-semibold bg-[#0A84FF] text-white border border-[#0A84FF]'
      : 'btn-press py-2.5 px-3 rounded-xl text-xs font-medium bg-[#151821] text-[#8E95A5] border border-white/[0.08]';
  });
}

export async function initApp() {
  subscribeDashboard(renderAllViews);
  bindModalCloseButtons();

  // 初次載入 Dashboard
  try {
    const data = await apiCall('/api/dashboard', 'GET');
    setDashboardState(data);
  } catch (err) {
    console.error('Initial dashboard load failed:', err);
  }

  // 底部 5 分頁切換
  $$('[data-nav-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchMainTab(btn.dataset.navTab));
  });

  // 頂部與首頁快捷按鈕
  $('#btnToggleHighRisk')?.addEventListener('click', async () => {
    const cur = getStore().dashboard?.settings?.force_high_risk_mode;
    const res = await apiCall('/api/settings', 'POST', { forceHighRiskMode: !cur });
    setDashboardState(res.dashboard);
    showToast(!cur ? '🌙 已手動開啟夜間/高風險防禦模式' : '☀️ 已切回標準防禦模式');
  });

  $('#btnOpenBudgetModal')?.addEventListener('click', () => openModal('modalBudgetSetup'));
  $('#btnHomeQuickCash')?.addEventListener('click', () => openModal('modalQuickCash'));
  $('#btnHomeQuickAtm')?.addEventListener('click', () => openModal('modalAtmDeposit'));
  $('#btnHomeQuickImpulse')?.addEventListener('click', () => openModal('modalImpulse'));
  $('#btnHomeQuickWebhook')?.addEventListener('click', () => openModal('modalWebhookOcr'));

  $('#btnHomeGoWalletCash')?.addEventListener('click', () => switchMainTab('wallet'));
  $('#btnHomeGoWalletEasy')?.addEventListener('click', () => switchMainTab('wallet'));
  $('#cardGoRecords')?.addEventListener('click', () => switchMainTab('records'));
  $('#cardGoImpulse')?.addEventListener('click', () => switchMainTab('impulse'));

  $('#btnOpenImpulseModal')?.addEventListener('click', () => openModal('modalImpulse'));
  $('#btnOpenImpulseFromList')?.addEventListener('click', () => openModal('modalImpulse'));
  $('#btnOpenWebhookFromRecords')?.addEventListener('click', () => openModal('modalWebhookOcr'));
  $('#btnOpenBalanceSyncModal')?.addEventListener('click', () => openModal('modalBalanceSync'));
  $('#btnOpenFixedModal')?.addEventListener('click', () => openModal('modalFixedExpense'));

  // 明細篩選膠囊
  $$('[data-tx-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      getStore().recordFilter = btn.dataset.txFilter;
      renderRecordsView(getStore().dashboard);
    });
  });

  // 1. 儲存每月起始數位預算 (唯一權威預算源)
  $('#btnSaveBaseBudget')?.addEventListener('click', async () => {
    const baseBudget = Number($('#inputBaseBudget')?.value || 0);
    const hourlyWage = Number($('#inputHourlyWage')?.value || 200);
    const res = await apiCall('/api/budget/cycle', 'POST', {
      baseBudget,
      hourlyWage,
      budgetNote: '手動設定起始預算'
    });
    setDashboardState(res.dashboard);
    closeModal('modalBudgetSetup');
    showToast(res.message);
  });

  $('#btnSaveModalBudget')?.addEventListener('click', async () => {
    const baseBudget = Number($('#modalBaseBudgetInput')?.value || 0);
    const res = await apiCall('/api/budget/cycle', 'POST', {
      baseBudget,
      budgetNote: '手動設定起始預算'
    });
    setDashboardState(res.dashboard);
    closeModal('modalBudgetSetup');
    showToast(res.message);
  });

  // 2. 儲存週期與防重複設定
  $('#btnSaveSettings')?.addEventListener('click', async () => {
    const res = await apiCall('/api/settings', 'POST', {
      paydayDay: Number($('#setPayday')?.value || 10),
      netPayFactor: Number($('#setNetFactor')?.value || 0.95),
      laborHealthDeduction: Number($('#setLaborDeduct')?.value || 0),
      dedupeWindowMinutes: Number($('#setDedupeWindow')?.value || 10)
    });
    setDashboardState(res.dashboard);
    showToast(res.message);
  });

  // 3. 記皮包現金消費 (支援 Toast 立即撤銷)
  $('#btnSubmitQuickCash')?.addEventListener('click', async () => {
    const itemName = ($('#cashExpenseNameInput')?.value || '').trim() || '現金消費';
    const amount = Number($('#cashExpenseAmountInput')?.value || 0);
    const category = $('#cashExpenseCategorySelect')?.value || '餐飲外食';
    if (!amount || amount <= 0) return alert('請輸入大於 0 的現金消費金額！');

    const res = await apiCall('/api/cash/spend', 'POST', { itemName, amount, category });
    $('#cashExpenseNameInput').value = '';
    $('#cashExpenseAmountInput').value = '';
    closeModal('modalQuickCash');
    setDashboardState(res.dashboard);
    showToast(`💵 已登記皮包現金消費：${itemName} -$${amount.toLocaleString()}`, {
      undoEntryId: res.entry?.id,
      onUndo: handleUndoDeleteEntry
    });
  });

  // 4. 🏧 存入金融卡 (ATM 存款，支援 Toast 一鍵立即反悔撤銷 + 彈窗內直接改金額/撤銷)
  $('#btnSubmitAtmDeposit')?.addEventListener('click', async () => {
    const amount = Number($('#quickAtmDepositInput')?.value || 0);
    const deductFromWalletCash = Boolean($('#chkAtmDeductCash')?.checked);
    if (!amount || amount <= 0) return alert('請輸入存入金融卡的金額！');

    const res = await apiCall('/api/deposits/add', 'POST', {
      amount,
      merchant: '玉山 ATM 存款',
      deductFromWalletCash
    });
    $('#quickAtmDepositInput').value = '';
    setDashboardState(res.dashboard);
    showToast(`🏧 已存入金融卡 +$${amount.toLocaleString()}！若打錯金額可點右側立即撤銷`, {
      undoEntryId: res.entry?.id,
      onUndo: handleUndoDeleteEntry,
      duration: 8000
    });
  });

  // 5. ✏️ 儲存修改紀錄 (包含 ATM 存款改金額、改扣皮包現金、改轉帳分類)
  $('#editEntryFlowType')?.addEventListener('change', e => {
    const isInternal = e.target.value === 'INTERNAL_TRANSFER';
    $('#editAtmCashToggleWrap')?.classList.toggle('hidden', !isInternal);
  });

  $('#btnConfirmEditEntry')?.addEventListener('click', async () => {
    const entryId = Number($('#editEntryId')?.value);
    const merchant = ($('#editEntryMerchant')?.value || '').trim();
    const amount = Number($('#editEntryAmount')?.value || 0);
    const flowType = $('#editEntryFlowType')?.value || 'EXPENSE';
    const category = ($('#editEntryCategory')?.value || '').trim() || '一般消費';
    const txDate = $('#editEntryDate')?.value;
    const note = ($('#editEntryNote')?.value || '').trim();
    const deductFromWalletCash = Boolean($('#editChkDeductCash')?.checked);

    if (!amount || amount <= 0) return alert('金額必須大於 0！');
    const res = await apiCall('/api/ledger/update', 'POST', {
      entryId,
      merchant,
      amount,
      flowType,
      category,
      txDate,
      note,
      deductFromWalletCash
    });
    closeModal('modalEditEntry');
    setDashboardState(res.dashboard);
    showToast(res.message || '✅ 修改已儲存，預算與水庫餘額已同步更新！');
  });

  // 6. Apple Pay 捷徑模擬與轉帳截圖 OCR 解析
  $('#btnSimulateApplePay')?.addEventListener('click', async () => {
    const merchant = ($('#quickAppleMerchant')?.value || '星巴克').trim();
    const amount = Number($('#quickAppleAmount')?.value || 155);
    const card_name = ($('#quickAppleCard')?.value || '玉山 Unicard').trim();
    try {
      const res = await apiCall('/api/webhook/apple-pay', 'POST', {
        source: 'apple_pay',
        merchant,
        amount,
        card_name
      });
      setDashboardState(res.dashboard);
      showToast(res.result?.message || '🍎 Apple Pay 入帳成功！', {
        undoEntryId: res.result?.entry?.id,
        onUndo: handleUndoDeleteEntry
      });
    } catch (err) {
      alert(err.message);
    }
  });

  $$('[data-ocr-preset-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [dir, flow] = btn.dataset.ocrPresetMode.split('|');
      getStore().ocrDirection = dir;
      getStore().ocrFlowType = flow;
      updateOcrSelectorButtons();
    });
  });

  $$('[data-ocr-sample]').forEach(btn => {
    btn.addEventListener('click', () => {
      const fn = OCR_PRESETS[btn.dataset.ocrSample];
      if (!fn) return;
      const sample = fn();
      getStore().ocrDirection = sample.direction;
      getStore().ocrFlowType = sample.flowType;
      updateOcrSelectorButtons();
      $('#ocrRawTextInput').value = sample.text;
    });
  });

  $('#btnSubmitOcrParse')?.addEventListener('click', async () => {
    const raw_text = ($('#ocrRawTextInput')?.value || '').trim();
    if (!raw_text) return alert('請貼上轉帳截圖 OCR 文字！');
    try {
      const res = await apiCall('/api/webhook/transfer-ocr', 'POST', {
        source: 'manual_ocr',
        raw_text,
        direction: getStore().ocrDirection,
        flowType: getStore().ocrFlowType
      });
      setDashboardState(res.dashboard);
      const box = $('#ocrResultBox');
      if (box) {
        box.classList.remove('hidden');
        box.textContent = res.result?.message || '解析完成';
      }
      showToast(res.result?.message || '📸 轉帳 OCR 解析入帳完成！', {
        undoEntryId: res.result?.entry?.id,
        onUndo: handleUndoDeleteEntry
      });
    } catch (err) {
      alert(err.message);
    }
  });

  // 7. 實體水庫快捷加減與盤點
  $$('[data-tank-quick]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const [tankType, deltaStr, note] = btn.dataset.tankQuick.split('|');
      const res = await apiCall('/api/wallet/adjust', 'POST', {
        tankType,
        deltaAmount: Number(deltaStr),
        note
      });
      setDashboardState(res.dashboard);
      showToast(`✅ 水庫已更新：${note}`);
    });
  });

  const handleCustomTankAdjust = async (tankType, inputSel) => {
    const raw = ($(inputSel)?.value || '').trim().replace(/[$,，\s元]/g, '');
    if (!raw) return;
    const isNeg = raw.startsWith('-');
    const num = Math.round(Number(raw.replace(/^[+-]+/, '')));
    if (!num) return;
    const deltaAmount = isNeg ? -num : num;
    const res = await apiCall('/api/wallet/adjust', 'POST', {
      tankType,
      deltaAmount,
      note: isNeg ? '自訂扣減' : '自訂加值'
    });
    $(inputSel).value = '';
    setDashboardState(res.dashboard);
  };

  $('#btnCustomCashAdjust')?.addEventListener('click', () => handleCustomTankAdjust('CASH', '#customCashDeltaInput'));
  $('#btnCustomEasyAdjust')?.addEventListener('click', () => handleCustomTankAdjust('EASYCARD', '#customEasyDeltaInput'));

  $('#btnAuditTank')?.addEventListener('click', async () => {
    const cashVal = $('#auditCashInput')?.value.trim();
    const easyVal = $('#auditEasyInput')?.value.trim();
    if (cashVal === '' && easyVal === '') return;
    const res = await apiCall('/api/wallet/audit', 'POST', {
      cashBalance: cashVal !== '' ? Number(cashVal) : undefined,
      easycardBalance: easyVal !== '' ? Number(easyVal) : undefined
    });
    $('#auditCashInput').value = '';
    $('#auditEasyInput').value = '';
    setDashboardState(res.dashboard);
    showToast('📋 已完成實體水庫餘額盤點校正！');
  });

  // 8. 玉山可用餘額校正、聚餐拆帳、黑洞拆分
  $('#btnConfirmBalanceSync')?.addEventListener('click', async () => {
    const val = $('#actualEsunInput')?.value.trim();
    if (val === '') return alert('請輸入玉山目前實際可用餘額！');
    const res = await apiCall('/api/balance/sync', 'POST', {
      actualBankBalance: Number(val)
    });
    $('#actualEsunInput').value = '';
    closeModal('modalBalanceSync');
    setDashboardState(res.dashboard);
    showToast(res.syncResult?.message || '✅ 餘額校正完成');
  });

  $('#btnConfirmSplitBill')?.addEventListener('click', async () => {
    const entryId = Number($('#splitEntryId')?.value);
    const selfAmount = Number($('#splitSelfAmountInput')?.value || 0);
    const debtorName = ($('#splitDebtorNameInput')?.value || '朋友').trim();
    const res = await apiCall('/api/splits/create', 'POST', { entryId, selfAmount, debtorName });
    closeModal('modalSplitBill');
    setDashboardState(res.dashboard);
    showToast('🤝 已完成聚餐拆帳！代墊部分已移入應收池，不扣減個人預算');
  });

  $('#btnConfirmGapSplit')?.addEventListener('click', async () => {
    const gapEntryId = Number($('#gapSplitEntryId')?.value);
    const merchant = ($('#gapItemMerchantInput')?.value || '').trim();
    const amount = Number($('#gapItemAmountInput')?.value || 0);
    if (!merchant || !amount) return alert('請輸入補登項目名稱與金額！');
    const res = await apiCall('/api/balance/split-gap', 'POST', {
      gapEntryId,
      items: [{ merchant, amount }]
    });
    $('#gapItemMerchantInput').value = '';
    $('#gapItemAmountInput').value = '';
    closeModal('modalGapSplit');
    setDashboardState(res.dashboard);
    showToast('🔍 已從待查黑洞拆分補登消費明細！');
  });

  // 9. 衝動急救評估與 72h 冷卻池
  $$('[data-imp-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      getStore().impulseItemType = btn.dataset.impType;
      $$('[data-imp-type]').forEach(b => {
        const active = b.dataset.impType === getStore().impulseItemType;
        b.className = active
          ? 'imp-type-btn btn-press py-3 rounded-xl text-xs font-semibold bg-[#0A84FF] text-white shadow-sm'
          : 'imp-type-btn btn-press py-3 rounded-xl text-xs font-medium bg-[#232836] text-[#8E95A5] border border-white/[0.08]';
      });
    });
  });

  $('#btnEvaluateImpulse')?.addEventListener('click', async () => {
    const itemName = ($('#impItemName')?.value || '').trim();
    const amount = Number($('#impAmount')?.value || 0);
    const reason = ($('#impReason')?.value || '').trim();
    if (!itemName || !amount) return alert('請輸入商品名稱與金額！');

    const res = await apiCall('/api/impulse/evaluate', 'POST', {
      itemName,
      amount,
      reason,
      itemType: getStore().impulseItemType,
      addToCart: true
    });
    const ev = res.evaluation;
    const out = $('#impulseEvalOutput');
    out.classList.remove('hidden');
    out.innerHTML = `
      <div class="flex flex-wrap gap-2">
        <span class="px-3 py-1 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/25 text-xs font-medium">⏱️ 需站班表 ${ev.sweatWork.hours}h ${ev.sweatWork.minutes}m</span>
        <span class="px-3 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/25 text-xs font-medium">☕ 約 ${ev.coffeeCups} 杯咖啡</span>
        <span class="px-3 py-1 rounded-full bg-white/[0.06] text-[#D1D5DB] text-xs font-medium">📉 日預算 $${ev.survivalImpact.dailyBudgetBefore} ➔ $${ev.survivalImpact.dailyBudgetAfter}</span>
      </div>
      <div class="text-xs text-[#D1D5DB] whitespace-pre-line leading-relaxed bg-black/30 p-4 rounded-xl border border-white/[0.06]">${esc(ev.aiRoastMessage)}</div>
    `;
    $('#impItemName').value = '';
    $('#impAmount').value = '';
    $('#impReason').value = '';
    setDashboardState(res.dashboard);
    showToast('🔒 已鎖入 72 小時冷卻清單！');
  });

  // 10. 固定扣款與訂閱新增
  $('#btnAddFixedExpense')?.addEventListener('click', async () => {
    const name = ($('#fxName')?.value || '').trim();
    const monthlyAmount = Number($('#fxAmount')?.value || 0);
    const expenseType = $('#fxType')?.value || 'SUBSCRIPTION';
    const billingDay = Number($('#fxDay')?.value || 15);
    if (!name || !monthlyAmount) return alert('請輸入項目名稱與每月金額！');

    const res = await apiCall('/api/fixed-expenses', 'POST', {
      name,
      monthlyAmount,
      expenseType,
      billingDay
    });
    $('#fxName').value = '';
    $('#fxAmount').value = '';
    closeModal('modalFixedExpense');
    setDashboardState(res.dashboard);
    showToast(`🔔 已新增固定扣款：${name} ($${monthlyAmount}/月)`);
  });

  // 11. 單向手動從「打工薪水試算 (shift-pay)」帶入預估金額
  $('#btnOpenShiftPayTool')?.addEventListener('click', () => {
    const iframe = $('#shiftAppIframe');
    if (iframe && iframe.src === 'about:blank') {
      iframe.src = '/shift-pay';
    }
    openModal('modalEmbeddedShiftApp');
  });

  $('#btnApplyShiftToBudget')?.addEventListener('click', async () => {
    try {
      const rawBridge = localStorage.getItem('shiftpay.v2.bridge') || localStorage.getItem('shiftpay.v1');
      if (!rawBridge) {
        return alert('尚未在排班試算工具中建立排班資料！請先點「開啟打工薪水試算工具」排班。');
      }
      const res = await apiCall('/api/budget/shift-preview', 'POST', {
        rawJsonPayload: JSON.parse(rawBridge),
        netPayFactor: Number($('#setNetFactor')?.value || 0.95),
        laborHealthDeduction: Number($('#setLaborDeduct')?.value || 0),
        applyToBudget: true
      });
      closeModal('modalEmbeddedShiftApp');
      setDashboardState(res.dashboard);
      showToast(`📅 已手動將 ${res.preview.month} 班表預估實領 $${res.preview.estimatedNetPay.toLocaleString()} 套用為本月起始預算！`);
    } catch (err) {
      alert(err.message);
    }
  });

  // 12. 設定頁底部「開發者測試區」按鈕（含 72h 快轉、範例資料、清空歸零）
  $('#btnDevFastForward72h')?.addEventListener('click', async () => {
    const res = await apiCall('/api/dev/fast-forward-cooldown', 'POST', {});
    setDashboardState(res.dashboard);
    showToast(res.message);
  });

  $('#btnResetDemo')?.addEventListener('click', async () => {
    const res = await apiCall('/api/demo/reset', 'POST', { withDemoData: true });
    setDashboardState(res.dashboard);
    showToast(res.message);
  });

  $('#btnClearAllData')?.addEventListener('click', async () => {
    if (!confirm('確定要清空歸零整個帳本嗎？')) return;
    const res = await apiCall('/api/demo/reset', 'POST', { withDemoData: false });
    setDashboardState(res.dashboard);
    showToast(res.message);
  });

  // 13. 全域動態按鈕點擊委派 (修改紀錄、撤銷刪除、疑似重複確認、拆帳、黑洞拆分、冷卻決策)
  document.body.addEventListener('click', async e => {
    const editBtn = e.target.closest('[data-edit-entry]');
    if (editBtn) {
      const id = Number(editBtn.dataset.editEntry);
      const entry = (getStore().dashboard?.entries || []).find(item => Number(item.id) === id);
      if (entry) openEditEntryModal(entry);
      return;
    }

    const delBtn = e.target.closest('[data-delete-entry]');
    if (delBtn) {
      const id = Number(delBtn.dataset.deleteEntry);
      await handleUndoDeleteEntry(id);
      return;
    }

    const dupBtn = e.target.closest('[data-resolve-dup]');
    if (dupBtn) {
      const [idStr, decision] = dupBtn.dataset.resolveDup.split('|');
      const res = await apiCall('/api/ledger/resolve-duplicate', 'POST', {
        entryId: Number(idStr),
        decision
      });
      setDashboardState(res.dashboard);
      showToast(decision === 'DELETE' ? '🗑️ 已刪除重複入帳紀錄' : '✅ 已確認為第 2 筆有效入帳並計入預算');
      return;
    }

    const splitBtn = e.target.closest('[data-open-split]');
    if (splitBtn) {
      const id = Number(splitBtn.dataset.openSplit);
      const entry = (getStore().dashboard?.entries || []).find(item => Number(item.id) === id);
      if (entry) {
        $('#splitEntryId').value = entry.id;
        $('#splitTotalLabel').textContent = fmtMoney(entry.amount);
        $('#splitSelfAmountInput').value = Math.round(Number(entry.amount) / 2);
        $('#splitDebtorNameInput').value = entry.split_debtor_name || '朋友';
        openModal('modalSplitBill');
      }
      return;
    }

    const settleSplitBtn = e.target.closest('[data-settle-split]');
    if (settleSplitBtn) {
      const res = await apiCall('/api/splits/settle', 'POST', {
        splitBillId: Number(settleSplitBtn.dataset.settleSplit)
      });
      setDashboardState(res.dashboard);
      showToast('🤝 已結清該筆朋友代墊款！');
      return;
    }

    const gapBtn = e.target.closest('[data-open-gap-split]');
    if (gapBtn) {
      const id = Number(gapBtn.dataset.openGapSplit);
      const entry = (getStore().dashboard?.entries || []).find(item => Number(item.id) === id);
      if (entry) {
        $('#gapSplitEntryId').value = entry.id;
        $('#gapRemainingLabel').textContent = fmtMoney(entry.amount);
        openModal('modalGapSplit');
      }
      return;
    }

    const cdBtn = e.target.closest('[data-cd-resolve]');
    if (cdBtn) {
      const [itemId, decision] = cdBtn.dataset.cdResolve.split('|');
      const res = await apiCall('/api/cooldown/resolve', 'POST', { itemId: Number(itemId), decision });
      setDashboardState(res.dashboard);
      showToast(decision === 'ABANDON' ? '💪 太棒了！成功忍住不買，已計入防剁省錢戰績！' : '🛒 已轉為確認消費支出');
      return;
    }

    const delFixedBtn = e.target.closest('[data-del-fixed]');
    if (delFixedBtn) {
      const res = await apiCall('/api/fixed-expenses/delete', 'POST', { id: Number(delFixedBtn.dataset.delFixed) });
      setDashboardState(res.dashboard);
      showToast('🗑️ 已移除該筆固定扣款');
    }
  });
}

document.addEventListener('DOMContentLoaded', initApp);




