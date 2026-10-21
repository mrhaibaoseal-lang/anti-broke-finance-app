(function() {
  var modules = {
  "portableDb": function(module, exports, require) {
'use strict';

const TABLE_DEFAULTS = {
  user_settings: () => ({
    id: 1, payday_day: 10, net_pay_factor: 0.95, labor_health_deduction: 0,
    default_hourly_wage: 200, shift_app_path: 'C:\\Users\\mrhai\\.gemini\\antigravity\\scratch\\shift-pay-app',
    last_known_bank_balance: 18500, force_high_risk_mode: 0, llm_api_key: '',
    gmail_user: '', gmail_app_password: '', updated_at: ''
  }),
  income_cycles: () => ({
    id: null, cycle_key: '', start_date: '', end_date: '', target_shift_month: '',
    shift_gross_pay: 0, normal_hours: 0, ot_minutes: 0, bonus_pay: 0, hourly_wage: 200,
    estimated_net_pay: 0, actual_salary: null, is_salary_settled: 0,
    shift_sync_source: 'init', raw_shift_payload: null, last_synced_at: ''
  }),
  transactions: () => ({
    id: null, cycle_key: '', status: 'PENDING', raw_merchant: '', normalized_merchant: '',
    category: '一般消費', auth_amount: 0, settled_amount: null, fx_fee_diff: 0,
    effective_amount: 0, personal_amount: 0, tx_date: '', tx_timestamp: '',
    settled_at: null, auth_code: null, is_reconciled_locked: 0, reconcile_score: null,
    reconcile_note: null, is_foreign_tx: 0, is_ghost_alerted: 0,
    channel_a_raw: null, channel_b_raw: null, created_at: ''
  }),
  notification_logs: () => ({
    id: null, source: 'manual', channel_type: '', normalized_merchant: '',
    amount: 0, dedupe_hash: '', action_taken: '', linked_tx_id: null, raw_text: '', received_at: ''
  }),
  split_bills: () => ({
    id: null, transaction_id: 0, total_amount: 0, self_amount: 0,
    receivable_amount: 0, debtor_name: '', is_repaid: 0, created_at: '', repaid_at: null
  }),
  cooldown_cart: () => ({
    id: null, item_name: '', amount: 0, reason: '', item_type: 'WANT',
    work_hours_equivalent: 0, work_time_text: '', daily_budget_before: 0, daily_budget_after: 0,
    tier_before: '', tier_after: '', ai_roast_message: '', created_at: '',
    unlock_at: '', status: 'COOLING', resolved_at: null
  }),
  fixed_expenses: () => ({
    id: null, name: '', expense_type: 'FIXED', monthly_amount: 0, billing_day: 15,
    total_installments: null, remaining_installments: null, note: '', is_active: 1, created_at: ''
  }),
  wallet_tank: () => ({
    id: 1, easycard_balance: 350, cash_balance: 500, last_audit_at: '', updated_at: ''
  }),
  wallet_tank_logs: () => ({
    id: null, tank_type: 'CASH', delta_amount: 0, balance_after: 0,
    note: '', linked_tx_id: null, created_at: ''
  }),
  balance_sync_logs: () => ({
    id: null, system_expected_balance: 0, actual_esun_balance: 0,
    discrepancy_amount: 0, generated_gap_tx_id: null, note: '', synced_at: ''
  })
};

function splitSqlTokens(str) {
  const tokens = [];
  let cur = '', inQuote = false, depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && str[i - 1] !== '\\') {
      if (inQuote && str[i + 1] === "'") { cur += "''"; i++; continue; }
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (!inQuote) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) { tokens.push(cur.trim()); cur = ''; continue; }
    }
    cur += ch;
  }
  if (cur.trim()) tokens.push(cur.trim());
  return tokens;
}

function parseSqlValueToken(token, params, ref) {
  const t = token.trim();
  if (t === '?') {
    const v = params[ref.idx++];
    return v === undefined ? null : v;
  }
  if (/^NULL$/i.test(t)) return null;
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  const num = Number(t);
  return Number.isNaN(num) ? t : num;
}


class PortableSqliteDb {
  constructor(initialSnapshot = null) {
    this.resetTables();
    this.version = 1;
    this.updatedAt = new Date().toISOString();
    if (initialSnapshot) this.importSnapshot(initialSnapshot);
  }

  resetTables() {
    this.tables = {};
    this.seq = {};
    for (const table of Object.keys(TABLE_DEFAULTS)) {
      this.tables[table] = [];
      this.seq[table] = 0;
    }
  }

  exportSnapshot() {
    return {
      version: this.version,
      updatedAt: this.updatedAt,
      seq: { ...this.seq },
      tables: JSON.parse(JSON.stringify(this.tables))
    };
  }

  importSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.tables) return false;
    this.resetTables();
    for (const table of Object.keys(TABLE_DEFAULTS)) {
      if (Array.isArray(snapshot.tables[table])) {
        this.tables[table] = JSON.parse(JSON.stringify(snapshot.tables[table]));
      }
      const maxId = this.tables[table].reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
      this.seq[table] = Math.max(maxId, Number(snapshot.seq?.[table]) || 0);
    }
    this.version = Number(snapshot.version) || 1;
    this.updatedAt = snapshot.updatedAt || new Date().toISOString();
    return true;
  }

  touch() {
    this.version = (this.version || 1) + 1;
    this.updatedAt = new Date().toISOString();
  }

  exec(sql) {
    const stmts = String(sql || '').split(';').map(s => s.trim()).filter(Boolean);
    let mutated = false;
    for (const stmt of stmts) {
      const m = stmt.match(/^DELETE\s+FROM\s+([a-zA-Z0-9_]+)$/i);
      if (m && this.tables[m[1]]) {
        this.tables[m[1]] = [];
        mutated = true;
      }
    }
    if (mutated) this.touch();
  }

  prepare(sql) {
    const norm = String(sql || '').replace(/\s+/g, ' ').trim();
    const self = this;
    return {
      run(...params) {
        const res = self._executeRun(norm, params);
        self.touch();
        return res;
      },
      get(...params) {
        return self._executeGet(norm, params);
      },
      all(...params) {
        return self._executeAll(norm, params);
      }
    };
  }

  _executeRun(sql, params) {
    const ins = sql.match(/^INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+)\)$/i);
    if (ins) {
      const [, table, colStr, valStr] = ins;
      const cols = splitSqlTokens(colStr);
      const vals = splitSqlTokens(valStr);
      const ref = { idx: 0 };
      const row = TABLE_DEFAULTS[table] ? TABLE_DEFAULTS[table]() : {};
      for (let i = 0; i < cols.length; i++) {
        row[cols[i].trim()] = parseSqlValueToken(vals[i], params, ref);
      }
      if (row.id === null || row.id === undefined) {
        this.seq[table] = (this.seq[table] || 0) + 1;
        row.id = this.seq[table];
      } else {
        this.seq[table] = Math.max(this.seq[table] || 0, Number(row.id) || 0);
      }
      const idx = this.tables[table].findIndex(r => r.id === row.id);
      if (idx >= 0) this.tables[table][idx] = row;
      else this.tables[table].push(row);
      return { changes: 1, lastInsertRowid: row.id };
    }

    const del = sql.match(/^DELETE\s+FROM\s+([a-zA-Z0-9_]+)\s+WHERE\s+id\s*=\s*\?$/i);
    if (del) {
      const table = del[1];
      const id = Number(params[0]);
      const before = this.tables[table].length;
      if (table === 'transactions') {
        this.tables.split_bills = this.tables.split_bills.filter(s => Number(s.transaction_id) !== id);
      }
      this.tables[table] = this.tables[table].filter(r => Number(r.id) !== id);
      return { changes: before - this.tables[table].length, lastInsertRowid: 0 };
    }

    const upd = sql.match(/^UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i);
    if (upd) {
      const [, table, setClause, whereClause] = upd;
      const assigns = splitSqlTokens(setClause);
      const ref = { idx: 0 };
      const setters = assigns.map(a => {
        const eq = a.indexOf('=');
        const col = a.slice(0, eq).trim();
        const expr = a.slice(eq + 1).trim();
        if (/^CASE\s+WHEN\s+\?\s*!=\s*0\s+THEN\s+1\s+ELSE\s+is_foreign_tx\s+END$/i.test(expr)) {
          const cond = params[ref.idx++];
          return r => { r[col] = Number(cond) !== 0 ? 1 : r.is_foreign_tx; };
        }
        const v = parseSqlValueToken(expr, params, ref);
        return r => { r[col] = v; };
      });

      let matchFn = () => false;
      if (/^id\s*=\s*1$/i.test(whereClause)) matchFn = r => Number(r.id) === 1;
      else if (/^id\s*=\s*\?$/i.test(whereClause)) {
        const id = Number(params[ref.idx++]);
        matchFn = r => Number(r.id) === id;
      } else if (/^cycle_key\s*=\s*\?$/i.test(whereClause)) {
        const ck = String(params[ref.idx++]);
        matchFn = r => String(r.cycle_key) === ck;
      }

      let changes = 0;
      for (const r of this.tables[table] || []) {
        if (matchFn(r)) {
          for (const fn of setters) fn(r);
          changes++;
        }
      }
      return { changes, lastInsertRowid: 0 };
    }

    throw new Error(`Unsupported RUN SQL: ${sql}`);
  }

  _executeGet(sql, params) {
    const cnt = sql.match(/^SELECT\s+COUNT\(\*\)\s+AS\s+cnt\s+FROM\s+([a-zA-Z0-9_]+)$/i);
    if (cnt) return { cnt: (this.tables[cnt[1]] || []).length };

    if (/total_fixed\s+FROM\s+fixed_expenses/i.test(sql)) {
      const total = this.tables.fixed_expenses
        .filter(r => Number(r.is_active) === 1)
        .reduce((s, r) => s + (Number(r.monthly_amount) || 0), 0);
      return { total_fixed: total };
    }

    if (/AS\s+total_spent/i.test(sql) && /FROM\s+transactions\s+WHERE\s+cycle_key\s*=\s*\?/i.test(sql)) {
      const [refDate, cycleKey] = params;
      const rows = this.tables.transactions.filter(t => String(t.cycle_key) === String(cycleKey));
      let total_spent = 0, pending_spent = 0, settled_spent = 0, gap_spent = 0, today_spent = 0;
      for (const t of rows) {
        const amt = Number(t.personal_amount) || 0;
        if (['PENDING', 'SETTLED', 'UNKNOWN_GAP'].includes(t.status)) {
          total_spent += amt;
          if (t.tx_date === refDate) today_spent += amt;
        }
        if (t.status === 'PENDING') pending_spent += amt;
        if (t.status === 'SETTLED') settled_spent += amt;
        if (t.status === 'UNKNOWN_GAP') gap_spent += amt;
      }
      return { total_spent, pending_spent, settled_spent, gap_spent, today_spent };
    }

    const id1 = sql.match(/^SELECT\s+[\s\S]+?\s+FROM\s+(user_settings|wallet_tank)\s+WHERE\s+id\s*=\s*1$/i);
    if (id1) {
      const r = (this.tables[id1[1]] || []).find(x => Number(x.id) === 1);
      return r ? { ...r } : undefined;
    }

    if (/^SELECT\s+\*\s+FROM\s+income_cycles\s+WHERE\s+cycle_key\s*=\s*\?$/i.test(sql)) {
      const r = this.tables.income_cycles.find(x => String(x.cycle_key) === String(params[0]));
      return r ? { ...r } : undefined;
    }

    if (/^SELECT\s+\*\s+FROM\s+transactions\s+WHERE\s+id\s*=\s*\?\s+AND\s+status\s*=\s*'UNKNOWN_GAP'$/i.test(sql)) {
      const r = this.tables.transactions.find(x => Number(x.id) === Number(params[0]) && x.status === 'UNKNOWN_GAP');
      return r ? { ...r } : undefined;
    }

    const byId = sql.match(/^SELECT\s+\*\s+FROM\s+([a-zA-Z0-9_]+)\s+WHERE\s+id\s*=\s*\?$/i);
    if (byId) {
      const r = (this.tables[byId[1]] || []).find(x => Number(x.id) === Number(params[0]));
      return r ? { ...r } : undefined;
    }

    if (/^SELECT\s+id\s+FROM\s+split_bills\s+WHERE\s+transaction_id\s*=\s*\?$/i.test(sql)) {
      const r = this.tables.split_bills.find(x => Number(x.transaction_id) === Number(params[0]));
      return r ? { id: r.id } : undefined;
    }

    if (/^SELECT\s+\*\s+FROM\s+split_bills\s+WHERE\s+transaction_id\s*=\s*\?\s+ORDER\s+BY\s+id\s+DESC\s+LIMIT\s+1$/i.test(sql)) {
      const rows = this.tables.split_bills
        .filter(x => Number(x.transaction_id) === Number(params[0]))
        .sort((a, b) => b.id - a.id);
      return rows[0] ? { ...rows[0] } : undefined;
    }

    if (/FROM\s+transactions\s+WHERE\s+status\s+IN\s*\('PENDING',\s*'SETTLED'\)\s+AND\s+\(normalized_merchant\s*=\s*\?/i.test(sql)) {
      const [merchant, authAmt, effAmt] = params;
      const rows = this.tables.transactions
        .filter(t => ['PENDING', 'SETTLED'].includes(t.status) && (
          t.normalized_merchant === merchant ||
          Number(t.auth_amount) === Number(authAmt) ||
          Number(t.effective_amount) === Number(effAmt)
        ))
        .sort((a, b) => b.id - a.id);
      return rows[0] ? { ...rows[0] } : undefined;
    }

    return this._executeAll(sql, params)[0];
  }

  _executeAll(sql, params) {
    if (/FROM\s+transactions\s+t\s+LEFT\s+JOIN\s+split_bills\s+s\s+ON\s+s\.transaction_id\s*=\s*t\.id/i.test(sql)) {
      return [...this.tables.transactions]
        .sort((a, b) => String(b.tx_date).localeCompare(String(a.tx_date)) || (b.id - a.id))
        .slice(0, 100)
        .map(t => {
          const s = this.tables.split_bills.find(sb => Number(sb.transaction_id) === Number(t.id));
          return {
            ...t,
            split_id: s ? s.id : null,
            split_self_amount: s ? s.self_amount : null,
            split_receivable_amount: s ? s.receivable_amount : null,
            split_debtor_name: s ? s.debtor_name : null,
            split_is_repaid: s ? s.is_repaid : null
          };
        });
    }

    if (/FROM\s+split_bills\s+s\s+LEFT\s+JOIN\s+transactions\s+t\s+ON\s+t\.id\s*=\s*s\.transaction_id/i.test(sql)) {
      return [...this.tables.split_bills]
        .sort((a, b) => (Number(a.is_repaid) - Number(b.is_repaid)) || (b.id - a.id))
        .map(s => {
          const t = this.tables.transactions.find(tx => Number(tx.id) === Number(s.transaction_id));
          return {
            ...s,
            normalized_merchant: t ? t.normalized_merchant : null,
            tx_date: t ? t.tx_date : null,
            tx_status: t ? t.status : null
          };
        });
    }

    if (/FROM\s+notification_logs\s+WHERE\s+channel_type\s*=\s*'CHANNEL_A_AUTH'\s+AND\s+dedupe_hash\s*=\s*\?/i.test(sql)) {
      const hash = String(params[0]);
      return this.tables.notification_logs
        .filter(l => l.channel_type === 'CHANNEL_A_AUTH' && l.dedupe_hash === hash)
        .sort((a, b) => b.id - a.id)
        .slice(0, 5)
        .map(l => ({ id: l.id, received_at: l.received_at, linked_tx_id: l.linked_tx_id }));
    }

    if (/FROM\s+transactions\s+WHERE\s+status\s+IN\s*\('PENDING',\s*'TEMP_HOLD'\)\s+AND\s+is_reconciled_locked\s*=\s*0/i.test(sql)) {
      return this.tables.transactions
        .filter(t => ['PENDING', 'TEMP_HOLD'].includes(t.status) && Number(t.is_reconciled_locked) === 0)
        .sort((a, b) =>
          String(a.tx_date).localeCompare(String(b.tx_date)) ||
          String(a.tx_timestamp).localeCompare(String(b.tx_timestamp)) ||
          (a.id - b.id)
        )
        .map(t => ({ ...t }));
    }

    if (/FROM\s+transactions\s+WHERE\s+status\s*=\s*'PENDING'\s+AND\s+is_reconciled_locked\s*=\s*0/i.test(sql)) {
      return this.tables.transactions
        .filter(t => t.status === 'PENDING' && Number(t.is_reconciled_locked) === 0)
        .sort((a, b) => String(a.tx_date).localeCompare(String(b.tx_date)) || (a.id - b.id))
        .map(t => ({ ...t }));
    }

    if (/effective_amount\s*>\s*0\s+AND\s+effective_amount\s*<\s*200/i.test(sql)) {
      const [startStr, endStr] = params;
      return this.tables.transactions
        .filter(t =>
          ['PENDING', 'SETTLED'].includes(t.status) &&
          Number(t.effective_amount) > 0 &&
          Number(t.effective_amount) < 200 &&
          String(t.tx_date) >= String(startStr) &&
          String(t.tx_date) <= String(endStr)
        )
        .sort((a, b) => String(b.tx_date).localeCompare(String(a.tx_date)) || (b.id - a.id))
        .map(t => ({ ...t }));
    }

    if (/FROM\s+fixed_expenses\s+WHERE\s+is_active\s*=\s*1/i.test(sql)) {
      return this.tables.fixed_expenses
        .filter(f => Number(f.is_active) === 1)
        .sort((a, b) => Number(a.billing_day) - Number(b.billing_day))
        .map(f => ({ ...f }));
    }

    const simple = sql.match(/^SELECT\s+\*\s+FROM\s+([a-zA-Z0-9_]+)\s+ORDER\s+BY\s+id\s+DESC(?:\s+LIMIT\s+(\d+))?$/i);
    if (simple) {
      const sorted = [...(this.tables[simple[1]] || [])].sort((a, b) => b.id - a.id).map(r => ({ ...r }));
      return simple[2] ? sorted.slice(0, Number(simple[2])) : sorted;
    }

    throw new Error(`Unsupported ALL SQL: ${sql}`);
  }
}

