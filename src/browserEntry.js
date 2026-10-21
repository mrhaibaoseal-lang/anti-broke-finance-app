'use strict';

const { createDatabase } = require('./db/database');
const { ensureDemoTransactionsIfEmpty, handleApiRequest } = require('./routes/api');

const STORAGE_KEY = 'anti_broke_cloud_snapshot_v2_clean';
let browserDb = null;

function getBrowserDb(clientSnapshot = null) {
  if (!browserDb) {
    let saved = clientSnapshot;
    if (!saved && typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) saved = JSON.parse(raw);
      } catch (_) {}
    }
    browserDb = createDatabase({ engine: 'portable', seedDefaults: false, snapshot: saved || null });
  } else if (clientSnapshot && Number(clientSnapshot.version) > Number(browserDb.version)) {
    browserDb.importSnapshot(clientSnapshot);
  }
  return browserDb;
}

async function handleLocalApi(path, method = 'GET', body = {}) {
  const urlObj = new URL(path, 'http://localhost');
  const db = getBrowserDb(body?._clientState || null);
  const result = await handleApiRequest(method.toUpperCase(), urlObj.pathname, body || {}, urlObj.searchParams, { db });
  const snap = db.exportSnapshot();
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    } catch (_) {}
  }
  return {
    ...(result.data || {}),
    _stateSnapshot: snap
  };
}

if (typeof window !== 'undefined') {
  window.AntiBrokeBrowserEngine = { handleLocalApi };
}

module.exports = { handleLocalApi };
