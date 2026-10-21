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

  // 選擇最新版本的狀態快照（D1 雲端 vs 瀏覽器端 vs 首次啟動預設展示資料）
  const d1Ver = Number(d1Snapshot?.version) || 0;
  const clientVer = Number(clientSnapshot?.version) || 0;

  if (d1Ver > 0 || clientVer > 0) {
    const bestSnapshot = d1Ver >= clientVer ? d1Snapshot : clientSnapshot;
    const currentVer = edgeInitialized ? (Number(edgeDb.version) || 0) : 0;
    if (!edgeInitialized || bestSnapshot.version >= currentVer) {
      edgeDb.importSnapshot(bestSnapshot);
    }
    edgeInitialized = true;
  } else if (!edgeInitialized) {
    edgeInitialized = true;
    await saveD1Snapshot(d1, edgeDb.exportSnapshot());
  }

  const versionBefore = edgeDb.version;
  const result = await handleApiRequest(method, pathname, body, urlObj.searchParams, { db: edgeDb });
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
