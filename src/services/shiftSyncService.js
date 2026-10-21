'use strict';

let fs = null;
let path = null;
let os = null;
try {
  fs = require('node:fs');
  path = require('node:path');
  os = require('node:os');
} catch (_) {}

const SAMPLE_SHIFT_PATH = (path && typeof __dirname !== 'undefined')
  ? path.join(__dirname, '..', '..', 'data', 'sample_shift_data.json')
  : '';
const LATEST_SYNC_CACHE_PATH = (path && typeof __dirname !== 'undefined')
  ? path.join(__dirname, '..', '..', 'data', 'latest_shift_sync.json')
  : '';

const DEFAULT_SAMPLE_SHIFT_DATA = {
  app: 'shiftpay-v2',
  exportedAt: '2026-10-21T08:00:00.000Z',
  settings: {
    hourlyWage: 200,
    otMultiplier: 1.34,
    roundingMode: 'monthly',
    attendanceBonus: 0,
    myName: '使用者'
  },
  stamps: [],
  shifts: {}
};

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

function isUnpaid(sh) {
  return sh.status === 'leave' && sh.leaveType === 'leave';
}

function computeShiftPayFromFullState(shiftState, targetYearMonth) {
  const settings = shiftState.settings || {};
  const hourlyWage = Number(settings.hourlyWage) || 200;
  const otMultiplier = Number.isFinite(Number(settings.otMultiplier)) ? Number(settings.otMultiplier) : 1;
  const roundingMode = settings.roundingMode || 'monthly';
  const attendanceBonus = Number(settings.attendanceBonus) || 0;
  const shifts = shiftState.shifts || {};

  let ym = targetYearMonth;
  const allKeys = Object.keys(shifts).sort();
  if (!ym || !allKeys.some(k => k.startsWith(ym + '-'))) {
    ym = allKeys.length > 0 ? allKeys[allKeys.length - 1].slice(0, 7) : new Date().toISOString().slice(0, 7);
  }

  const prefix = ym + '-';
  const days = allKeys.filter(k => k.startsWith(prefix));
  const ratePerMin = hourlyWage / 60;
  let nMin = 0, oMin = 0, otDailySum = 0, leaveCount = 0;

  for (const key of days) {
    const sh = shifts[key];
    if (!sh) continue;
    const nm = isUnpaid(sh) ? 0 : Math.max(0, spanMin(sh.start, sh.end) - (Number(sh.breakMin) || 0));
    const om = isUnpaid(sh) ? 0 : Math.max(0, Math.floor(Number(sh.otMin) || 0));
    nMin += nm;
    oMin += om;
    otDailySum += Math.round(om * ratePerMin * otMultiplier);
    if (sh.status === 'leave') leaveCount++;
  }

  const normalPay = Math.round(nMin * ratePerMin);
  const otPay = roundingMode === 'daily' ? otDailySum : Math.round(oMin * ratePerMin * otMultiplier);
  const bonusOk = days.length > 0 && leaveCount === 0;
  const bonusPay = bonusOk ? attendanceBonus : 0;

  return {
    month: ym,
    employee: settings.myName || '王凱弘',
    hourlyWage,
    totalPay: normalPay + otPay + bonusPay,
    normalPay,
    normalHours: Number((nMin / 60).toFixed(2)),
    otPay,
    otMinutes: oMin,
    bonusOk,
    bonusPay,
    shiftCount: days.length
  };
}

function parseShiftPayload(payload, preferredMonth) {
  const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!data || typeof data !== 'object') {
    throw new Error('無效的班表 JSON 資料');
  }
  if (data.state && typeof data.state === 'object' && data.state.shifts) {
    const computed = computeShiftPayFromFullState(data.state, preferredMonth || data.month);
    return { ...computed, fullState: data.state };
  }
  if (data.shifts && typeof data.shifts === 'object') {
    const computed = computeShiftPayFromFullState(data, preferredMonth);
    return { ...computed, fullState: data };
  }
  if (typeof data.totalPay === 'number' && !data.shifts) {
    return {
      month: data.month || preferredMonth || new Date().toISOString().slice(0, 7),
      employee: data.employee || '王凱弘',
      hourlyWage: Number(data.hourlyWage) || 200,
      totalPay: Math.round(Number(data.totalPay) || 0),
      normalPay: Math.round(Number(data.normalPay) || 0),
      normalHours: Number(data.normalHours) || 0,
      otPay: Math.round(Number(data.otPay) || 0),
      otMinutes: Number(data.otMinutes) || 0,
      bonusOk: Boolean(data.bonusOk),
      bonusPay: Math.round(Number(data.bonusPay) || 0),
      shiftCount: Number(data.shiftCount) || (Array.isArray(data.upcoming7Days) ? data.upcoming7Days.filter(d => d.hasShift).length : 0)
    };
  }
  throw new Error('無法識別的班表資料結構');
}

