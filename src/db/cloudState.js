'use strict';

const { createDatabase } = require('./database');
const { ensureDemoTransactionsIfEmpty, handleApiRequest } = require('../routes/api');

let edgeDb = null;
let edgeInitialized = false;

async function loadD1Snapshot(d1) {
  if (!d1 || typeof d1.prepare !== 'function') return null;
  try {
    await d1.prepare(`
      CREATE TABLE IF NOT EXISTS app_kv_state (
        id INTEGER PRIMARY KEY,
        state_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      )
    `).run();
    const row = await d1.prepare('SELECT state_json FROM app_kv_state WHERE id = 1').first();
    if (row && row.state_json) {
      return JSON.parse(row.state_json);
    }
  } catch (err) {
    console.warn('[D1 Load Warning]', err.message);
  }
  return null;
}

async function saveD1Snapshot(d1, snapshot) {
  if (!d1 || typeof d1.prepare !== 'function' || !snapshot) return;
  try {
    const jsonStr = JSON.stringify(snapshot);
    const ver = Number(snapshot.version) || 1;
    const nowIso = snapshot.updatedAt || new Date().toISOString();
    await d1.prepare(`
      INSERT INTO app_kv_state (id, state_json, version, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state_json = excluded.state_json,
        version = excluded.version,
        updated_at = excluded.updated_at
    `).bind(jsonStr, ver, nowIso).run();
  } catch (err) {
    console.warn('[D1 Save Warning]', err.message);
  }
}

/**
 * 在 Cloudflare Workers / Pages Functions 處理 API 請求並同步狀態
 */
async function handleCloudflareApiRequest(request, env) {
  const urlObj = new URL(request.url);
  const pathname = urlObj.pathname;
  const method = request.method.toUpperCase();

  let body = {};
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    const raw = await request.text();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch (_) {
        body = { rawText: raw };
      }
    }
  }

  const clientSnapshot = (body && typeof body._clientState === 'object' && body._clientState?.tables)
    ? body._clientState
    : null;

  const d1 = env?.DB || env?.anti_broke_finance_db || null;
  const d1Snapshot = await loadD1Snapshot(d1);

  if (!edgeDb) {
    edgeDb = createDatabase({ engine: 'portable', seedDefaults: true });
  }

  // 選擇最新版本的狀態快照（依據 updatedAt 時間戳與 version 綜合判定，確保雲端背景 Webhook 推播與班表同步永遠優先同步至前端）
  const d1Ver = Number(d1Snapshot?.version) || 0;
  const clientVer = Number(clientSnapshot?.version) || 0;
  const d1Time = d1Snapshot?.updatedAt ? new Date(d1Snapshot.updatedAt).getTime() : 0;
  const clientTime = clientSnapshot?.updatedAt ? new Date(clientSnapshot.updatedAt).getTime() : 0;

  if (d1Ver > 0 || clientVer > 0) {
    let bestSnapshot;
    if (d1Snapshot && clientSnapshot) {
      bestSnapshot = (d1Time >= clientTime || d1Ver >= clientVer) ? d1Snapshot : clientSnapshot;
      const otherSnapshot = bestSnapshot === d1Snapshot ? clientSnapshot : d1Snapshot;

      // 保護已同步的班表與薪資週期：避免前端空白初始週期覆蓋雲端已綁定的班表資料
      if (Array.isArray(otherSnapshot?.tables?.income_cycles)) {
        bestSnapshot.tables = bestSnapshot.tables || {};
        bestSnapshot.tables.income_cycles = Array.isArray(bestSnapshot.tables.income_cycles)
          ? bestSnapshot.tables.income_cycles
          : [];
        for (const otherCycle of otherSnapshot.tables.income_cycles) {
          const idx = bestSnapshot.tables.income_cycles.findIndex(c => c.cycle_key === otherCycle.cycle_key);
          const otherHasShift = Boolean(otherCycle.raw_shift_payload || Number(otherCycle.shift_gross_pay) > 0 || Number(otherCycle.estimated_net_pay) > 0);
          if (idx === -1) {
            bestSnapshot.tables.income_cycles.push(otherCycle);
          } else {
            const curCycle = bestSnapshot.tables.income_cycles[idx];
            const curHasShift = Boolean(curCycle.raw_shift_payload || Number(curCycle.shift_gross_pay) > 0 || Number(curCycle.estimated_net_pay) > 0);
            if (!curHasShift && otherHasShift) {
              bestSnapshot.tables.income_cycles[idx] = otherCycle;
            } else if (otherCycle.raw_shift_payload && !curCycle.raw_shift_payload) {
              bestSnapshot.tables.income_cycles[idx] = {
                ...curCycle,
                raw_shift_payload: otherCycle.raw_shift_payload
              };
            }
          }
        }
      }

      // 保護已綁定的 Gmail 帳號、應用程式密碼與班表時間對照模式
      const bestSet = bestSnapshot?.tables?.user_settings?.[0];
      const otherSet = otherSnapshot?.tables?.user_settings?.[0];
      if (bestSet && otherSet) {
        if (!bestSet.gmail_user && otherSet.gmail_user) bestSet.gmail_user = otherSet.gmail_user;
        if (!bestSet.gmail_app_password && otherSet.gmail_app_password) bestSet.gmail_app_password = otherSet.gmail_app_password;
        if (!bestSet.llm_api_key && otherSet.llm_api_key) bestSet.llm_api_key = otherSet.llm_api_key;
      }
    } else {
      bestSnapshot = d1Snapshot || clientSnapshot;
    }
    const currentVer = edgeInitialized ? (Number(edgeDb.version) || 0) : 0;
    const currentTime = edgeInitialized && edgeDb.updatedAt ? new Date(edgeDb.updatedAt).getTime() : 0;
    const bestTime = bestSnapshot?.updatedAt ? new Date(bestSnapshot.updatedAt).getTime() : 0;
    if (!edgeInitialized || bestTime >= currentTime || bestSnapshot.version >= currentVer) {
      edgeDb.importSnapshot(bestSnapshot);
    }
    edgeInitialized = true;
  } else if (!edgeInitialized) {
    edgeInitialized = true;
    await saveD1Snapshot(d1, edgeDb.exportSnapshot());
  }

  const versionBefore = edgeDb.version;
  const result = await handleApiRequest(method, pathname, body, urlObj.searchParams, { db: edgeDb });
  if (edgeDb.version !== versionBefore) {
    edgeDb.version = Math.max(d1Ver, clientVer, Number(edgeDb.version) || 0) + 1;
    edgeDb.updatedAt = new Date().toISOString();
  }
  const latestSnapshot = edgeDb.exportSnapshot();

  if (edgeDb.version !== versionBefore || (clientVer > d1Ver && d1)) {
    await saveD1Snapshot(d1, latestSnapshot);
  }

  const responseData = (result.data && typeof result.data === 'object')
    ? { ...result.data, _stateSnapshot: latestSnapshot }
    : result.data;

  return {
    status: result.status || 200,
    data: responseData
  };
}

module.exports = {
  handleCloudflareApiRequest
};
