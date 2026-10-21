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

  // 確保 user_settings (id = 1) 永遠存在
  const existingSettings = db.prepare('SELECT id FROM user_settings WHERE id = 1').get();
  if (!existingSettings) {
    db.prepare(`
      INSERT INTO user_settings (
        id, payday_day, net_pay_factor, labor_health_deduction,
        default_hourly_wage, shift_app_path, last_known_bank_balance,
        force_high_risk_mode, llm_api_key, gmail_user, gmail_app_password, updated_at
      ) VALUES (
        1, 10, 0.95, 0,
        200, 'C:\\Users\\mrhai\\.gemini\\antigravity\\scratch\\shift-pay-app', 18500,
        0, '', '', '', ?
      )
    `).run(nowIso);
  }

  // 確保 wallet_tank (id = 1) 永遠存在
  const existingTank = db.prepare('SELECT id FROM wallet_tank WHERE id = 1').get();
  if (!existingTank) {
    const fourDaysAgo = new Date(Date.now() - 4 * 86400 * 1000).toISOString();
    db.prepare(`
      INSERT INTO wallet_tank (id, easycard_balance, cash_balance, last_audit_at, updated_at)
      VALUES (1, 350, 500, ?, ?)
    `).run(fourDaysAgo, nowIso);
  }

  // 若啟用預設種子資料且 fixed_expenses 為空，寫入常見的訂閱與分期範例
  if (seedDefaults && !options.snapshot) {
    const expCount = db.prepare('SELECT COUNT(*) AS cnt FROM fixed_expenses').get().cnt;
    if (expCount === 0) {
      const insertExp = db.prepare(`
        INSERT INTO fixed_expenses (name, expense_type, monthly_amount, billing_day, total_installments, remaining_installments, note, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      `);
      insertExp.run('手機電信月租費', 'FIXED', 599, 15, null, null, '每月固定電信帳單', nowIso);
      insertExp.run('Netflix 串流訂閱', 'SUBSCRIPTION', 390, 23, null, null, '扣款前 3 天提醒評估是否取消', nowIso);
      insertExp.run('Spotify 個人方案', 'SUBSCRIPTION', 168, 24, null, null, '音樂訂閱服務', nowIso);
      insertExp.run('iPad Air 分期付款', 'INSTALLMENT', 1800, 12, 12, 5, '12期0利率，剩餘5期壓在未來薪水條', nowIso);
    }
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
