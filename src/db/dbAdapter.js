'use strict';

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

const DEFAULT_SQLITE_PATH = (path && typeof __dirname !== 'undefined')
  ? path.join(__dirname, '..', '..', 'data', 'guardpay_v2.sqlite')
  : ':memory:';

const SCHEMA_FILE_PATH = (path && typeof __dirname !== 'undefined')
  ? path.join(__dirname, 'schema.sql')
  : '';

const D1_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS user_settings (id INTEGER PRIMARY KEY CHECK (id = 1), payday_day INTEGER NOT NULL DEFAULT 10, default_hourly_wage INTEGER NOT NULL DEFAULT 200, net_pay_factor REAL NOT NULL DEFAULT 0.95, labor_health_deduction INTEGER NOT NULL DEFAULT 0, dedupe_window_minutes INTEGER NOT NULL DEFAULT 10, last_known_bank_balance INTEGER NOT NULL DEFAULT 0, force_high_risk_mode INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS budget_cycles (cycle_key TEXT PRIMARY KEY, start_date TEXT NOT NULL, end_date TEXT NOT NULL, base_budget INTEGER NOT NULL DEFAULT 0, budget_note TEXT NOT NULL DEFAULT '手動設定', updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ledger_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_key TEXT NOT NULL, flow_type TEXT NOT NULL DEFAULT 'EXPENSE', payment_medium TEXT NOT NULL DEFAULT 'DIGITAL_BANK', dedupe_status TEXT NOT NULL DEFAULT 'CONFIRMED', dedupe_fingerprint TEXT DEFAULT NULL, raw_merchant TEXT NOT NULL, normalized_merchant TEXT NOT NULL, category TEXT NOT NULL DEFAULT '一般消費', card_last4 TEXT DEFAULT NULL, amount INTEGER NOT NULL DEFAULT 0, budget_impact_amount INTEGER NOT NULL DEFAULT 0, cash_delta INTEGER NOT NULL DEFAULT 0, easycard_delta INTEGER NOT NULL DEFAULT 0, tx_date TEXT NOT NULL, tx_timestamp TEXT NOT NULL, source_channel TEXT NOT NULL DEFAULT 'manual', note TEXT NOT NULL DEFAULT '', raw_payload TEXT DEFAULT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_cycle_flow ON ledger_entries(cycle_key, flow_type, dedupe_status)`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_dedupe ON ledger_entries(dedupe_fingerprint, tx_timestamp)`,
  `CREATE TABLE IF NOT EXISTS ingestion_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, source_channel TEXT NOT NULL, dedupe_fingerprint TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL DEFAULT 0, normalized_merchant TEXT NOT NULL DEFAULT '', action_taken TEXT NOT NULL, linked_entry_id INTEGER DEFAULT NULL, raw_text TEXT NOT NULL, received_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS split_bills (id INTEGER PRIMARY KEY AUTOINCREMENT, ledger_entry_id INTEGER NOT NULL, debtor_name TEXT NOT NULL DEFAULT '朋友', total_amount INTEGER NOT NULL, self_amount INTEGER NOT NULL, receivable_amount INTEGER NOT NULL, is_repaid INTEGER NOT NULL DEFAULT 0, repaid_entry_id INTEGER DEFAULT NULL, created_at TEXT NOT NULL, repaid_at TEXT DEFAULT NULL, FOREIGN KEY (ledger_entry_id) REFERENCES ledger_entries(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS wallet_tank (id INTEGER PRIMARY KEY CHECK (id = 1), cash_balance INTEGER NOT NULL DEFAULT 0, easycard_balance INTEGER NOT NULL DEFAULT 0, last_audit_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wallet_tank_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, tank_type TEXT NOT NULL, delta_amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, note TEXT NOT NULL, linked_entry_id INTEGER DEFAULT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fixed_expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, expense_type TEXT NOT NULL DEFAULT 'FIXED', monthly_amount INTEGER NOT NULL, billing_day INTEGER NOT NULL DEFAULT 15, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cooldown_cart (id INTEGER PRIMARY KEY AUTOINCREMENT, item_name TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', item_type TEXT NOT NULL DEFAULT 'WANT', work_hours_equivalent REAL NOT NULL DEFAULT 0, daily_budget_before INTEGER NOT NULL DEFAULT 0, daily_budget_after INTEGER NOT NULL DEFAULT 0, tier_before TEXT NOT NULL DEFAULT '', tier_after TEXT NOT NULL DEFAULT '', ai_roast_message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'COOLING', created_at TEXT NOT NULL, unlock_at TEXT NOT NULL, resolved_at TEXT DEFAULT NULL)`,
  `CREATE TABLE IF NOT EXISTS balance_sync_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, expected_digital_balance INTEGER NOT NULL, actual_bank_balance INTEGER NOT NULL, discrepancy_amount INTEGER NOT NULL, generated_gap_entry_id INTEGER DEFAULT NULL, note TEXT NOT NULL DEFAULT '', synced_at TEXT NOT NULL)`
];

class SqliteNodeAdapter {
  constructor(sqliteDb) {
    this.rawDb = sqliteDb;
    this.initialized = false;
  }

  async ensureInitialized() {
    if (this.initialized) return;
    if (fs && SCHEMA_FILE_PATH && fs.existsSync(SCHEMA_FILE_PATH)) {
      this.rawDb.exec(fs.readFileSync(SCHEMA_FILE_PATH, 'utf8'));
    }
    const nowIso = new Date().toISOString();
    this.rawDb.prepare(`
      INSERT OR IGNORE INTO user_settings (
        id, payday_day, default_hourly_wage, net_pay_factor, labor_health_deduction,
        dedupe_window_minutes, last_known_bank_balance, force_high_risk_mode, updated_at
      ) VALUES (1, 10, 200, 0.95, 0, 10, 0, 0, ?)
    `).run(nowIso);
    this.rawDb.prepare(`
      INSERT OR IGNORE INTO wallet_tank (id, cash_balance, easycard_balance, last_audit_at, updated_at)
      VALUES (1, 0, 0, ?, ?)
    `).run(nowIso, nowIso);
    this.initialized = true;
  }

  async queryOne(sql, params = []) {
    await this.ensureInitialized();
    return this.rawDb.prepare(sql).get(...params) || null;
  }

  async queryAll(sql, params = []) {
    await this.ensureInitialized();
    return this.rawDb.prepare(sql).all(...params) || [];
  }

  async execute(sql, params = []) {
    await this.ensureInitialized();
    const res = this.rawDb.prepare(sql).run(...params);
    return {
      lastInsertRowid: Number(res.lastInsertRowid || 0),
      changes: Number(res.changes || 0)
    };
  }

  async execScript(sqlScript) {
    await this.ensureInitialized();
    this.rawDb.exec(sqlScript);
  }
}

class CloudflareD1Adapter {
  constructor(d1Binding, schemaSql = '') {
    this.d1 = d1Binding;
    this.schemaSql = schemaSql;
    this.initialized = false;
  }

  async ensureInitialized() {
    if (this.initialized) return;
    for (const st of D1_SCHEMA_STATEMENTS) {
      await this.d1.prepare(st).run();
    }
    const nowIso = new Date().toISOString();
    await this.d1.prepare(`
      INSERT OR IGNORE INTO user_settings (
        id, payday_day, default_hourly_wage, net_pay_factor, labor_health_deduction,
        dedupe_window_minutes, last_known_bank_balance, force_high_risk_mode, updated_at
      ) VALUES (1, 10, 200, 0.95, 0, 10, 0, 0, ?)
    `).bind(nowIso).run();
    await this.d1.prepare(`
      INSERT OR IGNORE INTO wallet_tank (id, cash_balance, easycard_balance, last_audit_at, updated_at)
      VALUES (1, 0, 0, ?, ?)
    `).bind(nowIso, nowIso).run();
    this.initialized = true;
  }

  async queryOne(sql, params = []) {
    await this.ensureInitialized();
    return (await this.d1.prepare(sql).bind(...params).first()) || null;
  }

  async queryAll(sql, params = []) {
    await this.ensureInitialized();
    const res = await this.d1.prepare(sql).bind(...params).all();
    return res?.results || [];
  }

  async execute(sql, params = []) {
    await this.ensureInitialized();
    const res = await this.d1.prepare(sql).bind(...params).run();
    return {
      lastInsertRowid: Number(res?.meta?.last_row_id || 0),
      changes: Number(res?.meta?.changes || 0)
    };
  }

  async execScript(sqlScript) {
    await this.ensureInitialized();
    const stmts = String(sqlScript || '').split(';').map(s => s.trim()).filter(Boolean);
    for (const st of stmts) {
      await this.d1.prepare(st).run();
    }
  }
}

let defaultLocalAdapter = null;

function createSqliteAdapter(dbPath = DEFAULT_SQLITE_PATH) {
  if (!DatabaseSync) {
    throw new Error('當前環境不支援 node:sqlite');
  }
  if (dbPath !== ':memory:' && fs && path) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  return new SqliteNodeAdapter(new DatabaseSync(dbPath));
}

function createD1Adapter(d1Binding, schemaSql = '') {
  return new CloudflareD1Adapter(d1Binding, schemaSql);
}

function getDefaultDbAdapter() {
  if (!defaultLocalAdapter) {
    defaultLocalAdapter = createSqliteAdapter(DEFAULT_SQLITE_PATH);
  }
  return defaultLocalAdapter;
}

function setDefaultDbAdapter(adapter) {
  defaultLocalAdapter = adapter;
}

module.exports = {
  SqliteNodeAdapter,
  CloudflareD1Adapter,
  createSqliteAdapter,
  createD1Adapter,
  getDefaultDbAdapter,
  setDefaultDbAdapter,
  DEFAULT_SQLITE_PATH
};