module.exports = {
  PortableSqliteDb,
  TABLE_DEFAULTS
};


  },
  "database": function(module, exports, require) {
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

  },
  "shiftSyncService": function(module, exports, require) {
'use strict';

let fs = null;
let path = null;
try {
  fs = require('node:fs');
  path = require('node:path');
} catch (_) {}

const SAMPLE_SHIFT_PATH = (path && typeof __dirname !== 'undefined')
  ? path.join(__dirname, '..', '..', 'data', 'sample_shift_data.json')
  : '';

const DEFAULT_SAMPLE_SHIFT_DATA = {
  app: 'shiftpay-v2',
  exportedAt: '2026-10-21T08:00:00.000Z',
  settings: {
    hourlyWage: 200,
    otMultiplier: 1.34,
    roundingMode: 'monthly',
    attendanceBonus: 500,
    myName: '王凱弘'
  },
  stamps: [
    { id: 's1', name: '早班', start: '09:00', end: '17:00', breakMin: 60, color: '#0A84FF' },
    { id: 's2', name: '晚班', start: '18:00', end: '22:00', breakMin: 0, color: '#BF5AF2' },
    { id: 's3', name: '假日班', start: '10:00', end: '19:00', breakMin: 60, color: '#FF9F0A' }
  ],
  shifts: {
    '2026-10-01': { name: '晚班', color: '#BF5AF2', start: '18:00', end: '22:00', breakMin: 0, stampId: 's2', otMin: 30, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-03': { name: '假日班', color: '#FF9F0A', start: '10:00', end: '19:00', breakMin: 60, stampId: 's3', otMin: 0, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-04': { name: '假日班', color: '#FF9F0A', start: '10:00', end: '19:00', breakMin: 60, stampId: 's3', otMin: 45, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-06': { name: '晚班', color: '#BF5AF2', start: '18:00', end: '22:00', breakMin: 0, stampId: 's2', otMin: 0, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-08': { name: '晚班', color: '#BF5AF2', start: '18:00', end: '22:00', breakMin: 0, stampId: 's2', otMin: 0, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-10': { name: '假日班', color: '#FF9F0A', start: '10:00', end: '19:00', breakMin: 60, stampId: 's3', otMin: 60, status: 'normal', leaveType: 'late', note: '國慶連假' },
    '2026-10-11': { name: '假日班', color: '#FF9F0A', start: '10:00', end: '19:00', breakMin: 60, stampId: 's3', otMin: 0, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-13': { name: '晚班', color: '#BF5AF2', start: '18:00', end: '22:00', breakMin: 0, stampId: 's2', otMin: 0, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-15': { name: '晚班', color: '#BF5AF2', start: '18:00', end: '22:00', breakMin: 0, stampId: 's2', otMin: 30, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-17': { name: '假日班', color: '#FF9F0A', start: '10:00', end: '19:00', breakMin: 60, stampId: 's3', otMin: 0, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-18': { name: '假日班', color: '#FF9F0A', start: '10:00', end: '19:00', breakMin: 60, stampId: 's3', otMin: 0, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-20': { name: '晚班', color: '#BF5AF2', start: '18:00', end: '22:00', breakMin: 0, stampId: 's2', otMin: 0, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-22': { name: '晚班', color: '#BF5AF2', start: '18:00', end: '22:00', breakMin: 0, stampId: 's2', otMin: 0, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-24': { name: '假日班', color: '#FF9F0A', start: '10:00', end: '19:00', breakMin: 60, stampId: 's3', otMin: 0, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-25': { name: '假日班', color: '#FF9F0A', start: '10:00', end: '19:00', breakMin: 60, stampId: 's3', otMin: 0, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-27': { name: '晚班', color: '#BF5AF2', start: '18:00', end: '22:00', breakMin: 0, stampId: 's2', otMin: 0, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-29': { name: '晚班', color: '#BF5AF2', start: '18:00', end: '22:00', breakMin: 0, stampId: 's2', otMin: 0, status: 'normal', leaveType: 'late', note: '' },
    '2026-10-31': { name: '假日班', color: '#FF9F0A', start: '10:00', end: '19:00', breakMin: 60, stampId: 's3', otMin: 0, status: 'normal', leaveType: 'late', note: '' }
  }
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
      shiftCount: Array.isArray(data.upcoming7Days) ? data.upcoming7Days.filter(d => d.hasShift).length : 0
    };
  }
  if (data.shifts && typeof data.shifts === 'object') {
    return computeShiftPayFromFullState(data, preferredMonth);
  }
  throw new Error('無法識別的班表 JSON 結構（需為 shiftpay-v2 小工具 JSON 或備份 JSON）');
}

function readExternalShiftDirectory(shiftAppPath, preferredMonth) {
  const ignored = new Set(['vercel.json', 'package.json', 'package-lock.json', 'tsconfig.json']);
  try {
    if (fs && path && typeof fs.existsSync === 'function' && shiftAppPath && fs.existsSync(shiftAppPath)) {
      const entries = fs.readdirSync(shiftAppPath, { withFileTypes: true });
      const candidates = entries
        .filter(e => e.isFile() && e.name.endsWith('.json') && !ignored.has(e.name))
        .map(e => {
          const fullPath = path.join(shiftAppPath, e.name);
          return { name: e.name, fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const c of candidates) {
        try {
          const parsed = parseShiftPayload(fs.readFileSync(c.fullPath, 'utf8'), preferredMonth);
          return { ...parsed, syncSource: `external_file:${c.name}`, externalPath: c.fullPath };
        } catch (_) {}
      }

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
  readExternalShiftDirectory,
  calculateEstimatedNetPay
};

  },
  "survivalEngine": function(module, exports, require) {
'use strict';

const { readExternalShiftDirectory, parseShiftPayload, calculateEstimatedNetPay } = require('./shiftSyncService');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatYMD(dt) {
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/**
 * 1.2 自訂「發薪日生存週期」計算器 (禁止死板以每月 1 號重置)
 */
function getCycleRangeForDate(dateStr, paydayDay = 10) {
  const safePayday = Math.min(28, Math.max(1, Number(paydayDay) || 10));
  const ref = dateStr ? new Date(`${dateStr.slice(0, 10)}T00:00:00`) : new Date();
  const y = ref.getFullYear();
  const m = ref.getMonth();
  const d = ref.getDate();

  const startDt = d >= safePayday ? new Date(y, m, safePayday) : new Date(y, m - 1, safePayday);
  const endDt = d >= safePayday ? new Date(y, m + 1, safePayday - 1) : new Date(y, m, safePayday - 1);

  const startDate = formatYMD(startDt);
  const endDate = formatYMD(endDt);
  return {
    cycleKey: `${startDate}_${endDate}`,
    startDate,
    endDate,
    targetShiftMonth: startDate.slice(0, 7),
    paydayDay: safePayday
  };
}

function ensureCurrentCycle(db, referenceDateStr) {
  const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
  const range = getCycleRangeForDate(referenceDateStr, settings.payday_day);

  let cycle = db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(range.cycleKey);
  if (!cycle) {
    const synced = readExternalShiftDirectory(settings.shift_app_path, range.targetShiftMonth);
    const estNetPay = calculateEstimatedNetPay(
      synced.totalPay,
      settings.net_pay_factor,
      settings.labor_health_deduction
    );
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO income_cycles (
        cycle_key, start_date, end_date, target_shift_month,
        shift_gross_pay, normal_hours, ot_minutes, bonus_pay,
        hourly_wage, estimated_net_pay, actual_salary, is_salary_settled,
        shift_sync_source, raw_shift_payload, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)
    `).run(
      range.cycleKey,
      range.startDate,
      range.endDate,
      synced.month || range.targetShiftMonth,
      synced.totalPay,
      synced.normalHours,
      synced.otMinutes,
      synced.bonusPay,
      synced.hourlyWage,
      estNetPay,
      synced.syncSource,
      JSON.stringify(synced),
      nowIso
    );

    if (synced.hourlyWage > 0) {
      db.prepare('UPDATE user_settings SET default_hourly_wage = ?, updated_at = ? WHERE id = 1')
        .run(synced.hourlyWage, nowIso);
    }
    cycle = db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(range.cycleKey);
  }
  return cycle;
}

function syncCycleWithShiftData(db, { rawJsonPayload = null, referenceDateStr = null } = {}) {
  const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
  const cycle = ensureCurrentCycle(db, referenceDateStr);

  const synced = rawJsonPayload
    ? { ...parseShiftPayload(rawJsonPayload, cycle.target_shift_month), syncSource: 'clipboard_or_upload_json' }
    : readExternalShiftDirectory(settings.shift_app_path, cycle.target_shift_month);

  const estNetPay = calculateEstimatedNetPay(
    synced.totalPay,
    settings.net_pay_factor,
    settings.labor_health_deduction
  );
  const nowIso = new Date().toISOString();

  db.prepare(`
    UPDATE income_cycles
    SET shift_gross_pay = ?, normal_hours = ?, ot_minutes = ?, bonus_pay = ?,
        hourly_wage = ?, estimated_net_pay = ?, shift_sync_source = ?,
        raw_shift_payload = ?, last_synced_at = ?
    WHERE cycle_key = ?
  `).run(
    synced.totalPay, synced.normalHours, synced.otMinutes, synced.bonusPay,
    synced.hourlyWage, estNetPay, synced.syncSource,
    JSON.stringify(synced), nowIso, cycle.cycle_key
  );

  if (synced.hourlyWage > 0) {
    db.prepare('UPDATE user_settings SET default_hourly_wage = ?, updated_at = ? WHERE id = 1')
      .run(synced.hourlyWage, nowIso);
  }
  return db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(cycle.cycle_key);
}

function applyActualSalaryDeposit(db, actualAmount, referenceDateStr) {
  const cycle = ensureCurrentCycle(db, referenceDateStr);
  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE income_cycles
    SET actual_salary = ?, is_salary_settled = 1, last_synced_at = ?
    WHERE cycle_key = ?
  `).run(Math.round(Number(actualAmount)), nowIso, cycle.cycle_key);
  return db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(cycle.cycle_key);
}

function evaluateSurvivalTier(dailySafeAmount) {
  if (dailySafeAmount > 500) {
    return { code: 'WEALTHY', emoji: '🟢', label: '財富自由級', rangeText: '每日可用 > $500', themeColor: 'emerald', advice: '手頭寬裕！記得把多餘額度存起來，別在深夜手滑。' };
  }
  if (dailySafeAmount >= 250) {
    return { code: 'NORMAL', emoji: '🟡', label: '普通生存級', rangeText: '每日可用 $250 ~ $500', themeColor: 'amber', advice: '收支平衡！三餐正常吃沒問題，買超過 $300 的非必需品請先三思。' };
  }
  if (dailySafeAmount >= 150) {
    return { code: 'BEGGAR_HERO', emoji: '🟠', label: '超商乞丐超人級', rangeText: '每日可用 $150 ~ $250', themeColor: 'orange', advice: '警報響起！請鎖定超商 20:00 後友善時光，禁止手搖飲與消夜！' };
  }
  return { code: 'DIRT_EATING', emoji: '🔴', label: '極限吃土喝水級', rangeText: '每日可用 < $150', themeColor: 'rose', advice: '紅色破產危機！目前額度連便當都危險，嚴禁任何非生存必要支出！' };
}

function getSurvivalDashboardMetrics(db, referenceDateStr) {
  const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
  const refDate = (referenceDateStr || formatYMD(new Date())).slice(0, 10);
  const cycle = ensureCurrentCycle(db, refDate);

  const effectiveIncome = cycle.is_salary_settled && cycle.actual_salary !== null
    ? Number(cycle.actual_salary)
    : Number(cycle.estimated_net_pay);

  const fixedRow = db.prepare('SELECT COALESCE(SUM(monthly_amount), 0) AS total_fixed FROM fixed_expenses WHERE is_active = 1').get();
  const fixedAndInstallments = Number(fixedRow.total_fixed) || 0;

  const spentRow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('PENDING', 'SETTLED', 'UNKNOWN_GAP') THEN personal_amount ELSE 0 END), 0) AS total_spent,
      COALESCE(SUM(CASE WHEN status = 'PENDING' THEN personal_amount ELSE 0 END), 0) AS pending_spent,
      COALESCE(SUM(CASE WHEN status = 'SETTLED' THEN personal_amount ELSE 0 END), 0) AS settled_spent,
      COALESCE(SUM(CASE WHEN status = 'UNKNOWN_GAP' THEN personal_amount ELSE 0 END), 0) AS gap_spent,
      COALESCE(SUM(CASE WHEN status IN ('PENDING', 'SETTLED', 'UNKNOWN_GAP') AND tx_date = ? THEN personal_amount ELSE 0 END), 0) AS today_spent
    FROM transactions WHERE cycle_key = ?
  `).get(refDate, cycle.cycle_key);

  const totalSpent = Number(spentRow.total_spent) || 0;
  const todaySpent = Number(spentRow.today_spent) || 0;

  const startMs = new Date(`${cycle.start_date}T00:00:00`).getTime();
  const endMs = new Date(`${cycle.end_date}T00:00:00`).getTime();
  const refMs = Math.min(endMs, Math.max(startMs, new Date(`${refDate}T00:00:00`).getTime()));

  const totalCycleDays = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
  const daysElapsed = Math.max(1, Math.round((refMs - startMs) / 86400000) + 1);
  const daysRemaining = Math.max(1, Math.round((endMs - refMs) / 86400000) + 1);

  const disposablePool = effectiveIncome - fixedAndInstallments;
  const remainingBudget = disposablePool - totalSpent;
  const dailySafeBudget = Math.floor(remainingBudget / daysRemaining);
  const idealDailyBudget = Math.max(1, Math.floor(disposablePool / totalCycleDays));

  const avgDailyBurnRate = Math.round(totalSpent / daysElapsed);
  const isTodayOverspent = todaySpent > idealDailyBudget || (remainingBudget < disposablePool * (daysRemaining / totalCycleDays));

  let projectedBrokeDate = null, daysUntilBroke = null, overdraftDays = 0, bankruptcyWarningText = null;
  const effectiveBurnVelocity = Math.max(avgDailyBurnRate, todaySpent);

  if (remainingBudget <= 0) {
    daysUntilBroke = 0;
    projectedBrokeDate = refDate;
    overdraftDays = daysRemaining;
    bankruptcyWarningText = `🚨 緊急破產警報：可用安全預算已透支 $${Math.abs(remainingBudget)} 元！你已透支未來 ${daysRemaining} 天的餐費，接下來每天只能花 $0 元！`;
  } else if (effectiveBurnVelocity > Math.max(1, dailySafeBudget)) {
    daysUntilBroke = Math.max(1, Math.floor(remainingBudget / effectiveBurnVelocity));
    if (daysUntilBroke < daysRemaining) {
      const brokeDt = new Date(refMs + daysUntilBroke * 86400000);
      projectedBrokeDate = `${brokeDt.getMonth() + 1}月${brokeDt.getDate()}號`;
    }
    const excessAmount = Math.max(todaySpent - idealDailyBudget, totalSpent - idealDailyBudget * daysElapsed);
    if (excessAmount > 0) {
      overdraftDays = Math.max(1, Math.ceil(excessAmount / Math.max(1, idealDailyBudget)));
      bankruptcyWarningText = `⚠️ 破產倒數預警：按目前花費速度（日均 $${effectiveBurnVelocity}），將在【${projectedBrokeDate || '發薪日前'}】破產歸零！你已透支未來 ${overdraftDays} 天的餐費，接下來每天只能花 $${Math.max(0, dailySafeBudget)} 元！`;
    }
  }

  return {
    referenceDate: refDate,
    cycle: {
      cycleKey: cycle.cycle_key, startDate: cycle.start_date, endDate: cycle.end_date,
      paydayDay: settings.payday_day, totalCycleDays, daysElapsed, daysRemaining,
      targetShiftMonth: cycle.target_shift_month, shiftGrossPay: cycle.shift_gross_pay,
      normalHours: cycle.normal_hours, otMinutes: cycle.ot_minutes, bonusPay: cycle.bonus_pay,
      hourlyWage: cycle.hourly_wage || settings.default_hourly_wage,
      netPayFactor: settings.net_pay_factor, laborHealthDeduction: settings.labor_health_deduction,
      estimatedNetPay: cycle.estimated_net_pay, actualSalary: cycle.actual_salary,
      isSalarySettled: Boolean(cycle.is_salary_settled), shiftSyncSource: cycle.shift_sync_source,
      lastSyncedAt: cycle.last_synced_at
    },
    budget: {
      effectiveIncome, fixedAndInstallments, disposablePool, totalSpent,
      pendingSpent: Number(spentRow.pending_spent) || 0, settledSpent: Number(spentRow.settled_spent) || 0,
      gapSpent: Number(spentRow.gap_spent) || 0, todaySpent, remainingBudget, dailySafeBudget,
      idealDailyBudget, avgDailyBurnRate, isTodayOverspent, overdraftDays,
      daysUntilBroke, projectedBrokeDate, bankruptcyWarningText
    },
    tier: evaluateSurvivalTier(dailySafeBudget)
  };
}

module.exports = {
  getCycleRangeForDate, ensureCurrentCycle, syncCycleWithShiftData,
  applyActualSalaryDeposit, evaluateSurvivalTier, getSurvivalDashboardMetrics
};

  },
  "esunParser": function(module, exports, require) {
'use strict';

/**
 * 全形字元轉半形字元
 */
function toHalfWidth(str) {
  return String(str || '')
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

/**
 * 2.2 商店名稱正規化（Normalization）
 * 自動剔除 連加*(LINE Pay)、街口*、優食*(UberEats)、綠界* 等第三方支付前綴詞，並統一常見通路同義詞
 */
function normalizeMerchant(rawMerchant) {
  let s = toHalfWidth(rawMerchant || '').trim().toUpperCase();

  // 移除常見第三方支付前綴詞 (支援 *, -, _, 空白或無分隔符)
  const thirdPartyPrefixes = [
    /^連加網路[\*\-\s_]*/,
    /^連加[\*\-\s_]*/,
    /^LINE\s*PAY[\*\-\s_]*/,
    /^街口電支[\*\-\s_]*/,
    /^街口支付[\*\-\s_]*/,
    /^街口[\*\-\s_]*/,
    /^JKOPAY[\*\-\s_]*/,
    /^優食[\*\-\s_]*/,
    /^UBEREATS[\*\-\s_]*/,
    /^UBER\s*EATS[\*\-\s_]*/,
    /^綠界科技[\*\-\s_]*/,
    /^綠界[\*\-\s_]*/,
    /^ECPAY[\*\-\s_]*/,
    /^藍新金流[\*\-\s_]*/,
    /^藍新[\*\-\s_]*/,
    /^NEWEBPAY[\*\-\s_]*/,
    /^全支付[\*\-\s_]*/,
    /^PXPAY[\*\-\s_]*/,
    /^拍付[\*\-\s_]*/,
    /^PI錢包[\*\-\s_]*/,
    /^一卡通[\*\-\s_]*/,
    /^IPASS[\*\-\s_]*/
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const regex of thirdPartyPrefixes) {
      if (regex.test(s)) {
        s = s.replace(regex, '').trim();
        changed = true;
      }
    }
  }

  // 統一超商 / 7-11 / 7-ELEVEN 同義詞標準化
  if (/7[\-\s]*11|7[\-\s]*ELEVEN|統一超商/.test(s)) {
    return '7-ELEVEN';
  }
  if (/全家便利|全家超商|FAMILY\s*MART|FAMILYMART/.test(s)) {
    return '全家便利商店';
  }
  if (/台灣中油|中國石油|中油/.test(s)) {
    return '台灣中油';
  }
  if (/全國加油/.test(s)) {
    return '全國加油站';
  }
  if (/STEAM\s*GAMES|STEAMPOWERED|STEAM/.test(s)) {
    return 'STEAM';
  }
  if (/APPLE\.COM\/BILL|APP\s*STORE|ITUNES/.test(s)) {
    return 'APPLE';
  }
  if (/NETFLIX/.test(s)) {
    return 'NETFLIX';
  }

  // 移除尾端分店編號干擾（保留主要店名關鍵字）
  s = s.replace(/\s+(股份有限公司|有限公司)$/g, '').trim();
  return s || '未知商店';
}

/**
 * 計算兩個正規化店名之間的關鍵字相似度 (0 ~ 1)
 */
function computeMerchantSimilarity(merchantA, merchantB) {
  const a = normalizeMerchant(merchantA);
  const b = normalizeMerchant(merchantB);
  if (!a || !b) return 0;
  if (a === b) return 1.0;
  if (a.includes(b) || b.includes(a)) return 0.9;

  // Bigram 相似度
  const bigrams = str => {
    const set = new Set();
    for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
    return set;
  };
  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const bg of setA) {
    if (setB.has(bg)) intersection++;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

/**
 * 自動推斷消費分類與特殊標記
 */
function classifyTransaction(rawMerchant, normalizedMerchant, amount, rawText) {
  const combined = `${rawMerchant} ${normalizedMerchant} ${rawText || ''}`.toUpperCase();

  const isVerifyAuth = amount === 1 || amount === 2;
  const isGasStation = /中油|加油站|全國加油|台亞|速邁樂|台塑石油/.test(combined);
  const isGasPreAuth = isGasStation && (amount === 1500 || amount === 2250);

  let walletTankType = null;
  if (/自動加值|悠遊卡|EASYCARD|全支付|IPASS\s*MONEY|一卡通MONEY|街口儲值/.test(combined)) {
    walletTankType = 'EASYCARD';
  } else if (/ATM|提款|現金提領|跨行提款|無卡提款/.test(combined)) {
    walletTankType = 'CASH';
  }

  const isForeignTx = /STEAM|NETFLIX|APPLE|SPOTIFY|GOOGLE|YOUTUBE|PLAYSTATION|NINTENDO|AMAZON|AGODA|BOOKING|AIRBNB|國外|海外|外幣|USD|JPY|EUR/.test(combined);

  let category = '一般消費';
  if (isVerifyAuth) category = '綁卡驗證';
  else if (isGasStation) category = '加油交通';
  else if (walletTankType === 'EASYCARD') category = '自動加值/儲值';
  else if (walletTankType === 'CASH') category = 'ATM提款';
  else if (/7-ELEVEN|全家|萊爾富|OK超商|便利商店/.test(combined)) category = '超商小額';
  else if (/五十嵐|清心|迷客夏|可不可|麻古|茶湯會|得正|一沐日|星巴克|路易莎|飲料|咖啡|麥香/.test(combined)) category = '手搖飲品';
  else if (/優食|UBEREATS|FOODPANDA|富胖達|餐廳|美食|小吃|便當|火鍋|燒肉|麥當勞|肯德基|摩斯|壽司/.test(combined)) category = '餐飲外食';
  else if (/STEAM|NETFLIX|SPOTIFY|APPLE|遊戲|娛樂|影城/.test(combined)) category = '數位娛樂';
  else if (/蝦皮|MOMO|PCHOME|淘寶|COUPANG|網購/.test(combined)) category = '網購剁手';

  return {
    category,
    isVerifyAuth,
    isGasStation,
    isGasPreAuth,
    walletTankType,
    isForeignTx
  };
}

function normalizeDateToken(rawDateStr, defaultYear) {
  if (!rawDateStr) return null;
  const s = toHalfWidth(rawDateStr).trim();
  const fullMatch = s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (fullMatch) {
    const [, y, m, d] = fullMatch;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const mdMatch = s.match(/(?:^|\D)(\d{1,2})[\/\-月](\d{1,2})(?:日|\b|$)/);
  if (mdMatch) {
    const y = defaultYear || new Date().getFullYear();
    const [, m, d] = mdMatch;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/**
 * 解析玉山銀行通知文字（支援 Email、Wallet 推播、簡訊、iOS 捷徑文字）
 * 區分：
 *  - CHANNEL_A_AUTH (第 1 次通知：簽帳金融卡消費 / 授權 / 圈存)
 *  - CHANNEL_B_SETTLE (第 2 次通知：帳戶扣款 / 簽帳卡消費扣款 / 請款)
 *  - SALARY_IN (薪資入帳通知)
 *  - REFUND (刷退 / 取消授權 / 解圈退回)
 */
function parseEsunNotification(rawText, options = {}) {
  const cleanText = toHalfWidth(String(rawText || '')).trim();
  if (!cleanText) {
    throw new Error('通知文字不可為空');
  }

  const refDateStr = options.referenceDate || new Date().toISOString().slice(0, 10);
  const defaultYear = Number(refDateStr.slice(0, 4)) || new Date().getFullYear();

  // 1. 判定通道類型 (優先順序：薪資入帳 > 刷退沖銷 > 通道 B 請款扣款 > 通道 A 刷卡授權圈存)
  let channelType = 'CHANNEL_A_AUTH';
  if (/薪資入帳|薪水入帳|薪資轉帳|薪轉入帳|發薪入帳/.test(cleanText)) {
    channelType = 'SALARY_IN';
  } else if (/刷退|退貨|取消授權|解圈退回|沖銷入帳|退單/.test(cleanText)) {
    channelType = 'REFUND';
  } else if (/帳戶扣款|簽帳卡消費扣款|簽帳金融卡請款|商店請款|請款扣款|實際扣款|請款/.test(cleanText)) {
    channelType = 'CHANNEL_B_SETTLE';
  } else if (/簽帳金融卡消費|授權|刷卡|圈存|一般消費|消費通知/.test(cleanText)) {
    channelType = 'CHANNEL_A_AUTH';
  }

  // 2. 擷取金額 (優先匹配 NT$ / TWD / 新台幣 / $ 與「...元」，並以負向後行斷言排除日期的年份 2026/10/20)
  let amount = 0;
  const amountPatterns = [
    /(?:NT\$|TWD|新台幣|臺幣|\$)\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?![0-9]*[\/\-年])/i,
    /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*元/,
    /(?:金額|消費|扣款|入帳|刷退)[：:\s]*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?![0-9]*[\/\-年月])/i
  ];
  for (const pat of amountPatterns) {
    const m = cleanText.match(pat);
    if (m && m[1]) {
      amount = parseInt(m[1].replace(/,/g, ''), 10);
      break;
    }
  }

  // 3. 擷取「原始消費日期（刷卡日）」與「通知/請款當日日期」
  let originalTxDate = null;
  const origDateMatch = cleanText.match(/(?:原始交易日|原交易日|原消費日|原始消費日|刷卡日|消費日期|交易日)[：:\s]*(\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?|\d{1,2}[\/\-月]\d{1,2}日?)/);
  if (origDateMatch) {
    originalTxDate = normalizeDateToken(origDateMatch[1], defaultYear);
  }

  const allDateMatches = [...cleanText.matchAll(/(\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?|\d{1,2}[\/\-月]\d{1,2}日?)/g)];
  let eventDate = refDateStr;
  if (allDateMatches.length > 0) {
    const firstDate = normalizeDateToken(allDateMatches[0][1], defaultYear);
    if (firstDate) eventDate = firstDate;
    if (!originalTxDate && channelType === 'CHANNEL_A_AUTH') {
      originalTxDate = firstDate;
    } else if (!originalTxDate && allDateMatches.length >= 2) {
      // 若請款通知出現兩個日期，通常一個是入帳扣款日、一個是原始刷卡日
      originalTxDate = normalizeDateToken(allDateMatches[1][1], defaultYear);
    }
  }

  // 4. 擷取授權碼 (若有)
  let authCode = null;
  const authMatch = cleanText.match(/(?:授權碼|Auth\s*Code)[：:\s]*([A-Z0-9]{4,8})/i);
  if (authMatch) authCode = authMatch[1].toUpperCase();

  // 5. 擷取原始商店名稱 (優先提取「...」引號內店名，再提取商店標籤或於/在...消費結構)
  let rawMerchant = '未知商店';
  const quoteMatches = [...cleanText.matchAll(/[「『]([^」』]+)[」』]/g)];
  for (const qm of quoteMatches) {
    const candidate = qm[1].trim();
    if (candidate && !/玉山銀行|玉山Wallet|簽帳金融卡|帳戶扣款|薪資入帳/.test(candidate)) {
      rawMerchant = candidate;
      break;
    }
  }

  if (rawMerchant === '未知商店') {
    const merchantPatterns = [
      /(?:商店名稱|特約商店|消費商店|請款商店|請款扣款|商店)[：:\s]*([^」】\n，,。；;（(]+?)(?:\s*(?:消費|刷卡|請款|扣款|授權|刷退|金額|NT\$|TWD|新台幣|\$|\d+元|$))/i,
      /(?:於|在)\s*(?:\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?\s*(?:於|在)?\s*)?([^」】\n，,。；;（(]+?)\s*(?:刷卡|消費|請款|扣款|授權|刷退|金額|NT\$|TWD|新台幣)/i,
      /【([^】]+)】/
    ];
    for (const pat of merchantPatterns) {
      const m = cleanText.match(pat);
      if (m && m[1]) {
        const candidate = m[1].trim();
        if (candidate && !/玉山銀行|玉山Wallet|簽帳金融卡|帳戶扣款|薪資入帳|^\d{4}/.test(candidate)) {
          rawMerchant = candidate;
          break;
        }
      }
    }
  }
  if (rawMerchant === '未知商店' && channelType === 'SALARY_IN') {
    rawMerchant = '玉山薪資轉帳';
  }

  const normalizedMerchant = normalizeMerchant(rawMerchant);
  const classification = classifyTransaction(rawMerchant, normalizedMerchant, amount, cleanText);

  return {
    channelType,
    rawMerchant,
    normalizedMerchant,
    amount,
    txDate: originalTxDate || eventDate,
    originalTxDate, // null 代表通道 B 通知中未明確附帶原始刷卡日
    eventDate,
    authCode,
    ...classification,
    rawText: cleanText
  };
}

module.exports = {
  toHalfWidth,
  normalizeMerchant,
  computeMerchantSimilarity,
  classifyTransaction,
  parseEsunNotification
};


  },
  "reconciliationEngine": function(module, exports, require) {
'use strict';

const { parseEsunNotification, computeMerchantSimilarity, normalizeMerchant } = require('./esunParser');
const { ensureCurrentCycle, applyActualSalaryDeposit } = require('./survivalEngine');

const DEBOUNCE_WINDOW_MS = 3 * 60 * 1000; // 3 分鐘防抖動鎖 (180,000 ms)
const FX_TOLERANCE_RATIO = 0.06;          // 海外匯差與 1.5% 手續費 ±6% 容許誤差

function daysBetween(dateA, dateB) {
  const a = new Date(`${String(dateA).slice(0, 10)}T00:00:00`).getTime();
  const b = new Date(`${String(dateB).slice(0, 10)}T00:00:00`).getTime();
  return Math.round((b - a) / 86400000);
}

function creditWalletTankFromTx(db, tankType, amount, note, txId, nowIso) {
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  if (!tank) return;
  const col = tankType === 'CASH' ? 'cash_balance' : 'easycard_balance';
  const newBalance = (Number(tank[col]) || 0) + Number(amount);

  db.prepare(`UPDATE wallet_tank SET ${col} = ?, updated_at = ? WHERE id = 1`).run(newBalance, nowIso);
  db.prepare(`
    INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tankType, Number(amount), newBalance, note, txId, nowIso);
}

function checkDebounceDuplicate(db, dedupeHash, nowIso) {
  const nowMs = new Date(nowIso).getTime();
  const recentLogs = db.prepare(`
    SELECT id, received_at, linked_tx_id
    FROM notification_logs
    WHERE channel_type = 'CHANNEL_A_AUTH' AND dedupe_hash = ?
    ORDER BY id DESC LIMIT 5
  `).all(dedupeHash);

  for (const log of recentLogs) {
    const diffMs = Math.abs(nowMs - new Date(log.received_at).getTime());
    if (diffMs <= DEBOUNCE_WINDOW_MS) {
      return {
        isDuplicate: true,
        diffSeconds: Math.round(diffMs / 1000),
        originalTxId: log.linked_tx_id
      };
    }
  }
  return { isDuplicate: false };
}

/**
 * 2.2 & 2.3 通道 B 核銷配對演算法 (1-to-1 Lock + 權重配對 + FIFO + ±6% 海外匯差自動修正)
 */
function findBestPendingMatch(db, parsed, referenceDateStr) {
  const refDate = (referenceDateStr || parsed.eventDate || new Date().toISOString().slice(0, 10)).slice(0, 10);

  const candidates = db.prepare(`
    SELECT * FROM transactions
    WHERE status IN ('PENDING', 'TEMP_HOLD') AND is_reconciled_locked = 0
    ORDER BY tx_date ASC, tx_timestamp ASC, id ASC
  `).all().filter(tx => {
    const ageDays = daysBetween(tx.tx_date, refDate);
    return ageDays >= -1 && ageDays <= 30;
  });

  if (candidates.length === 0) return null;

  // 第一階段：金額 100% 相符（或加油站 TEMP_HOLD 預授權轉實扣）
  // 權重：金額相符 (60%) + 原始消費日期相符 (30%) + 商店關鍵字相符 (10%)
  const exactMatches = [];
  for (const tx of candidates) {
    const merchantSim = computeMerchantSimilarity(tx.normalized_merchant, parsed.normalizedMerchant);
    const isGasTempHoldMatch = tx.status === 'TEMP_HOLD' && merchantSim >= 0.6;
    const isExactAmount = tx.auth_amount === parsed.amount;

    if (!isExactAmount && !isGasTempHoldMatch) continue;
    if (merchantSim < 0.35 && tx.auth_code !== parsed.authCode) continue;

    const amountWeight = 60;
    let dateWeight = 15;
    if (parsed.originalTxDate) {
      if (tx.tx_date === parsed.originalTxDate) dateWeight = 30;
      else if (Math.abs(daysBetween(tx.tx_date, parsed.originalTxDate)) <= 1) dateWeight = 15;
      else dateWeight = 0;
    }

    const merchantWeight = Number((merchantSim * 10).toFixed(2));
    const authCodeBonus = (parsed.authCode && tx.auth_code && parsed.authCode === tx.auth_code) ? 5 : 0;
    const totalScore = Number((amountWeight + dateWeight + merchantWeight + authCodeBonus).toFixed(2));

    exactMatches.push({
      tx,
      score: totalScore,
      merchantSim,
      matchType: isGasTempHoldMatch ? 'GAS_PREAUTH_SETTLE' : 'EXACT_FIFO_MATCH',
      fxFeeDiff: 0
    });
  }

  if (exactMatches.length > 0) {
    exactMatches.sort((a, b) => b.score - a.score);
    return exactMatches[0];
  }

  // 第二階段：跨國交易匯差與 1.5% 手續費自動修正 (±6% 容許誤差比對)
  const fxMatches = [];
  for (const tx of candidates) {
    if (tx.status !== 'PENDING' || tx.auth_amount <= 0) continue;
    const merchantSim = computeMerchantSimilarity(tx.normalized_merchant, parsed.normalizedMerchant);
    if (merchantSim < 0.5) continue;

    const diffRatio = Math.abs(parsed.amount - tx.auth_amount) / tx.auth_amount;
    if (diffRatio <= FX_TOLERANCE_RATIO) {
      let dateWeight = 15;
      if (parsed.originalTxDate) {
        if (tx.tx_date === parsed.originalTxDate) dateWeight = 30;
        else if (Math.abs(daysBetween(tx.tx_date, parsed.originalTxDate)) <= 2) dateWeight = 15;
        else continue;
      }
      const amountAccuracyScore = Number(((1 - diffRatio) * 60).toFixed(2));
      const merchantWeight = Number((merchantSim * 10).toFixed(2));
      const totalScore = Number((amountAccuracyScore + dateWeight + merchantWeight).toFixed(2));

      fxMatches.push({
        tx,
        score: totalScore,
        merchantSim,
        matchType: 'FX_TOLERANCE_MATCH',
        fxFeeDiff: parsed.amount - tx.auth_amount,
        diffPercent: Number((diffRatio * 100).toFixed(2))
      });
    }
  }

  if (fxMatches.length > 0) {
    fxMatches.sort((a, b) => b.score - a.score);
    return fxMatches[0];
  }

  return null;
}

function processBankNotification(db, rawText, options = {}) {
  const nowIso = options.timestamp || new Date().toISOString();
  const refDate = (options.referenceDate || nowIso.slice(0, 10)).slice(0, 10);
  const source = options.source || 'manual';

  const parsed = parseEsunNotification(rawText, { referenceDate: refDate });
  const cycle = ensureCurrentCycle(db, parsed.txDate || refDate);
  const dedupeHash = `${parsed.normalizedMerchant}|${parsed.amount}`;

  // 情境 1：玉山薪資入帳通知 -> 自動以真實入帳金額覆蓋當月預估值
  if (parsed.channelType === 'SALARY_IN') {
    const updatedCycle = applyActualSalaryDeposit(db, parsed.amount, refDate);
    const actionMsg = `💰 薪資入帳自動校正：以真實薪資 $${parsed.amount} 覆蓋原預估實領 ($${cycle.estimated_net_pay})`;
    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'SALARY_IN', ?, ?, ?, ?, NULL, ?, ?)
    `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, actionMsg, rawText, nowIso);

    return {
      resultType: 'SALARY_CALIBRATED',
      channelType: 'SALARY_IN',
      message: actionMsg,
      cycle: updatedCycle,
      parsed
    };
  }

  // 情境 2：收到銀行正式「刷退 / 取消授權」通知 -> 沖銷原消費並加回預算（先買後退原則）
  if (parsed.channelType === 'REFUND') {
    const targetTx = db.prepare(`
      SELECT * FROM transactions
      WHERE status IN ('PENDING', 'SETTLED')
        AND (normalized_merchant = ? OR auth_amount = ? OR effective_amount = ?)
      ORDER BY id DESC LIMIT 1
    `).get(parsed.normalizedMerchant, parsed.amount, parsed.amount);

    if (targetTx) {
      const note = `已收到銀行正式刷退通知（沖銷原消費 +$${targetTx.personal_amount} 加回安全預算）`;
      db.prepare(`
        UPDATE transactions SET status = 'CANCELED', personal_amount = 0, reconcile_note = ? WHERE id = ?
      `).run(note, targetTx.id);

      db.prepare(`
        INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
        VALUES (?, 'REFUND', ?, ?, ?, ?, ?, ?, ?)
      `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, note, targetTx.id, rawText, nowIso);

      return {
        resultType: 'REFUND_APPLIED',
        channelType: 'REFUND',
        message: note,
        transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(targetTx.id),
        parsed
      };
    }
  }

  // 情境 3：通道 A（第 1 次通知：簽帳金融卡消費 / 授權圈存）
  if (parsed.channelType === 'CHANNEL_A_AUTH') {
    const debounce = checkDebounceDuplicate(db, dedupeHash, nowIso);
    if (debounce.isDuplicate) {
      const ignoreMsg = `🛡️ 3分鐘防抖動鎖觸發：與 ${debounce.diffSeconds} 秒前之「${parsed.normalizedMerchant} $${parsed.amount}」完全相同，判定為銀行重複推播自動忽略！`;
      db.prepare(`
        INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
        VALUES (?, 'IGNORED_DEBOUNCE', ?, ?, ?, ?, ?, ?, ?)
      `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, ignoreMsg, debounce.originalTxId, rawText, nowIso);

      return {
        resultType: 'DEBOUNCE_IGNORED',
        channelType: 'CHANNEL_A_AUTH',
        message: ignoreMsg,
        originalTxId: debounce.originalTxId,
        parsed
      };
    }

    let status = 'PENDING';
    let personalAmount = parsed.amount;
    let reconcileNote = '圈存中（已立即從當月可用安全預算扣除）';

    if (parsed.isVerifyAuth) {
      status = 'AUTH_VERIFY';
      personalAmount = 0;
      reconcileNote = '卡片綁定驗證（NT$1~2 不計入消費，14天後自動歸檔）';
    } else if (parsed.isGasPreAuth) {
      status = 'TEMP_HOLD';
      personalAmount = 0;
      reconcileNote = '⛽ 加油站大額預授權（暫不扣除全額預算，請手動輸入實際加油金額或等請款通知自動扣款）';
    }

    const insertRes = db.prepare(`
      INSERT INTO transactions (
        cycle_key, status, raw_merchant, normalized_merchant, category,
        auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
        tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
        reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
        channel_a_raw, channel_b_raw, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, NULL, ?, 0, NULL, ?, ?, 0, ?, NULL, ?)
    `).run(
      cycle.cycle_key, status, parsed.rawMerchant, parsed.normalizedMerchant, parsed.category,
      parsed.amount, parsed.amount, personalAmount,
      parsed.txDate, nowIso, parsed.authCode, reconcileNote, parsed.isForeignTx ? 1 : 0,
      rawText, nowIso
    );

    const txId = Number(insertRes.lastInsertRowid);

    if (parsed.walletTankType && status === 'PENDING') {
      creditWalletTankFromTx(
        db,
        parsed.walletTankType,
        parsed.amount,
        `銀行圈存自動轉入水庫：${parsed.normalizedMerchant} +$${parsed.amount}`,
        txId,
        nowIso
      );
    }

    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'CHANNEL_A_AUTH', ?, ?, ?, ?, ?, ?, ?)
    `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, reconcileNote, txId, rawText, nowIso);

    return {
      resultType: status === 'AUTH_VERIFY' ? 'VERIFY_FILTERED' : (status === 'TEMP_HOLD' ? 'GAS_PREAUTH_HOLD' : 'PENDING_CREATED'),
      channelType: 'CHANNEL_A_AUTH',
      message: reconcileNote,
      transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId),
      parsed
    };
  }

  // 情境 4：通道 B（第 2 次通知：商店請款實際扣款）-> 絕對不直接新增消費，啟動 1-to-1 Lock 核銷演算法
  const match = findBestPendingMatch(db, parsed, refDate);
  if (!match) {
    const warnMsg = `⚠️ 收到通道 B 請款通知（${parsed.normalizedMerchant} $${parsed.amount}），但找不到對應未鎖定之 PENDING 圈存紀錄。為防重複扣款已攔截直接新增，請使用「一鍵餘額校正」核對！`;
    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'CHANNEL_B_SETTLE', ?, ?, ?, ?, NULL, ?, ?)
    `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, warnMsg, rawText, nowIso);

    return {
      resultType: 'UNMATCHED_SETTLEMENT',
      channelType: 'CHANNEL_B_SETTLE',
      message: warnMsg,
      parsed
    };
  }

  const matchedTx = match.tx;
  const fxDiff = match.fxFeeDiff || (parsed.amount - matchedTx.auth_amount);

  const splitRecord = db.prepare('SELECT * FROM split_bills WHERE transaction_id = ? ORDER BY id DESC LIMIT 1').get(matchedTx.id);
  let newPersonalAmount = parsed.amount;
  if (splitRecord) {
    newPersonalAmount = Math.max(0, splitRecord.self_amount + fxDiff);
  }

  let reconcileNote = `✅ 通道 B 一對一核銷完成 (配對權重 ${match.score}% · FIFO 鎖定)`;
  if (match.matchType === 'FX_TOLERANCE_MATCH' || fxDiff !== 0) {
    const sign = fxDiff >= 0 ? `+${fxDiff}` : `${fxDiff}`;
    reconcileNote = `🌍 匯差與海外手續費自動修正：原圈存 $${matchedTx.auth_amount} ➔ 實扣 $${parsed.amount}（差額 ${sign} 元已同步微調預算）`;
  } else if (match.matchType === 'GAS_PREAUTH_SETTLE') {
    reconcileNote = `⛽ 加油站預授權 ($${matchedTx.auth_amount}) 正式請款核銷：實際加油扣款 $${parsed.amount} 元`;
  }

  db.prepare(`
    UPDATE transactions
    SET status = 'SETTLED',
        settled_amount = ?,
        fx_fee_diff = ?,
        effective_amount = ?,
        personal_amount = ?,
        settled_at = ?,
        is_reconciled_locked = 1,
        reconcile_score = ?,
        reconcile_note = ?,
        is_foreign_tx = CASE WHEN ? != 0 THEN 1 ELSE is_foreign_tx END,
        channel_b_raw = ?
    WHERE id = ?
  `).run(
    parsed.amount, fxDiff, parsed.amount, newPersonalAmount, nowIso,
    match.score, reconcileNote, fxDiff, rawText, matchedTx.id
  );

  db.prepare(`
    INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
    VALUES (?, 'CHANNEL_B_SETTLE', ?, ?, ?, ?, ?, ?, ?)
  `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, reconcileNote, matchedTx.id, rawText, nowIso);

  return {
    resultType: 'RECONCILED_SETTLED',
    channelType: 'CHANNEL_B_SETTLE',
    matchType: match.matchType,
    reconcileScore: match.score,
    fxFeeDiff: fxDiff,
    message: reconcileNote,
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(matchedTx.id),
    parsed
  };
}

/**
 * 2.4.2 加油站預授權：使用者手動輸入實際加油金額
 */
function resolveGasTempHoldManually(db, txId, actualGasAmount) {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(txId));
  if (!tx) throw new Error('找不到該筆預授權交易');
  const amt = Math.max(0, Math.round(Number(actualGasAmount) || 0));
  const note = `⛽ 手動輸入實際加油金額 $${amt}（原預授權圈存 $${tx.auth_amount}，仍等待通道 B 最終請款）`;

  db.prepare(`
    UPDATE transactions
    SET status = 'PENDING',
        effective_amount = ?,
        personal_amount = ?,
        reconcile_note = ?
    WHERE id = ?
  `).run(amt, amt, note, tx.id);

  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
}

/**
 * 2.4.3 手動將某筆 PENDING 標記為 CANCELED（已退單待解圈），移入「凍結觀察區」
 */
function markTransactionCanceled(db, txId, reason = '取消訂單/待玉山解圈退回') {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(txId));
  if (!tx) throw new Error('找不到該筆交易');
  const note = `❄️ 凍結觀察區（已退單待解圈）：${reason}｜提醒：帳戶餘額 $${tx.auth_amount} 仍被玉山凍結，預計 7~30 天後退回`;

  db.prepare(`
    UPDATE transactions
    SET status = 'CANCELED',
        personal_amount = 0,
        reconcile_note = ?
    WHERE id = ?
  `).run(note, tx.id);

  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
}

/**
 * 2.4.3 14 天幽靈圈存（取消訂單/刷退）雷達
 */
function scanGhostHolds(db, referenceDateStr) {
  const refDate = (referenceDateStr || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const pendings = db.prepare(`
    SELECT * FROM transactions
    WHERE status = 'PENDING' AND is_reconciled_locked = 0
    ORDER BY tx_date ASC, id ASC
  `).all();

  const ghostAlerts = [];
  for (const tx of pendings) {
    const ageDays = daysBetween(tx.tx_date, refDate);
    if (ageDays >= 14) {
      if (!tx.is_ghost_alerted) {
        db.prepare('UPDATE transactions SET is_ghost_alerted = 1 WHERE id = ?').run(tx.id);
      }
      ghostAlerts.push({
        transactionId: tx.id,
        merchant: tx.normalized_merchant,
        amount: tx.auth_amount,
        txDate: tx.tx_date,
        ageDays,
        alertText: `🚨 幽靈圈存警報：有筆 $${tx.auth_amount}（${tx.normalized_merchant}，刷卡日 ${tx.tx_date}）已逾 ${ageDays} 天未請款，若已取消訂單請去玉山 Wallet 確認圈存是否已解凍退回！`
      });
    }
  }

  return ghostAlerts;
}

module.exports = {
  findBestPendingMatch,
  processBankNotification,
  resolveGasTempHoldManually,
  markTransactionCanceled,
  scanGhostHolds
};


  },
  "impulseControlService": function(module, exports, require) {
'use strict';

const { getSurvivalDashboardMetrics, evaluateSurvivalTier } = require('./survivalEngine');

/**
 * 3.3 偵測「深夜 (23:00~05:00) 與發薪日後 72 小時內」高風險防禦模式
 */
function getHighRiskModeStatus(db, referenceNowIso) {
  const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
  const now = referenceNowIso ? new Date(referenceNowIso) : new Date();
  const hour = now.getHours();
  const localDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const isLateNight = hour >= 23 || hour < 5;
  const metrics = getSurvivalDashboardMetrics(db, localDateStr);
  const isPostPayday72h = metrics.cycle.daysElapsed >= 1 && metrics.cycle.daysElapsed <= 3;
  const isForced = Boolean(settings.force_high_risk_mode);

  const isHighRisk = isLateNight || isPostPayday72h || isForced;
  const reasons = [];
  if (isLateNight) reasons.push(`深夜腦波弱時段 (${String(hour).padStart(2, '0')}:00，23:00~05:00 嚴格管制)`);
  if (isPostPayday72h) reasons.push(`發薪日後 72 小時暴富錯覺期 (週期第 ${metrics.cycle.daysElapsed} 天)`);
  if (isForced && !isLateNight && !isPostPayday72h) reasons.push('手動開啟高風險防禦演習模式');

  return {
    isHighRisk,
    isLateNight,
    isPostPayday72h,
    isForced,
    strictnessLevel: isHighRisk ? 'EXTREME' : 'STANDARD',
    reasons,
    warningBanner: isHighRisk
      ? `🚨【高風險防禦模式啟動中】目前處於「${reasons.join(' ＋ ')}」！此時段衝動網購後悔率極高，系統已將勸退標準調至最嚴格！`
      : null
  };
}

function generateSoulRoast({ itemName, amount, reason, itemType, hours, minutes, tierBefore, tierAfter, dailyAfter, isHighRisk }) {
  const r = String(reason || '').trim();
  const rebuttals = [];

  if (isHighRisk) {
    rebuttals.push('🛑 先把手機放下！現在是腦波最弱的高風險警戒時段，你以為的「心動」只是多巴胺在騙你的錢包！');
  }

  if (/特價|打折|優惠|限時|買一送一|免運|湊/.test(r)) {
    rebuttals.push(`🔥 經典商家陷阱！「因為${r}而買」不是省錢，是原本不用花 $0，現在卻要倒貼 $${amount}！為了湊免運或折扣多花的錢都是智商稅！`);
  } else if (/心情|壓力|犒賞|累|難過|生氣|獎勵/.test(r)) {
    rebuttals.push(`💔 情緒性消費警報！花 $${amount} 買「${itemName}」只能爽 15 分鐘，但月底看著帳戶餘額歸零、每天只剩 $${Math.max(0, dailyAfter)} 吃土時，你的心情會比現在痛苦十倍！`);
  } else if (/好看|可愛|帥|酷|喜歡|想買|新品|限量/.test(r)) {
    rebuttals.push(`🧊 外表好看不能當飯吃！家裡角落是不是已經堆了 3 個當初也覺得「超好看、非買不可」結果現在長灰塵的東西？`);
  } else if (itemType === 'NEED') {
    rebuttals.push(`🧐 你確定「${itemName}」真的是生存必需品 (Need)，還是被你包裝成需要的「想要 (Want)」？如果是今天不買明天就無法上班上課才叫需要！`);
  } else {
    rebuttals.push(`💀 靈魂拷問：買「${itemName}」的理由寫著「${r || '沒寫理由'}」，連你自己都說服不了自己對吧？`);
  }

  rebuttals.push(
    `⏱️ 血汗真相：這筆 $${amount} 等於你要在班表上辛苦多站【${hours} 小時 ${minutes} 分鐘】（相當於多上 ${(hours / 4).toFixed(1)} 個四小時晚班）！想像一下站到腳痠的時候，真的甘願把這筆血汗錢換成它嗎？`
  );

  if (tierAfter.code !== tierBefore.code || dailyAfter < 250) {
    rebuttals.push(
      `📉 生存衝擊：刷下去的瞬間，你本週期剩下的日子每天只剩 $${Math.max(0, dailyAfter)} 能活，生存狀態直接落入【${tierAfter.emoji} ${tierAfter.label}】！`
    );
  }

  return rebuttals.join('\n\n');
}

function evaluateImpulsePurchase(db, payload, options = {}) {
  const itemName = String(payload.itemName || '').trim();
  const amount = Math.max(1, Math.round(Number(payload.amount) || 0));
  const reason = String(payload.reason || '').trim();
  const itemType = String(payload.itemType || 'WANT').toUpperCase() === 'NEED' ? 'NEED' : 'WANT';
  const addToCart = payload.addToCart !== false;

  if (!itemName) throw new Error('請輸入想購買的商品名稱');

  const nowIso = options.nowIso || new Date().toISOString();
  const refDate = nowIso.slice(0, 10);
  const metrics = getSurvivalDashboardMetrics(db, refDate);
  const highRisk = getHighRiskModeStatus(db, nowIso);

  const hourlyWage = Math.max(1, Number(metrics.cycle.hourlyWage) || 200);
  const workHoursFloat = amount / hourlyWage;
  const hours = Math.floor(workHoursFloat);
  const minutes = Math.round((workHoursFloat - hours) * 60);
  const workTimeText = `${hours} 小時 ${minutes} 分鐘`;

  const dailyBefore = metrics.budget.dailySafeBudget;
  const remainingAfter = metrics.budget.remainingBudget - amount;
  const dailyAfter = Math.floor(remainingAfter / metrics.cycle.daysRemaining);
  const tierBefore = metrics.tier;
  const tierAfter = evaluateSurvivalTier(dailyAfter);

  const aiRoastMessage = generateSoulRoast({
    itemName, amount, reason, itemType,
    hours, minutes, tierBefore, tierAfter,
    dailyAfter, isHighRisk: highRisk.isHighRisk
  });

  const canBuyImmediately = itemType === 'NEED' && !highRisk.isHighRisk && dailyAfter >= 150;
  let cooldownRecord = null;

  if (addToCart && (itemType === 'WANT' || !canBuyImmediately)) {
    const unlockDt = new Date(new Date(nowIso).getTime() + 72 * 3600 * 1000);
    const unlockIso = unlockDt.toISOString();
    const res = db.prepare(`
      INSERT INTO cooldown_cart (
        item_name, amount, reason, item_type,
        work_hours_equivalent, work_time_text,
        daily_budget_before, daily_budget_after,
        tier_before, tier_after, ai_roast_message,
        created_at, unlock_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COOLING')
    `).run(
      itemName, amount, reason, itemType,
      Number(workHoursFloat.toFixed(2)), workTimeText,
      dailyBefore, dailyAfter,
      `${tierBefore.emoji} ${tierBefore.label}`, `${tierAfter.emoji} ${tierAfter.label}`,
      aiRoastMessage, nowIso, unlockIso
    );
    cooldownRecord = db.prepare('SELECT * FROM cooldown_cart WHERE id = ?').get(Number(res.lastInsertRowid));
  }

  return {
    itemName, amount, reason, itemType, hourlyWage,
    sweatWork: {
      hours, minutes, totalHours: Number(workHoursFloat.toFixed(2)),
      text: `買這個東西，等於你要在班表上多站 ${hours} 小時 ${minutes} 分鐘才能換到！`
    },
    survivalImpact: {
      daysRemaining: metrics.cycle.daysRemaining,
      dailyBudgetBefore: dailyBefore, dailyBudgetAfter: dailyAfter,
      tierBefore, tierAfter,
      text: `買下去後，你這個月剩下的 ${metrics.cycle.daysRemaining} 天每天只剩 $${dailyAfter} 可以活（${tierBefore.emoji}${tierBefore.label} ➔ ${tierAfter.emoji}${tierAfter.label}）`
    },
    highRiskMode: highRisk,
    aiRoastMessage,
    canBuyImmediately,
    lockedIn72hPool: Boolean(cooldownRecord),
    cooldownRecord
  };
}

function getCooldownCartSummary(db, referenceNowIso) {
  const nowIso = referenceNowIso || new Date().toISOString();
  const nowMs = new Date(nowIso).getTime();

  const items = db.prepare('SELECT * FROM cooldown_cart ORDER BY id DESC').all();
  for (const item of items) {
    if (item.status === 'COOLING' && new Date(item.unlock_at).getTime() <= nowMs) {
      db.prepare("UPDATE cooldown_cart SET status = 'UNLOCKED' WHERE id = ?").run(item.id);
      item.status = 'UNLOCKED';
    }
    const diffMs = Math.max(0, new Date(item.unlock_at).getTime() - nowMs);
    item.remainingHours = Number((diffMs / 3600000).toFixed(1));
    item.unlockPrompt = item.status === 'UNLOCKED'
      ? '🔓 已經過了 3 天（72 小時），你現在還非買不可嗎？點選「放棄購買」可將這筆錢計入防剁手成就榜！'
      : null;
  }

  const abandonedItems = items.filter(i => i.status === 'ABANDONED');
  const totalSavedAmount = abandonedItems.reduce((sum, i) => sum + Number(i.amount || 0), 0);
  const totalSavedHours = Number(abandonedItems.reduce((sum, i) => sum + Number(i.work_hours_equivalent || 0), 0).toFixed(1));

  return {
    activeItems: items.filter(i => i.status === 'COOLING' || i.status === 'UNLOCKED'),
    abandonedItems,
    purchasedItems: items.filter(i => i.status === 'PURCHASED'),
    achievement: {
      totalSavedAmount,
      totalSavedHours,
      abandonedCount: abandonedItems.length,
      badgeTitle: totalSavedAmount >= 5000 ? '🏆 鋼鐵防剁手宗師' : (totalSavedAmount >= 1500 ? '🛡️ 理智守財達人' : '🌱 防衝動覺醒者')
    }
  };
}

function fastForwardCooldownItem(db, itemId) {
  const pastIso = new Date(Date.now() - 1000).toISOString();
  db.prepare("UPDATE cooldown_cart SET unlock_at = ?, status = 'UNLOCKED' WHERE id = ?").run(pastIso, Number(itemId));
  return db.prepare('SELECT * FROM cooldown_cart WHERE id = ?').get(Number(itemId));
}

function resolveCooldownItem(db, itemId, decision) {
  const item = db.prepare('SELECT * FROM cooldown_cart WHERE id = ?').get(Number(itemId));
  if (!item) throw new Error('找不到該筆冷靜池商品');

  const nowIso = new Date().toISOString();
  const status = String(decision).toUpperCase() === 'PURCHASE' ? 'PURCHASED' : 'ABANDONED';
  db.prepare('UPDATE cooldown_cart SET status = ?, resolved_at = ? WHERE id = ?').run(status, nowIso, item.id);

  return {
    resolvedItem: db.prepare('SELECT * FROM cooldown_cart WHERE id = ?').get(item.id),
    summary: getCooldownCartSummary(db, nowIso)
  };
}
function getVampireAndSubscriptionRadar(db, referenceDateStr) {
  const refDate = (referenceDateStr || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const refMs = new Date(`${refDate}T00:00:00`).getTime();
  const sevenDaysAgoStr = new Date(refMs - 6 * 86400000).toISOString().slice(0, 10);

  const smallTxs = db.prepare(`
    SELECT * FROM transactions
    WHERE status IN ('PENDING', 'SETTLED')
      AND effective_amount > 0 AND effective_amount < 200
      AND tx_date >= ? AND tx_date <= ?
    ORDER BY tx_date DESC, id DESC
  `).all(sevenDaysAgoStr, refDate);

  const byGroup = new Map();
  for (const tx of smallTxs) {
    const key = tx.normalized_merchant || tx.category;
    if (!byGroup.has(key)) {
      byGroup.set(key, { name: key, category: tx.category, count: 0, totalAmount: 0, items: [] });
    }
    const g = byGroup.get(key);
    g.count += 1;
    g.totalAmount += Number(tx.effective_amount);
    g.items.push({ id: tx.id, date: tx.tx_date, amount: tx.effective_amount, rawMerchant: tx.raw_merchant });
  }

  const leaderboard = [...byGroup.values()]
    .map(g => ({ ...g, isVampireAlert: g.count > 4, isWarning: g.count >= 3 }))
    .sort((a, b) => b.count - a.count || b.totalAmount - a.totalAmount);

  const totalSmallCount = smallTxs.length;
  const totalSmallAmount = smallTxs.reduce((s, t) => s + Number(t.effective_amount), 0);

  const fixedList = db.prepare('SELECT * FROM fixed_expenses WHERE is_active = 1 ORDER BY billing_day ASC').all();
  const currentDay = Number(refDate.slice(8, 10));
  const metrics = getSurvivalDashboardMetrics(db, refDate);
  const estNetPay = Math.max(1, metrics.cycle.estimatedNetPay || 19000);

  const subscriptionAlerts = [];
  for (const exp of fixedList) {
    let diffDays = exp.billing_day - currentDay;
    if (diffDays < 0) diffDays += 30;
    exp.daysUntilBilling = diffDays;
    exp.preBillingAlert = (exp.expense_type === 'SUBSCRIPTION' && diffDays <= 3);
    if (exp.preBillingAlert) {
      subscriptionAlerts.push(
        `🔔 訂閱守門員提醒：【${exp.name} ($${exp.monthly_amount}/月)】將在 ${diffDays === 0 ? '今天' : diffDays + ' 天後'}（每月 ${exp.billing_day} 號）扣款，請考慮是否取消訂閱！`
      );
    }
  }

  const futureMonths = [1, 2, 3].map(offset => {
    const dt = new Date(refMs);
    dt.setMonth(dt.getMonth() + offset);
    const ym = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    let installmentAmt = 0, fixedSubAmt = 0;
    for (const exp of fixedList) {
      if (exp.expense_type === 'INSTALLMENT') {
        if ((exp.remaining_installments || 0) >= offset) installmentAmt += Number(exp.monthly_amount);
      } else {
        fixedSubAmt += Number(exp.monthly_amount);
      }
    }
    const lockedTotal = installmentAmt + fixedSubAmt;
    const preemptedPercent = Number(((lockedTotal / estNetPay) * 100).toFixed(1));
    return {
      monthOffset: offset, yearMonth: ym, estimatedNetSalary: estNetPay,
      installmentAmount: installmentAmt, fixedAndSubAmount: fixedSubAmt,
      totalLockedAmount: lockedTotal, freeDisposableAmount: Math.max(0, estNetPay - lockedTotal),
      preemptedPercent,
      warningText: `${ym} 月份還沒開始，你的薪水已經被預支了 ${preemptedPercent}%（分期 $${installmentAmt} ＋ 固定/訂閱 $${fixedSubAmt}）！`
    };
  });

  return {
    vampireRadar: {
      windowStart: sevenDaysAgoStr, windowEnd: refDate,
      totalSmallTxCount: totalSmallCount, totalSmallTxAmount: totalSmallAmount,
      isOverallVampireTriggered: totalSmallCount > 4,
      overallAlertText: totalSmallCount > 4
        ? `🧛 隱形吸血鬼警報：過去 7 天內你有高達 ${totalSmallCount} 筆低於 $200 的小額消費，不知不覺失血了 $${totalSmallAmount} 元！`
        : null,
      leaderboard
    },
    subscriptionsAndInstallments: { items: fixedList, subscriptionAlerts, futureMonths }
  };
}

module.exports = {
  getHighRiskModeStatus, evaluateImpulsePurchase, getCooldownCartSummary,
  fastForwardCooldownItem, resolveCooldownItem, getVampireAndSubscriptionRadar
};



  },
  "accountingPatchService": function(module, exports, require) {
'use strict';

const { ensureCurrentCycle, getSurvivalDashboardMetrics } = require('./survivalEngine');

/**
 * 4.1 朋友聚餐「一鍵拆帳 / 代墊沖銷」
 * 例如刷卡 $2,000，設定「自己僅負擔 $500」，系統只扣個人預算 $500；
 * 剩下的 $1,500 移入「應收代墊款池（不扣個人預算）」，並可記錄欠款人名單，收到轉帳後勾選結清。
 */
function splitTransactionBill(db, { transactionId, selfAmount, debtorName }) {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(transactionId));
  if (!tx) throw new Error('找不到該筆消費紀錄');

  const totalAmount = Number(tx.effective_amount) || Number(tx.auth_amount) || 0;
  const selfAmt = Math.max(0, Math.min(totalAmount, Math.round(Number(selfAmount) || 0)));
  const receivableAmount = Math.max(0, totalAmount - selfAmt);
  const debtor = String(debtorName || '朋友代墊').trim() || '朋友代墊';
  const nowIso = new Date().toISOString();

  // 更新原交易的個人實際負擔金額 personal_amount
  const note = `🤝 聚餐拆帳：刷卡總額 $${totalAmount}（自己負擔 $${selfAmt}，代墊應收 $${receivableAmount} 對象：${debtor}）`;
  db.prepare(`
    UPDATE transactions
    SET personal_amount = ?, reconcile_note = ?
    WHERE id = ?
  `).run(selfAmt, note, tx.id);

  // 檢查是否已有拆帳紀錄，若有則更新，若無則新增
  const existing = db.prepare('SELECT id FROM split_bills WHERE transaction_id = ?').get(tx.id);
  let splitId;
  if (existing) {
    db.prepare(`
      UPDATE split_bills
      SET total_amount = ?, self_amount = ?, receivable_amount = ?, debtor_name = ?, is_repaid = 0, repaid_at = NULL
      WHERE id = ?
    `).run(totalAmount, selfAmt, receivableAmount, debtor, existing.id);
    splitId = existing.id;
  } else {
    const res = db.prepare(`
      INSERT INTO split_bills (transaction_id, total_amount, self_amount, receivable_amount, debtor_name, is_repaid, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(tx.id, totalAmount, selfAmt, receivableAmount, debtor, nowIso);
    splitId = Number(res.lastInsertRowid);
  }

  return {
    splitBill: db.prepare('SELECT * FROM split_bills WHERE id = ?').get(splitId),
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id)
  };
}

