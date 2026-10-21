'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getDb } = require('./db/database');
const { handleApiRequest, ensureDemoTransactionsIfEmpty } = require('./routes/api');

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

    // 靜態檔案服務
    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('[Server Error]', err);
    sendJson(res, 400, { ok: false, error: err.message || '伺服器處理錯誤' });
  }
});

  if (require.main === module) {
  getDb();
  server.listen(PORT, () => {
    console.log(`====================================================================`);
    console.log(`🛡️ 防破產與防衝動消費之智慧記帳系統 (Anti-Broke Finance Tracker)`);
    console.log(`🚀 獨立伺服器已啟動：http://localhost:${PORT}`);
    console.log(`📂 唯讀班表串接路徑：C:\\Users\\mrhai\\.gemini\\antigravity\\scratch\\shift-pay-app`);
    console.log(`====================================================================`);
  });
}

module.exports = { server };
