'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getDb } = require('./db/database');
const { handleApiRequest, ensureDemoTransactionsIfEmpty } = require('./routes/api');
const { pollEsunEmailsViaImap } = require('./services/gmailImapService');
const { syncCycleWithShiftData } = require('./services/survivalEngine');

const PORT = Number(process.env.PORT) || 3088;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        resolve({ rawText: raw });
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    if (pathname.startsWith('/api/')) {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await parseRequestBody(req) : {};
      const result = await handleApiRequest(req.method, pathname, body, urlObj.searchParams);
      return sendJson(res, result.status || 200, result.data);
    }

    // 靜態檔案服務 (支援 /shift-pay 同源開啟打工薪水帳 V2，共用 localStorage 免手動 JSON 同步)
    let filePath;
    if (pathname === '/' || pathname === '/index.html') {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    } else if (pathname === '/shift-pay' || pathname === '/shift-pay/' || pathname === '/shift-pay.html') {
      filePath = path.join(PUBLIC_DIR, 'shift-pay.html');
    } else {
      filePath = path.join(PUBLIC_DIR, pathname);
    }
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('[Server Error]', err);
    sendJson(res, 400, { ok: false, error: err.message || '伺服器處理錯誤' });
  }
});

let bgPollRunning = false;
async function runBackgroundAutoSync() {
  if (bgPollRunning) return;
  bgPollRunning = true;
  try {
    const db = getDb();
    syncCycleWithShiftData(db, { isAutoSync: true });
    const settings = db.prepare('SELECT gmail_user, gmail_app_password FROM user_settings WHERE id = 1').get();
    if (settings && settings.gmail_user && settings.gmail_app_password) {
      await pollEsunEmailsViaImap(db);
    }
  } catch (_) {
  } finally {
    bgPollRunning = false;
  }
}

if (require.main === module) {
  getDb();
  runBackgroundAutoSync();
  setInterval(runBackgroundAutoSync, 60 * 1000).unref();
  server.listen(PORT, () => {
    console.log(`====================================================================`);
    console.log(`🛡️ 防破產與防衝動消費之智慧記帳系統 (Anti-Broke Finance Tracker)`);
    console.log(`🚀 獨立伺服器已啟動：http://localhost:${PORT}`);
    console.log(`📅 內建同源排班算薪水連動：http://localhost:${PORT}/shift-pay`);
    console.log(`⚡ 背景全自動刷卡通知偵測 & 班表同步排程已啟動 (每 60 秒自動巡檢)`);
    console.log(`====================================================================`);
  });
}

module.exports = { server };
