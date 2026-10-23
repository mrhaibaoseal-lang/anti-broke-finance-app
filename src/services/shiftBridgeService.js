'use strict';

/**
 * 打工薪水試算工具 (`shift-pay`) 單向試算解析器
 * 與主帳本徹底解耦：僅在 사용자가主動上傳/貼上班表 JSON 並點擊「套用至本月預算」時才會計算，
 * 絕不在背景自動同步或覆蓋每月起始預算！
 */
function toMin(t) {
  if (!t) return 0;
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function spanMin(start, end) {
  const a = toMin(start);
  let b = toMin(end);
  if (b <= a) b += 1440;
  return b - a;
}

function isUnpaidLeave(sh) {
  return sh.status === 'leave' && sh.leaveType === 'leave';
}

function previewShiftPayload(rawPayload, { netPayFactor = 0.95, laborHealthDeduction = 0, targetMonth = null } = {}) {
  const data = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
  if (!data || typeof data !== 'object') {
    throw new Error('無效的班表試算 JSON 格式');
  }

  const state = data.fullState || data.state || (data.shifts ? data : null);
  if (!state && typeof data.totalPay === 'number') {
    const gross = Math.max(0, Math.round(Number(data.totalPay) || 0));
    const estNet = Math.max(0, Math.round(gross * Number(netPayFactor || 0.95)) - Math.round(Number(laborHealthDeduction) || 0));
    return {
      month: data.month || targetMonth || '當月',
      hourlyWage: Number(data.hourlyWage) || 200,
      shiftCount: Number(data.shiftCount) || 0,
      normalHours: Number(data.normalHours) || 0,
      otMinutes: Number(data.otMinutes) || 0,
      grossPay: gross,
      estimatedNetPay: estNet
    };
  }

  if (!state || !state.shifts || typeof state.shifts !== 'object') {
    throw new Error('找不到排班資料 (shifts)，請確認為打工薪水帳匯出之 JSON');
  }

  const settings = state.settings || {};
  const hourlyWage = Number(settings.hourlyWage) || 200;
  const otMultiplier = Number.isFinite(Number(settings.otMultiplier)) ? Number(settings.otMultiplier) : 1.34;
  const roundingMode = settings.roundingMode || 'monthly';
  const attendanceBonus = Number(settings.attendanceBonus) || 0;
  const shifts = state.shifts || {};

  const allKeys = Object.keys(shifts).sort();
  let ym = targetMonth;
  if (!ym || !allKeys.some(k => k.startsWith(ym + '-'))) {
    ym = allKeys.length > 0 ? allKeys[allKeys.length - 1].slice(0, 7) : new Date().toISOString().slice(0, 7);
  }

  const days = allKeys.filter(k => k.startsWith(ym + '-'));
  const ratePerMin = hourlyWage / 60;
  let nMin = 0;
  let oMin = 0;
  let otDailySum = 0;
  let leaveCount = 0;

  for (const key of days) {
    const sh = shifts[key];
    if (!sh) continue;
    const nm = isUnpaidLeave(sh) ? 0 : Math.max(0, spanMin(sh.start, sh.end) - (Number(sh.breakMin) || 0));
    const om = isUnpaidLeave(sh) ? 0 : Math.max(0, Math.floor(Number(sh.otMin) || 0));
    nMin += nm;
    oMin += om;
    otDailySum += Math.round(om * ratePerMin * otMultiplier);
    if (sh.status === 'leave') leaveCount++;
  }

  const normalPay = Math.round(nMin * ratePerMin);
  const otPay = roundingMode === 'daily' ? otDailySum : Math.round(oMin * ratePerMin * otMultiplier);
  const bonusPay = (days.length > 0 && leaveCount === 0) ? attendanceBonus : 0;
  const grossPay = normalPay + otPay + bonusPay;
  const estimatedNetPay = Math.max(
    0,
    Math.round(grossPay * Number(netPayFactor || 0.95)) - Math.round(Number(laborHealthDeduction) || 0)
  );

  return {
    month: ym,
    hourlyWage,
    shiftCount: days.length,
    normalHours: Number((nMin / 60).toFixed(2)),
    otMinutes: oMin,
    grossPay,
    estimatedNetPay
  };
}

module.exports = {
  previewShiftPayload
};