function settleSplitBill(db, splitBillId) {
  const record = db.prepare('SELECT * FROM split_bills WHERE id = ?').get(Number(splitBillId));
  if (!record) throw new Error('找不到該筆應收代墊紀錄');

  const nowIso = new Date().toISOString();
  db.prepare('UPDATE split_bills SET is_repaid = 1, repaid_at = ? WHERE id = ?').run(nowIso, record.id);
  return db.prepare('SELECT * FROM split_bills WHERE id = ?').get(record.id);
}

function getSplitBillsSummary(db) {
  const rows = db.prepare(`
    SELECT s.*, t.normalized_merchant, t.tx_date, t.status AS tx_status
    FROM split_bills s
    LEFT JOIN transactions t ON t.id = s.transaction_id
    ORDER BY s.is_repaid ASC, s.id DESC
  `).all();

  const pendingReceivableTotal = rows
    .filter(r => !r.is_repaid)
    .reduce((sum, r) => sum + Number(r.receivable_amount || 0), 0);

  return {
    pendingReceivableTotal,
    unpaidCount: rows.filter(r => !r.is_repaid).length,
    items: rows
  };
}

function getWalletTankStatus(db, referenceNowIso) {
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  const logs = db.prepare('SELECT * FROM wallet_tank_logs ORDER BY id DESC LIMIT 20').all();

  const nowMs = referenceNowIso ? new Date(referenceNowIso).getTime() : Date.now();
  const lastAuditMs = new Date(tank.last_audit_at).getTime();
  const daysSinceAudit = Number(((nowMs - lastAuditMs) / 86400000).toFixed(1));
  const needsAuditAlert = daysSinceAudit >= 3;

  return {
    easycardBalance: Number(tank.easycard_balance) || 0,
    cashBalance: Number(tank.cash_balance) || 0,
    totalTankBalance: (Number(tank.easycard_balance) || 0) + (Number(tank.cash_balance) || 0),
    lastAuditAt: tank.last_audit_at,
    daysSinceAudit,
    needsAuditAlert,
    auditAlertText: needsAuditAlert
      ? `⏳ 水庫盤點提醒：距離上次盤點已過 ${daysSinceAudit} 天（滿 3 天），請清點皮包現金與悠遊卡餘額，消滅不知去向的銅板黑洞！`
      : null,
    logs
  };
}

