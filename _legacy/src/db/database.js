'use strict';

const { PortableSqliteDb } = require('./portableDb');

let fs = null;
let path = null;
let DatabaseSync = null;

try {
  fs = require('node:fs');
  path = require('node:path');
} catch (_) {}

try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {}

const DEFAULT_DB_PATH = (path && typeof __dirname !== 'undefined')
  ? path.join(__dirname, '..', '..', 'data', 'finance.sqlite')
  : ':portable:';
const SCHEMA_PATH = (path && typeof __dirname !== 'undefined')
  ? path.join(__dirname, 'schema.sql')
  : '';

let dbInstance = null;

/**
 * 建立並初始化資料庫連線（支援 Node.js 原生 node:sqlite 與 Cloudflare 無伺服器 PortableSqliteDb）
 * @param {object} options
 * @param {string} [options.dbPath] - 自訂資料庫路徑、':memory:' 或 ':portable:'
 * @param {boolean} [options.seedDefaults=true] - 是否寫入預設設定與初始資料
 * @param {object} [options.snapshot] - 雲端 D1 或瀏覽器同步之初始狀態快照
 */
function createDatabase(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  const seedDefaults = options.seedDefaults !== false;
  const usePortable = options.engine === 'portable' || dbPath === ':portable:' || !DatabaseSync;

  let db;
  if (usePortable) {
    db = new PortableSqliteDb(options.snapshot || null);
  } else {
    if (dbPath !== ':memory:' && fs && path) {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    db = new DatabaseSync(dbPath);
    if (fs && SCHEMA_PATH && fs.existsSync(SCHEMA_PATH)) {
      const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
      db.exec(schemaSql);
    }
  }

  const nowIso = new Date().toISOString();

  // 確保 user_settings (id = 1) 永遠存在（初始金額歸零）
  const existingSettings = db.prepare('SELECT id FROM user_settings WHERE id = 1').get();
  if (!existingSettings) {
    db.prepare(`
      INSERT INTO user_settings (
        id, payday_day, net_pay_factor, labor_health_deduction,
        default_hourly_wage, shift_app_path, last_known_bank_balance,
        force_high_risk_mode, llm_api_key, gmail_user, gmail_app_password, updated_at
      ) VALUES (
        1, 10, 0.95, 0,
        200, 'C:\\Users\\mrhai\\.gemini\\antigravity\\scratch\\shift-pay-app', 0,
        0, '', '', '', ?
      )
    `).run(nowIso);
  }

  // 確保 wallet_tank (id = 1) 永遠存在（初始悠遊卡與現金水庫歸零）
  const existingTank = db.prepare('SELECT id FROM wallet_tank WHERE id = 1').get();
  if (!existingTank) {
    db.prepare(`
      INSERT INTO wallet_tank (id, easycard_balance, cash_balance, last_audit_at, updated_at)
      VALUES (1, 0, 0, ?, ?)
    `).run(nowIso, nowIso);
  }

  return db;
}

function getDb() {
  if (!dbInstance) {
    dbInstance = createDatabase({ dbPath: DEFAULT_DB_PATH, seedDefaults: true });
  }
  return dbInstance;
}

function setDb(customDb) {
  dbInstance = customDb;
}

module.exports = {
  createDatabase,
  getDb,
  setDb,
  PortableSqliteDb,
  DEFAULT_DB_PATH
};