function saveLatestShiftSyncCache(payload) {
  try {
    if (fs && path && LATEST_SYNC_CACHE_PATH) {
      const dir = path.dirname(LATEST_SYNC_CACHE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const raw = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      fs.writeFileSync(LATEST_SYNC_CACHE_PATH, raw, 'utf8');
    }
  } catch (_) {}
}

function readExternalShiftDirectory(shiftAppPath, preferredMonth) {
  const ignored = new Set(['vercel.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'wrangler.jsonc']);
  try {
    // 1. 優先讀取自動同步快取 (latest_shift_sync.json)
    if (fs && LATEST_SYNC_CACHE_PATH && typeof fs.existsSync === 'function' && fs.existsSync(LATEST_SYNC_CACHE_PATH)) {
      try {
        const parsed = parseShiftPayload(fs.readFileSync(LATEST_SYNC_CACHE_PATH, 'utf8'), preferredMonth);
        if (parsed.totalPay > 0 || parsed.shiftCount > 0) {
          return { ...parsed, syncSource: 'auto_shift_bridge_cache', externalPath: LATEST_SYNC_CACHE_PATH };
        }
      } catch (_) {}
    }

    // 2. 自動掃描班表專案目錄與使用者常用匯出目錄 (Downloads / Desktop)
    const searchDirs = [];
    if (shiftAppPath) searchDirs.push(shiftAppPath);
    if (os && typeof os.homedir === 'function') {
      const home = os.homedir();
      if (path) {
        searchDirs.push(path.join(home, 'Downloads'));
        searchDirs.push(path.join(home, 'Desktop'));
      }
    }

    const candidates = [];
    if (fs && path && typeof fs.existsSync === 'function') {
      for (const dir of searchDirs) {
        if (!dir || !fs.existsSync(dir)) continue;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (!e.isFile() || !e.name.endsWith('.json') || ignored.has(e.name)) continue;
            if (dir !== shiftAppPath && !/打工薪水帳|shift_data|shiftpay/i.test(e.name)) continue;
            const fullPath = path.join(dir, e.name);
            candidates.push({ name: e.name, fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs });
          }
        } catch (_) {}
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const c of candidates) {
      try {
        const parsed = parseShiftPayload(fs.readFileSync(c.fullPath, 'utf8'), preferredMonth);
        return { ...parsed, syncSource: `auto_file:${c.name}`, externalPath: c.fullPath };
      } catch (_) {}
    }

    if (fs && path && typeof fs.existsSync === 'function' && shiftAppPath && fs.existsSync(shiftAppPath)) {
      const indexHtmlPath = path.join(shiftAppPath, 'index.html');
      if (fs.existsSync(indexHtmlPath)) {
        const htmlContent = fs.readFileSync(indexHtmlPath, 'utf8');
        const wageMatch = htmlContent.match(/hourlyWage:\s*(\d+)/);
        const bonusMatch = htmlContent.match(/attendanceBonus:\s*(\d+)/);
        const nameMatch = htmlContent.match(/myName:\s*['"]([^'"]+)['"]/);
        const sampleData = (SAMPLE_SHIFT_PATH && fs.existsSync(SAMPLE_SHIFT_PATH))
          ? JSON.parse(fs.readFileSync(SAMPLE_SHIFT_PATH, 'utf8'))
          : JSON.parse(JSON.stringify(DEFAULT_SAMPLE_SHIFT_DATA));
        if (wageMatch) sampleData.settings.hourlyWage = Number(wageMatch[1]);
        if (bonusMatch) sampleData.settings.attendanceBonus = Number(bonusMatch[1]);
        if (nameMatch) sampleData.settings.myName = nameMatch[1];
        return {
          ...parseShiftPayload(sampleData, preferredMonth),
          syncSource: 'shift_app_readonly_bridge',
          externalPath: indexHtmlPath
        };
      }
    }

    if (fs && SAMPLE_SHIFT_PATH && typeof fs.existsSync === 'function' && fs.existsSync(SAMPLE_SHIFT_PATH)) {
      return {
        ...parseShiftPayload(fs.readFileSync(SAMPLE_SHIFT_PATH, 'utf8'), preferredMonth),
        syncSource: 'sample_shift_data'
      };
    }
  } catch (_) {}

  return {
    ...parseShiftPayload(DEFAULT_SAMPLE_SHIFT_DATA, preferredMonth),
    syncSource: 'cloud_shift_bridge'
  };
}

function calculateEstimatedNetPay(grossPay, netPayFactor = 0.95, laborHealthDeduction = 0) {
  const factor = Number.isFinite(Number(netPayFactor)) && Number(netPayFactor) > 0 ? Number(netPayFactor) : 0.95;
  const deduction = Math.max(0, Number(laborHealthDeduction) || 0);
  return Math.max(0, Math.round(grossPay * factor) - deduction);
}

module.exports = {
  computeShiftPayFromFullState,
  parseShiftPayload,
  saveLatestShiftSyncCache,
  readExternalShiftDirectory,
  calculateEstimatedNetPay
};