function quickAdjustWalletTank(db, { tankType = 'CASH', deltaAmount = -50, note = '快速扣水庫銅板消費' }) {
  const type = String(tankType).toUpperCase() === 'EASYCARD' ? 'EASYCARD' : 'CASH';
  const col = type === 'EASYCARD' ? 'easycard_balance' : 'cash_balance';
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  const delta = Math.round(Number(deltaAmount) || 0);
  const newBalance = Math.max(0, (Number(tank[col]) || 0) + delta);
  const nowIso = new Date().toISOString();

  db.prepare(`UPDATE wallet_tank SET ${col} = ?, updated_at = ? WHERE id = 1`).run(newBalance, nowIso);
  db.prepare(`
    INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(type, delta, newBalance, String(note || '水庫變動'), nowIso);

  return getWalletTankStatus(db, nowIso);
}

function auditWalletTank(db, { easycardBalance, cashBalance }) {
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  const nowIso = new Date().toISOString();
  const newEasy = easycardBalance !== undefined ? Math.max(0, Math.round(Number(easycardBalance))) : tank.easycard_balance;
  const newCash = cashBalance !== undefined ? Math.max(0, Math.round(Number(cashBalance))) : tank.cash_balance;

  const diffEasy = newEasy - tank.easycard_balance;
  const diffCash = newCash - tank.cash_balance;

  db.prepare(`
    UPDATE wallet_tank SET easycard_balance = ?, cash_balance = ?, last_audit_at = ?, updated_at = ? WHERE id = 1
  `).run(newEasy, newCash, nowIso, nowIso);

  if (diffEasy !== 0) {
    db.prepare(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
      VALUES ('EASYCARD', ?, ?, '3天定期盤點手動校正', NULL, ?)
    `).run(diffEasy, newEasy, nowIso);
  }
  if (diffCash !== 0) {
    db.prepare(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
      VALUES ('CASH', ?, ?, '3天定期盤點手動校正', NULL, ?)
    `).run(diffCash, newCash, nowIso);
  }

  return getWalletTankStatus(db, nowIso);
}
function syncEsunAvailableBalance(db, { actualEsunBalance, referenceDateStr }) {
  const actual = Math.round(Number(actualEsunBalance));
  if (!Number.isFinite(actual) || actual < 0) {
    throw new Error('請輸入有效的玉山 Wallet 可用餘額數字');
  }

  const nowIso = new Date().toISOString();
  const refDate = (referenceDateStr || nowIso.slice(0, 10)).slice(0, 10);
  const metrics = getSurvivalDashboardMetrics(db, refDate);
  const systemExpected = Number(metrics.budget.remainingBudget);
  const discrepancy = actual - systemExpected;

  let generatedGapTx = null;
  let message = `✅ 餘額完全吻合（$${actual}），無任何漏帳黑洞！`;

  if (discrepancy < 0) {
    const missingAmount = Math.abs(discrepancy);
    const note = `🕳️ 玉山可用餘額一鍵校正自動生成：系統推算 $${systemExpected} vs 玉山真實餘額 $${actual}，少掉 $${missingAmount} 元已立即扣減安全額度，事後可拆分補齊明細！`;

    const res = db.prepare(`
      INSERT INTO transactions (
        cycle_key, status, raw_merchant, normalized_merchant, category,
        auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
        tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
        reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
        channel_a_raw, channel_b_raw, created_at
      ) VALUES (?, 'UNKNOWN_GAP', ?, ?, '未知黑洞', ?, ?, 0, ?, ?, ?, ?, ?, NULL, 1, 100, ?, 0, 0, ?, NULL, ?)
    `).run(
      metrics.cycle.cycleKey,
      `$${missingAmount} 未知漏帳（待查黑洞）`,
      '未知漏帳（待查黑洞）',
      missingAmount, missingAmount, missingAmount, missingAmount,
      refDate, nowIso, nowIso, note, note, nowIso
    );

    const gapTxId = Number(res.lastInsertRowid);
    generatedGapTx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(gapTxId);
    message = `🚨 偵測到帳目落差：玉山真實餘額比系統推算少了 $${missingAmount} 元！已自動生成一筆【$${missingAmount} 未知漏帳（待查黑洞）】立即扣減安全額度，確保月底絕不意外破產！`;
  } else if (discrepancy > 0) {
    message = `💡 玉山真實餘額 ($${actual}) 比系統推算安全預算 ($${systemExpected}) 多出 +$${discrepancy} 元。`;
  }

  db.prepare('UPDATE user_settings SET last_known_bank_balance = ?, updated_at = ? WHERE id = 1').run(actual, nowIso);
  db.prepare(`
    INSERT INTO balance_sync_logs (system_expected_balance, actual_esun_balance, discrepancy_amount, generated_gap_tx_id, note, synced_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(systemExpected, actual, discrepancy, generatedGapTx ? generatedGapTx.id : null, message, nowIso);

  return {
    systemExpectedBalance: systemExpected,
    actualEsunBalance: actual,
    discrepancyAmount: discrepancy,
    generatedGapTransaction: generatedGapTx,
    message,
    updatedMetrics: getSurvivalDashboardMetrics(db, refDate)
  };
}

function splitUnknownGapTransaction(db, gapTxId, items = []) {
  const gapTx = db.prepare("SELECT * FROM transactions WHERE id = ? AND status = 'UNKNOWN_GAP'").get(Number(gapTxId));
  if (!gapTx) throw new Error('找不到該筆未知漏帳黑洞紀錄');
  if (!Array.isArray(items) || items.length === 0) throw new Error('請提供至少一筆補齊明細');

  const nowIso = new Date().toISOString();
  let resolvedSum = 0;
  const createdTxs = [];

  for (const item of items) {
    const amt = Math.max(1, Math.round(Number(item.amount) || 0));
    const merchant = String(item.merchant || '補登消費').trim();
    const category = String(item.category || '一般消費').trim();
    resolvedSum += amt;

    const res = db.prepare(`
      INSERT INTO transactions (
        cycle_key, status, raw_merchant, normalized_merchant, category,
        auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
        tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
        reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
        channel_a_raw, channel_b_raw, created_at
      ) VALUES (?, 'SETTLED', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, 1, 100, ?, 0, 0, '黑洞拆分補齊', NULL, ?)
    `).run(
      gapTx.cycle_key, merchant, merchant, category,
      amt, amt, amt, amt, gapTx.tx_date, nowIso, nowIso,
      `✨ 由未知漏帳黑洞 (#${gapTx.id}) 拆分補齊明細`, nowIso
    );
    createdTxs.push(db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(res.lastInsertRowid)));
  }

  const remainingGap = Math.max(0, gapTx.personal_amount - resolvedSum);
  if (remainingGap === 0) {
    db.prepare("UPDATE transactions SET status = 'CANCELED', personal_amount = 0, reconcile_note = '✅ 未知黑洞已全數拆分補齊完畢' WHERE id = ?").run(gapTx.id);
  } else {
    db.prepare(`
      UPDATE transactions
      SET raw_merchant = ?, auth_amount = ?, effective_amount = ?, personal_amount = ?, reconcile_note = ?
      WHERE id = ?
    `).run(`$${remainingGap} 未知漏帳（待查黑洞）`, remainingGap, remainingGap, remainingGap, `尚餘 $${remainingGap} 待查黑洞（已拆分 $${resolvedSum}）`, gapTx.id);
  }

  return { remainingGap, createdTransactions: createdTxs };
}

module.exports = {
  splitTransactionBill, settleSplitBill, getSplitBillsSummary,
  getWalletTankStatus, quickAdjustWalletTank, auditWalletTank,
  syncEsunAvailableBalance, splitUnknownGapTransaction
};



  },
  "gmailImapService": function(module, exports, require) {
'use strict';

let tls = null;
try {
  tls = require('node:tls');
} catch (_) {}
const { processBankNotification } = require('./reconciliationEngine');

/**
 * 輕量級原生 TLS IMAP 玉山通知信讀取模組 (免外部套件依賴)
 * 亦支援接收 Gmail Apps Script / iOS 捷徑 Webhook 直接轉發
 */
async function pollEsunEmailsViaImap(db) {
  const settings = db.prepare('SELECT gmail_user, gmail_app_password FROM user_settings WHERE id = 1').get();
  if (!settings || !settings.gmail_user || !settings.gmail_app_password) {
    return {
      ok: false,
      mode: 'NOT_CONFIGURED',
      message: '尚未設定 Gmail 帳號與應用程式密碼（App Password）。您可於設定分頁填入，或直接使用 iOS 捷徑 Webhook / 介面手動貼上測試框。'
    };
  }

  if (!tls || typeof tls.connect !== 'function') {
    return {
      ok: true,
      mode: 'CLOUD_WEBHOOK_READY',
      message: '☁️ 目前運行於 Cloudflare 雲端環境，已儲存您的 Gmail 設定！雲端模式建議搭配上方 HTTPS Webhook 網址由 iOS 捷徑或 Google Apps Script 即時轉發玉山通知信。'
    };
  }

  return new Promise(resolve => {
    try {
      const socket = tls.connect({ host: 'imap.gmail.com', port: 993, rejectUnauthorized: true });
      let buffer = '';
      let step = 0;

      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({ ok: false, mode: 'TIMEOUT', message: 'Gmail IMAP 連線逾時，請確認網路與應用程式密碼。' });
      }, 8000);

      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (step === 0 && buffer.includes('OK')) {
          step = 1;
          buffer = '';
          socket.write(`A1 LOGIN "${settings.gmail_user}" "${settings.gmail_app_password}"\r\n`);
        } else if (step === 1 && buffer.includes('A1 ')) {
          clearTimeout(timeout);
          const success = buffer.includes('A1 OK');
          socket.write('A2 LOGOUT\r\n');
          socket.end();
          resolve({
            ok: success,
            mode: 'IMAP_CONNECTED',
            message: success ? '✅ 成功透過 IMAP 驗證 Gmail 信箱並檢查玉山銀行通知信！' : '❌ Gmail IMAP 登入失敗，請確認已開啟兩步驟驗證並使用 16 碼應用程式密碼。'
          });
        }
      });

      socket.on('error', err => {
        clearTimeout(timeout);
        resolve({
          ok: true,
          mode: 'CLOUD_WEBHOOK_READY',
          message: `☁️ 雲端環境不直接開放 TCP 993 埠 (${err.message})，已儲存帳號設定，請使用此頁顯示的 HTTPS Webhook 網址搭配 iOS 捷徑或 Gmail 自動轉發！`
        });
      });
    } catch (err) {
      resolve({
        ok: true,
        mode: 'CLOUD_WEBHOOK_READY',
        message: '☁️ 目前運行於 Cloudflare 雲端環境，請使用上方 HTTPS Webhook 網址搭配 iOS 捷徑即時推送玉山通知！'
      });
    }
  });
}

