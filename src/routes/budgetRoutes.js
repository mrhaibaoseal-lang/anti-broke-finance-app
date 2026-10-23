'use strict';

const { updateSettings } = require('../repositories/settingsRepo');
const { insertFixedExpense, deleteFixedExpense } = require('../repositories/impulseRepo');
const { setMonthlyBaseBudget } = require('../services/budgetEngine');
const { previewShiftPayload } = require('../services/shiftBridgeService');
const { buildDashboardState } = require('./dashboardRoutes');

async function handleBudgetRoutes(db, method, pathname, body) {
  // 1. 手動設定/更新本月起始數位預算 (唯一權威來源)
  if ((method === 'POST' || method === 'PUT') && pathname === '/api/budget/cycle') {
    if (body.hourlyWage !== undefined && Number(body.hourlyWage) > 0) {
      await updateSettings(db, { defaultHourlyWage: body.hourlyWage });
    }
    const cycle = await setMonthlyBaseBudget(db, {
      baseBudget: body.baseBudget,
      budgetNote: body.budgetNote || '手動設定起始預算'
    });
    return {
      status: 200,
      data: {
        ok: true,
        cycle,
        message: `✅ 已更新本月起始數位預算為 $${Number(cycle.base_budget).toLocaleString()}！`,
        dashboard: await buildDashboardState(db)
      }
    };
  }

  // 2. 單向預覽「打工薪水試算 (shift-pay)」JSON（絕不自動覆蓋預算，僅回傳試算結果或於點擊確認時帶入）
  if (method === 'POST' && pathname === '/api/budget/shift-preview') {
    const preview = previewShiftPayload(body.rawJsonPayload || body, {
      netPayFactor: body.netPayFactor,
      laborHealthDeduction: body.laborHealthDeduction,
      targetMonth: body.targetMonth
    });
    if (body.applyToBudget === true) {
      if (preview.hourlyWage > 0) {
        await updateSettings(db, { defaultHourlyWage: preview.hourlyWage });
      }
      await setMonthlyBaseBudget(db, {
        baseBudget: preview.estimatedNetPay,
        budgetNote: `手動自 ${preview.month} 班表試算帶入 (${preview.normalHours}h)`
      });
    }
    return {
      status: 200,
      data: {
        ok: true,
        preview,
        applied: Boolean(body.applyToBudget),
        dashboard: await buildDashboardState(db)
      }
    };
  }

  // 3. 更新系統與發薪週期參數
  if ((method === 'POST' || method === 'PUT') && pathname === '/api/settings') {
    await updateSettings(db, {
      paydayDay: body.paydayDay,
      defaultHourlyWage: body.defaultHourlyWage ?? body.hourlyWage,
      netPayFactor: body.netPayFactor,
      laborHealthDeduction: body.laborHealthDeduction,
      dedupeWindowMinutes: body.dedupeWindowMinutes,
      forceHighRiskMode: body.forceHighRiskMode
    });
    return {
      status: 200,
      data: {
        ok: true,
        message: '✅ 系統與週期設定已儲存',
        dashboard: await buildDashboardState(db)
      }
    };
  }

  // 4. 新增或刪除每月固定扣款與訂閱
  if (method === 'POST' && pathname === '/api/fixed-expenses') {
    const item = await insertFixedExpense(db, {
      name: body.name,
      expenseType: body.expenseType,
      monthlyAmount: body.monthlyAmount,
      billingDay: body.billingDay
    });
    return {
      status: 200,
      data: {
        ok: true,
        item,
        dashboard: await buildDashboardState(db)
      }
    };
  }

  if (method === 'POST' && pathname === '/api/fixed-expenses/delete') {
    await deleteFixedExpense(db, body.id);
    return {
      status: 200,
      data: {
        ok: true,
        dashboard: await buildDashboardState(db)
      }
    };
  }

  return null;
}

module.exports = {
  handleBudgetRoutes
};