module.exports = {
  pollEsunEmailsViaImap
};

  },
  "api": function(module, exports, require) {
'use strict';

const { getDb } = require('../db/database');
const { getSurvivalDashboardMetrics, syncCycleWithShiftData } = require('../services/survivalEngine');
const { processBankNotification, resolveGasTempHoldManually, markTransactionCanceled, scanGhostHolds } = require('../services/reconciliationEngine');
const { getHighRiskModeStatus, evaluateImpulsePurchase, getCooldownCartSummary, fastForwardCooldownItem, resolveCooldownItem, getVampireAndSubscriptionRadar } = require('../services/impulseControlService');
const { splitTransactionBill, settleSplitBill, getSplitBillsSummary, getWalletTankStatus, quickAdjustWalletTank, auditWalletTank, syncEsunAvailableBalance, splitUnknownGapTransaction } = require('../services/accountingPatchService');
const { pollEsunEmailsViaImap } = require('../services/gmailImapService');

/**
 * 首次啟動時若交易表為空，寫入貼近真實生活的預設展示資料（亦可隨時一鍵清空重置）
 */
function ensureDemoTransactionsIfEmpty(db) {
  const txCount = db.prepare('SELECT COUNT(*) AS cnt FROM transactions').get().cnt;
  if (txCount > 0) return;

  const today = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const d0 = fmt(today);
  const d1 = fmt(new Date(today.getTime() - 1 * 86400000));
  const d2 = fmt(new Date(today.getTime() - 2 * 86400000));
  const d3 = fmt(new Date(today.getTime() - 3 * 86400000));
  const d4 = fmt(new Date(today.getTime() - 4 * 86400000));
  const d15 = fmt(new Date(today.getTime() - 15 * 86400000)); // 超過 14 天的幽靈圈存示範

  // 1. 超過 14 天未請款的幽靈圈存示範
  processBankNotification(db, `【玉山銀行】簽帳金融卡消費授權：${d15} 於「日本亞馬遜 AMAZON JP」刷卡 NT$890 元。`, {
    timestamp: `${d15}T14:20:00+08:00`, referenceDate: d0
  });

  // 2. 小額高頻消費 (觸發 7 天內 > 4 次低於 $200 隱形吸血鬼抓漏雷達)
  processBankNotification(db, `【玉山Wallet】簽帳金融卡消費授權：${d4} 於「連加*7-ELEVEN」消費 NT$10 元（麥香紅茶）。`, {
    timestamp: `${d4}T08:15:00+08:00`, referenceDate: d0
  });
  processBankNotification(db, `【玉山銀行】簽帳卡消費扣款：${d2} 商店請款「統一超商」（原交易日 ${d4}）實際扣款 NT$10 元。`, {
    timestamp: `${d2}T04:10:00+08:00`, referenceDate: d0
  });

  processBankNotification(db, `【玉山Wallet】簽帳金融卡消費授權：${d3} 於「連加*50嵐」消費 NT$65 元。`, {
    timestamp: `${d3}T15:10:00+08:00`, referenceDate: d0
  });
  processBankNotification(db, `【玉山Wallet】簽帳金融卡消費授權：${d2} 於「街口*全家便利商店」消費 NT$89 元。`, {
    timestamp: `${d2}T23:40:00+08:00`, referenceDate: d0
  });
  processBankNotification(db, `【玉山Wallet】簽帳金融卡消費授權：${d1} 於「連加*7-ELEVEN」消費 NT$10 元（麥香奶茶）。`, {
    timestamp: `${d1}T09:05:00+08:00`, referenceDate: d0
  });
  processBankNotification(db, `【玉山Wallet】簽帳金融卡消費授權：${d0} 於「連加*得正飲品」消費 NT$60 元。`, {
    timestamp: `${d0}T13:20:00+08:00`, referenceDate: d0
  });

  // 3. 中油 $1,500 加油站預授權白名單 (TEMP_HOLD)
  processBankNotification(db, `【玉山銀行】簽帳金融卡消費授權：${d1} 於「台灣中油」刷卡授權 NT$1,500 元。`, {
    timestamp: `${d1}T18:30:00+08:00`, referenceDate: d0
  });

  // 4. Steam 海外消費圈存 (等待通道 B 匯差 +1.5% 請款測試)
  processBankNotification(db, `【玉山銀行】簽帳金融卡消費授權：${d2} 於「STEAM GAMES」刷卡 NT$1,000 元。`, {
    timestamp: `${d2}T21:00:00+08:00`, referenceDate: d0
  });

  // 5. 72 小時冷靜池示範商品
  const cartCount = db.prepare('SELECT COUNT(*) AS cnt FROM cooldown_cart').get().cnt;
  if (cartCount === 0) {
    const item1 = evaluateImpulsePurchase(db, {
      itemName: '機械式鍵盤 RGB 特仕版',
      amount: 2400,
      reason: '限時特價而且發光超帥',
      itemType: 'WANT',
      addToCart: true
    });
    // 新增一筆已放棄購買的防剁手成就示範
    const item2 = evaluateImpulsePurchase(db, {
      itemName: '潮牌聯名連帽外套',
      amount: 1880,
      reason: '心情不好想犒賞自己',
      itemType: 'WANT',
      addToCart: true
    });
    if (item2.cooldownRecord) {
      resolveCooldownItem(db, item2.cooldownRecord.id, 'ABANDON');
    }
    void item1;
  }
}

function buildFullDashboardSnapshot(db) {
  const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
  const survival = getSurvivalDashboardMetrics(db);
  const highRiskMode = getHighRiskModeStatus(db);
  const ghostHolds = scanGhostHolds(db);
  const cooldownCart = getCooldownCartSummary(db);
  const radar = getVampireAndSubscriptionRadar(db);
  const splitBills = getSplitBillsSummary(db);
  const walletTank = getWalletTankStatus(db);

  const transactions = db.prepare(`
    SELECT t.*,
           s.id AS split_id, s.self_amount AS split_self_amount,
           s.receivable_amount AS split_receivable_amount, s.debtor_name AS split_debtor_name,
           s.is_repaid AS split_is_repaid
    FROM transactions t
    LEFT JOIN split_bills s ON s.transaction_id = t.id
    ORDER BY t.tx_date DESC, t.id DESC
    LIMIT 100
  `).all();

  const notificationLogs = db.prepare('SELECT * FROM notification_logs ORDER BY id DESC LIMIT 30').all();
  const balanceSyncLogs = db.prepare('SELECT * FROM balance_sync_logs ORDER BY id DESC LIMIT 10').all();

  return {
    settings: {
      ...settings,
      gmail_app_password: settings.gmail_app_password ? '********' : ''
    },
    survival,
    highRiskMode,
    ghostHolds,
    transactions,
    notificationLogs,
    cooldownCart,
    radar,
    splitBills,
    walletTank,
    balanceSyncLogs
  };
}
async function handleApiRequest(method, pathname, body = {}, searchParams, options = {}) {
  const db = options.db || getDb();

  if ((method === 'GET' || method === 'POST') && pathname === '/api/dashboard') {
    return { status: 200, data: { ok: true, ...buildFullDashboardSnapshot(db) } };
  }

  // 1. 玉山銀行通知解析 (手動貼上 / iOS 捷徑 Webhook)
  if (method === 'POST' && (pathname === '/api/notifications/parse' || pathname === '/api/notifications/webhook')) {
    const rawText = body.text || body.rawText || body.message || '';
    const source = pathname.endsWith('/webhook') ? (body.source || 'ios_shortcut_webhook') : (body.source || 'manual_ui');
    const result = processBankNotification(db, rawText, {
      source,
      timestamp: body.timestamp || new Date().toISOString(),
      referenceDate: body.referenceDate
    });
    return { status: 200, data: { ok: true, result, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 2. Gmail IMAP 主動收信測試
  if (method === 'POST' && pathname === '/api/notifications/gmail-poll') {
    const imapRes = await pollEsunEmailsViaImap(db);
    return { status: 200, data: { ok: true, imap: imapRes, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 3. 唯讀跨專案班表同步 (支援自動掃描外部目錄或貼上 shiftpay-v2 JSON)
  if (method === 'POST' && pathname === '/api/shift/sync') {
    const cycle = syncCycleWithShiftData(db, {
      rawJsonPayload: body.rawJsonPayload || null,
      referenceDateStr: body.referenceDate || null
    });
    return {
      status: 200,
      data: {
        ok: true,
        message: `✅ 已成功同步班表薪資！預估總薪資 $${cycle.shift_gross_pay.toLocaleString()} ➔ 保守實領 $${cycle.estimated_net_pay.toLocaleString()}（時薪 $${cycle.hourly_wage}）`,
        cycle,
        dashboard: buildFullDashboardSnapshot(db)
      }
    };
  }

  // 4. 加油站預授權手動填入實際加油金額
  if (method === 'POST' && pathname === '/api/transactions/gas-resolve') {
    const tx = resolveGasTempHoldManually(db, body.txId, body.actualAmount);
    return { status: 200, data: { ok: true, transaction: tx, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 5. 手動標記退單待解圈 (移入凍結觀察區)
  if (method === 'POST' && pathname === '/api/transactions/cancel') {
    const tx = markTransactionCanceled(db, body.txId, body.reason);
    return { status: 200, data: { ok: true, transaction: tx, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 6. 朋友聚餐一鍵拆帳 / 代墊沖銷
  if (method === 'POST' && pathname === '/api/transactions/split') {
    const res = splitTransactionBill(db, {
      transactionId: body.transactionId,
      selfAmount: body.selfAmount,
      debtorName: body.debtorName
    });
    return { status: 200, data: { ok: true, ...res, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/split-bills/settle') {
    const res = settleSplitBill(db, body.splitBillId);
    return { status: 200, data: { ok: true, splitBill: res, dashboard: buildFullDashboardSnapshot(db) } };
  }
  // 7. 衝動消費守門員評估 + 72 小時冷靜池操作
  if (method === 'POST' && pathname === '/api/impulse/evaluate') {
    const evaluation = evaluateImpulsePurchase(db, body);
    return { status: 200, data: { ok: true, evaluation, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/cooldown/fast-forward') {
    const item = fastForwardCooldownItem(db, body.itemId);
    return { status: 200, data: { ok: true, item, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/cooldown/resolve') {
    const res = resolveCooldownItem(db, body.itemId, body.decision);
    return { status: 200, data: { ok: true, ...res, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 8. 固定開銷、訂閱與分期付款管理
  if (method === 'POST' && pathname === '/api/fixed-expenses') {
    const nowIso = new Date().toISOString();
    const type = ['FIXED', 'SUBSCRIPTION', 'INSTALLMENT'].includes(body.expenseType) ? body.expenseType : 'FIXED';
    db.prepare(`
      INSERT INTO fixed_expenses (name, expense_type, monthly_amount, billing_day, total_installments, remaining_installments, note, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      String(body.name || '新增固定開銷').trim(),
      type,
      Math.max(1, Math.round(Number(body.monthlyAmount) || 0)),
      Math.min(31, Math.max(1, Math.round(Number(body.billingDay) || 15))),
      type === 'INSTALLMENT' ? Math.max(1, Math.round(Number(body.totalInstallments) || 6)) : null,
      type === 'INSTALLMENT' ? Math.max(1, Math.round(Number(body.remainingInstallments) || 6)) : null,
      String(body.note || '').trim(),
      nowIso
    );
    return { status: 200, data: { ok: true, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/fixed-expenses/delete') {
    db.prepare('DELETE FROM fixed_expenses WHERE id = ?').run(Number(body.id));
    return { status: 200, data: { ok: true, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 9. 悠遊卡自動加值 / 領現金黑洞追蹤水庫 (Wallet Tank)
  if (method === 'POST' && pathname === '/api/wallet-tank/adjust') {
    const tank = quickAdjustWalletTank(db, body);
    return { status: 200, data: { ok: true, walletTank: tank, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/wallet-tank/audit') {
    const tank = auditWalletTank(db, body);
    return { status: 200, data: { ok: true, walletTank: tank, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 10. 玉山可用餘額一鍵校正 & 未知漏帳黑洞拆分
  if (method === 'POST' && pathname === '/api/balance/sync') {
    const syncRes = syncEsunAvailableBalance(db, body);
    return { status: 200, data: { ok: true, syncResult: syncRes, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/balance/split-gap') {
    const res = splitUnknownGapTransaction(db, body.gapTxId, body.items);
    return { status: 200, data: { ok: true, ...res, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 11. 系統與生存週期設定更新
  if (method === 'POST' && pathname === '/api/settings') {
    const cur = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
    const paydayDay = body.paydayDay !== undefined ? Math.min(28, Math.max(1, Number(body.paydayDay))) : cur.payday_day;
    const netPayFactor = body.netPayFactor !== undefined ? Math.min(1, Math.max(0.5, Number(body.netPayFactor))) : cur.net_pay_factor;
    const laborHealthDeduction = body.laborHealthDeduction !== undefined ? Math.max(0, Math.round(Number(body.laborHealthDeduction))) : cur.labor_health_deduction;
    const shiftAppPath = body.shiftAppPath !== undefined ? String(body.shiftAppPath).trim() : cur.shift_app_path;
    const forceHighRiskMode = body.forceHighRiskMode !== undefined ? (body.forceHighRiskMode ? 1 : 0) : cur.force_high_risk_mode;
    const gmailUser = body.gmailUser !== undefined ? String(body.gmailUser).trim() : cur.gmail_user;
    const gmailPass = (body.gmailAppPassword && body.gmailAppPassword !== '********') ? String(body.gmailAppPassword).trim() : cur.gmail_app_password;
    const nowIso = new Date().toISOString();

    db.prepare(`
      UPDATE user_settings
      SET payday_day = ?, net_pay_factor = ?, labor_health_deduction = ?,
          shift_app_path = ?, force_high_risk_mode = ?, gmail_user = ?, gmail_app_password = ?, updated_at = ?
      WHERE id = 1
    `).run(paydayDay, netPayFactor, laborHealthDeduction, shiftAppPath, forceHighRiskMode, gmailUser, gmailPass, nowIso);

    syncCycleWithShiftData(db);
    return { status: 200, data: { ok: true, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 12. 展示資料重置 / 清空帳本
  if (method === 'POST' && pathname === '/api/demo/reset') {
    db.exec(`
      DELETE FROM split_bills;
      DELETE FROM transactions;
      DELETE FROM notification_logs;
      DELETE FROM cooldown_cart;
      DELETE FROM wallet_tank_logs;
      DELETE FROM balance_sync_logs;
      DELETE FROM income_cycles;
    `);
    if (body.withDemoData !== false) {
      ensureDemoTransactionsIfEmpty(db);
    }
    return { status: 200, data: { ok: true, dashboard: buildFullDashboardSnapshot(db) } };
  }

  return { status: 404, data: { ok: false, error: `Unknown endpoint: ${method} ${pathname}` } };
}

module.exports = {
  handleApiRequest,
  ensureDemoTransactionsIfEmpty,
  buildFullDashboardSnapshot
};



  },
  "browserEntry": function(module, exports, require) {
'use strict';

const { createDatabase } = require('./db/database');
const { ensureDemoTransactionsIfEmpty, handleApiRequest } = require('./routes/api');

const STORAGE_KEY = 'anti_broke_cloud_snapshot_v1';
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
    browserDb = createDatabase({ engine: 'portable', seedDefaults: true, snapshot: saved || null });
    if (!saved) {
      ensureDemoTransactionsIfEmpty(browserDb);
    }
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

  }
  };
  var cache = {};
  function resolveKey(req) {
    if (req.startsWith('node:')) return null;
    var base = req.split('/').pop().replace(/\.js$/, '');
    return modules[base] ? base : null;
  }
  function customRequire(req) {
    var key = resolveKey(req);
    if (!key) throw new Error('Module not available in browser: ' + req);
    if (cache[key]) return cache[key].exports;
    var mod = { exports: {} };
    cache[key] = mod;
    modules[key](mod, mod.exports, customRequire);
    return mod.exports;
  }
  customRequire('browserEntry');
})();
