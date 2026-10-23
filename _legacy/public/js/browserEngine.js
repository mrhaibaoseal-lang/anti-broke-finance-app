(function() {
  var modules = {
  "portableDb": function(module, exports, require) {
'use strict';

const TABLE_DEFAULTS = {
  user_settings: () => ({
    id: 1, payday_day: 10, net_pay_factor: 0.95, labor_health_deduction: 0,
    default_hourly_wage: 200, shift_app_path: 'C:\\Users\\mrhai\\.gemini\\antigravity\\scratch\\shift-pay-app',
    last_known_bank_balance: 0, force_high_risk_mode: 0, llm_api_key: '',
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
    id: 1, easycard_balance: 0, cash_balance: 0, last_audit_at: '', updated_at: ''
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
      const refDate = params[0];
      const cycleKey = params[params.length - 1];
      const rows = this.tables.transactions.filter(t => String(t.cycle_key) === String(cycleKey));
      let total_spent = 0, pending_spent = 0, settled_spent = 0, cash_spent = 0, gap_spent = 0, today_spent = 0;
      let total_deposited = 0, atm_deposited = 0, deposit_count = 0, today_deposited = 0;
      for (const t of rows) {
        const amt = Number(t.personal_amount) || 0;
        const effAmt = Number(t.effective_amount) || 0;
        if (['PENDING', 'SETTLED', 'UNKNOWN_GAP', 'CASH_SPENT'].includes(t.status)) {
          total_spent += amt;
          if (t.tx_date === refDate) today_spent += amt;
        }
        if (t.status === 'PENDING') pending_spent += amt;
        if (['SETTLED', 'CASH_SPENT'].includes(t.status)) settled_spent += amt;
        if (t.status === 'CASH_SPENT') cash_spent += effAmt;
        if (t.status === 'UNKNOWN_GAP') gap_spent += amt;
        if (t.status === 'DEPOSIT') {
          total_deposited += effAmt;
          if (t.category !== '薪資入帳') atm_deposited += effAmt;
          deposit_count += 1;
          if (t.tx_date === refDate) today_deposited += effAmt;
        }
      }
      return {
        total_spent, pending_spent, settled_spent, cash_spent, gap_spent, today_spent,
        total_deposited, atm_deposited, deposit_count, today_deposited
      };
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
        .map(l => ({ id: l.id, received_at: l.received_at, linked_tx_id: l.linked_tx_id, raw_text: l.raw_text }));
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
          ['PENDING', 'SETTLED', 'CASH_SPENT'].includes(t.status) &&
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

  },
  "shiftSyncService": function(module, exports, require) {
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

function computeShiftPayFromFullState(shiftState, targetYearMonth, explicitMonth = null) {
  const settings = shiftState.settings || {};
  const hourlyWage = Number(settings.hourlyWage) || 200;
  const otMultiplier = Number.isFinite(Number(settings.otMultiplier)) ? Number(settings.otMultiplier) : 1;
  const roundingMode = settings.roundingMode || 'monthly';
  const attendanceBonus = Number(settings.attendanceBonus) || 0;
  const shifts = shiftState.shifts || {};

  let ym = targetYearMonth;
  const allKeys = Object.keys(shifts).sort();
  if (explicitMonth && allKeys.some(k => k.startsWith(explicitMonth + '-')) && (!ym || !allKeys.some(k => k.startsWith(ym + '-')))) {
    ym = explicitMonth;
  }
  if (!ym || !allKeys.some(k => k.startsWith(ym + '-'))) {
    ym = allKeys.length > 0 ? allKeys[allKeys.length - 1].slice(0, 7) : (explicitMonth || new Date().toISOString().slice(0, 7));
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
  if (data.fullState && typeof data.fullState === 'object' && data.fullState.shifts) {
    const computed = computeShiftPayFromFullState(data.fullState, preferredMonth, data.month);
    return { ...computed, fullState: data.fullState };
  }
  if (data.state && typeof data.state === 'object' && data.state.shifts) {
    const computed = computeShiftPayFromFullState(data.state, preferredMonth, data.month);
    return { ...computed, fullState: data.state };
  }
  if (data.shifts && typeof data.shifts === 'object') {
    const cleanFullState = {
      settings: data.settings || {},
      stamps: Array.isArray(data.stamps) ? data.stamps : undefined,
      shifts: data.shifts
    };
    const computed = computeShiftPayFromFullState(cleanFullState, preferredMonth, data.month);
    return { ...computed, fullState: cleanFullState };
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
      shiftCount: Number(data.shiftCount) || (Array.isArray(data.upcoming7Days) ? data.upcoming7Days.filter(d => d.hasShift).length : 0),
      fullState: data.state || data.fullState || null
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

function computeShiftPayForExactMonth(shiftState, exactYearMonth) {
  const settings = (shiftState && shiftState.settings) || {};
  const hourlyWage = Number(settings.hourlyWage) || 200;
  const otMultiplier = Number.isFinite(Number(settings.otMultiplier)) ? Number(settings.otMultiplier) : 1;
  const roundingMode = settings.roundingMode || 'monthly';
  const attendanceBonus = Number(settings.attendanceBonus) || 0;
  const shifts = (shiftState && shiftState.shifts) || {};

  const ym = String(exactYearMonth || new Date().toISOString().slice(0, 7)).slice(0, 7);
  const prefix = ym + '-';
  const days = Object.keys(shifts).filter(k => k.startsWith(prefix)).sort();
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

module.exports = {
  computeShiftPayFromFullState,
  computeShiftPayForExactMonth,
  parseShiftPayload,
  saveLatestShiftSyncCache,
  readExternalShiftDirectory,
  calculateEstimatedNetPay
};

  },
  "survivalEngine": function(module, exports, require) {
'use strict';

const { readExternalShiftDirectory, parseShiftPayload, saveLatestShiftSyncCache, calculateEstimatedNetPay, computeShiftPayForExactMonth } = require('./shiftSyncService');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function getPreviousYearMonth(ymStr) {
  const [y, m] = String(ymStr || '2026-10').slice(0, 7).split('-').map(Number);
  if (!y || !m) return '2026-09';
  return m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
}

function formatYMD(dt) {
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function getTaipeiTodayYMD() {
  const taipeiDt = new Date(Date.now() + 8 * 3600 * 1000);
  return `${taipeiDt.getUTCFullYear()}-${pad2(taipeiDt.getUTCMonth() + 1)}-${pad2(taipeiDt.getUTCDate())}`;
}

/**
 * 1.2 自訂「發薪日生存週期」計算器 (禁止死板以每月 1 號重置)
 */
function getCycleRangeForDate(dateStr, paydayDay = 10) {
  const safePayday = Math.min(28, Math.max(1, Number(paydayDay) || 10));
  const ymd = (dateStr || getTaipeiTodayYMD()).slice(0, 10);
  const ref = new Date(`${ymd}T00:00:00`);
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
    const nowIso = new Date().toISOString();
    const initialWage = Number(settings.default_hourly_wage) || 200;

    db.prepare(`
      INSERT INTO income_cycles (
        cycle_key, start_date, end_date, target_shift_month,
        shift_gross_pay, normal_hours, ot_minutes, bonus_pay,
        hourly_wage, estimated_net_pay, actual_salary, is_salary_settled,
        shift_sync_source, raw_shift_payload, last_synced_at
      ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, 0, NULL, 0, 'init_clean', NULL, ?)
    `).run(
      range.cycleKey,
      range.startDate,
      range.endDate,
      range.targetShiftMonth,
      initialWage,
      nowIso
    );

    cycle = db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(range.cycleKey);
  }
  return cycle;
}

function syncCycleWithShiftData(db, { rawJsonPayload = null, manualNetSalary = null, manualGrossPay = null, manualHourlyWage = null, recalculateOnly = false, isAutoSync = false, referenceDateStr = null } = {}) {
  const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
  const cycle = ensureCurrentCycle(db, referenceDateStr);
  const nowIso = new Date().toISOString();

  const wage = (manualHourlyWage !== null && manualHourlyWage !== undefined && Number(manualHourlyWage) > 0)
    ? Math.round(Number(manualHourlyWage))
    : (Number(cycle.hourly_wage) || Number(settings.default_hourly_wage) || 200);

  if (wage > 0) {
    db.prepare('UPDATE user_settings SET default_hourly_wage = ?, updated_at = ? WHERE id = 1').run(wage, nowIso);
  }

  // 模式 A：使用者直接輸入「本月實領薪資 / 可用預算」
  if (manualNetSalary !== null && manualNetSalary !== undefined && String(manualNetSalary).trim() !== '') {
    const netAmt = Math.max(0, Math.round(Number(manualNetSalary) || 0));
    const grossAmt = (manualGrossPay !== null && manualGrossPay !== undefined && String(manualGrossPay).trim() !== '')
      ? Math.max(0, Math.round(Number(manualGrossPay) || 0))
      : netAmt;

    db.prepare(`
      UPDATE income_cycles
      SET shift_gross_pay = ?, hourly_wage = ?, estimated_net_pay = ?,
          actual_salary = ?, is_salary_settled = 1, shift_sync_source = 'manual_salary', last_synced_at = ?
      WHERE cycle_key = ?
    `).run(grossAmt, wage, netAmt, netAmt, nowIso, cycle.cycle_key);

    return db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(cycle.cycle_key);
  }

  // 模式 B：使用者輸入「預估班表總薪資 (Gross)」，由系統乘上折數與扣除勞健保
  if (manualGrossPay !== null && manualGrossPay !== undefined && String(manualGrossPay).trim() !== '') {
    const grossAmt = Math.max(0, Math.round(Number(manualGrossPay) || 0));
    const estNet = calculateEstimatedNetPay(grossAmt, settings.net_pay_factor, settings.labor_health_deduction);

    db.prepare(`
      UPDATE income_cycles
      SET shift_gross_pay = ?, hourly_wage = ?, estimated_net_pay = ?,
          actual_salary = NULL, is_salary_settled = 0, shift_sync_source = 'manual_gross', last_synced_at = ?
      WHERE cycle_key = ?
    `).run(grossAmt, wage, estNet, nowIso, cycle.cycle_key);

    return db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(cycle.cycle_key);
  }

  // 模式 C：僅變更設定（折數 / 勞健保 / 時薪）時重算現有週期，不洗掉既有薪資
  if (recalculateOnly) {
    const estNet = calculateEstimatedNetPay(cycle.shift_gross_pay, settings.net_pay_factor, settings.labor_health_deduction);
    db.prepare(`
      UPDATE income_cycles
      SET hourly_wage = ?, estimated_net_pay = ?, last_synced_at = ?
      WHERE cycle_key = ?
    `).run(wage, estNet, nowIso, cycle.cycle_key);
    return db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(cycle.cycle_key);
  }

  // 模式 D：從自動連動的 shift-pay-app 狀態、已儲存雲端狀態或外部目錄唯讀同步
  let existingParsed = null;
  if (cycle.raw_shift_payload) {
    try {
      existingParsed = JSON.parse(cycle.raw_shift_payload);
    } catch (_) {}
  }

  let synced;
  if (rawJsonPayload) {
    synced = {
      ...parseShiftPayload(rawJsonPayload, cycle.target_shift_month),
      syncSource: 'shift_pay_app_auto_sync'
    };
    if (!synced.fullState && existingParsed?.fullState) {
      synced.fullState = existingParsed.fullState;
    }
    if ((synced.totalPay > 0 || synced.shiftCount > 0) && !process.env.NODE_TEST_CONTEXT) {
      saveLatestShiftSyncCache(rawJsonPayload);
    }
    // 自動背景同步保護：若班表 App 尚無排班 (totalPay === 0) 且記帳系統已有設定薪資或既有班表，僅同步時薪而不覆蓋既有班表與預算
    const existingHasShifts = existingParsed?.fullState?.shifts && Object.keys(existingParsed.fullState.shifts).length > 0;
    if (isAutoSync && synced.totalPay === 0 && (Number(cycle.shift_gross_pay) > 0 || existingHasShifts)) {
      if (synced.hourlyWage > 0) {
        db.prepare('UPDATE user_settings SET default_hourly_wage = ?, updated_at = ? WHERE id = 1').run(synced.hourlyWage, nowIso);
        db.prepare('UPDATE income_cycles SET hourly_wage = ?, last_synced_at = ? WHERE cycle_key = ?').run(synced.hourlyWage, nowIso, cycle.cycle_key);
      }
      return db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(cycle.cycle_key);
    }
  } else {
    // 若未傳入 rawJsonPayload，先檢查目前週期是否已有雲端綁定的班表狀態
    if (existingParsed && (existingParsed.totalPay > 0 || (existingParsed.fullState?.shifts && Object.keys(existingParsed.fullState.shifts).length > 0))) {
      synced = {
        ...parseShiftPayload(existingParsed.fullState || existingParsed, cycle.target_shift_month),
        syncSource: existingParsed.syncSource || 'cloud_shift_bound'
      };
    } else {
      synced = readExternalShiftDirectory(settings.shift_app_path, cycle.target_shift_month);
    }
    // 若外部目錄僅讀到 0 元空範本，且當前週期已有班表薪資數據，保留既有數據避免覆蓋歸零
    if ((!synced || synced.totalPay === 0) && Number(cycle.shift_gross_pay) > 0) {
      const estNet = calculateEstimatedNetPay(cycle.shift_gross_pay, settings.net_pay_factor, settings.labor_health_deduction);
      db.prepare(`
        UPDATE income_cycles
        SET hourly_wage = ?, estimated_net_pay = ?, last_synced_at = ?
        WHERE cycle_key = ?
      `).run(wage, estNet, nowIso, cycle.cycle_key);
      return db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(cycle.cycle_key);
    }
  }

  const estNetPay = calculateEstimatedNetPay(
    synced.totalPay,
    settings.net_pay_factor,
    settings.labor_health_deduction
  );

  db.prepare(`
    UPDATE income_cycles
    SET shift_gross_pay = ?, normal_hours = ?, ot_minutes = ?, bonus_pay = ?,
        hourly_wage = ?, estimated_net_pay = ?, shift_sync_source = ?,
        raw_shift_payload = ?, last_synced_at = ?
    WHERE cycle_key = ?
  `).run(
    synced.totalPay, synced.normalHours, synced.otMinutes, synced.bonusPay,
    synced.hourlyWage || wage, estNetPay, synced.syncSource,
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
  const refDate = (referenceDateStr || getTaipeiTodayYMD()).slice(0, 10);
  const cycle = ensureCurrentCycle(db, refDate);

  let parsedRawShiftPayload = null;
  if (cycle.raw_shift_payload) {
    try {
      parsedRawShiftPayload = JSON.parse(cycle.raw_shift_payload);
    } catch (_) {}
  }

  // 時間對照模式：預設為 NEXT_MONTH_PAY（次月發薪制：這個月上班排班 ➔ 下個月發薪日才領；目前週期花的是上個月班表或目前已領薪水）
  const mappingMode = settings.llm_api_key === 'SAME_MONTH_PAY' ? 'SAME_MONTH_PAY' : 'NEXT_MONTH_PAY';
  const accumulatingShiftMonth = cycle.target_shift_month; // 例如 2026-10（目前正在上班累積的班表月份）
  const earnedShiftMonth = getPreviousYearMonth(accumulatingShiftMonth); // 例如 2026-09（上個月上班、已於本週期發薪日入帳的班表月份）

  const fullState = parsedRawShiftPayload?.fullState || null;
  const prevMonthShift = fullState
    ? computeShiftPayForExactMonth(fullState, earnedShiftMonth)
    : { month: earnedShiftMonth, hourlyWage: cycle.hourly_wage || 200, totalPay: 0, normalPay: 0, normalHours: 0, otPay: 0, otMinutes: 0, bonusOk: false, bonusPay: 0, shiftCount: 0 };
  const currMonthShift = fullState
    ? computeShiftPayForExactMonth(fullState, accumulatingShiftMonth)
    : {
        month: accumulatingShiftMonth,
        hourlyWage: cycle.hourly_wage || 200,
        totalPay: Number(cycle.shift_gross_pay) || 0,
        normalPay: Number(cycle.shift_gross_pay) || 0,
        normalHours: Number(cycle.normal_hours) || 0,
        otPay: 0,
        otMinutes: Number(cycle.ot_minutes) || 0,
        bonusOk: Number(cycle.bonus_pay) > 0,
        bonusPay: Number(cycle.bonus_pay) || 0,
        shiftCount: Number(parsedRawShiftPayload?.shiftCount) || 0
      };

  const prevMonthEstNet = calculateEstimatedNetPay(prevMonthShift.totalPay, settings.net_pay_factor, settings.labor_health_deduction);
  const currMonthEstNet = calculateEstimatedNetPay(currMonthShift.totalPay, settings.net_pay_factor, settings.labor_health_deduction);

  const fixedRow = db.prepare('SELECT COALESCE(SUM(monthly_amount), 0) AS total_fixed FROM fixed_expenses WHERE is_active = 1').get();
  const fixedAndInstallments = Number(fixedRow.total_fixed) || 0;

  const spentRow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('PENDING', 'SETTLED', 'UNKNOWN_GAP', 'CASH_SPENT') THEN personal_amount ELSE 0 END), 0) AS total_spent,
      COALESCE(SUM(CASE WHEN status = 'PENDING' THEN personal_amount ELSE 0 END), 0) AS pending_spent,
      COALESCE(SUM(CASE WHEN status IN ('SETTLED', 'CASH_SPENT') THEN personal_amount ELSE 0 END), 0) AS settled_spent,
      COALESCE(SUM(CASE WHEN status = 'CASH_SPENT' THEN effective_amount ELSE 0 END), 0) AS cash_spent,
      COALESCE(SUM(CASE WHEN status = 'UNKNOWN_GAP' THEN personal_amount ELSE 0 END), 0) AS gap_spent,
      COALESCE(SUM(CASE WHEN status IN ('PENDING', 'SETTLED', 'UNKNOWN_GAP', 'CASH_SPENT') AND tx_date = ? THEN personal_amount ELSE 0 END), 0) AS today_spent,
      COALESCE(SUM(CASE WHEN status = 'DEPOSIT' THEN effective_amount ELSE 0 END), 0) AS total_deposited,
      COALESCE(SUM(CASE WHEN status = 'DEPOSIT' AND category != '薪資入帳' THEN effective_amount ELSE 0 END), 0) AS atm_deposited,
      COALESCE(SUM(CASE WHEN status = 'DEPOSIT' THEN 1 ELSE 0 END), 0) AS deposit_count,
      COALESCE(SUM(CASE WHEN status = 'DEPOSIT' AND tx_date = ? THEN effective_amount ELSE 0 END), 0) AS today_deposited
    FROM transactions WHERE cycle_key = ?
  `).get(refDate, refDate, cycle.cycle_key);

  const totalSpent = Number(spentRow.total_spent) || 0;
  const todaySpent = Number(spentRow.today_spent) || 0;
  const totalDeposited = Number(spentRow.total_deposited) || 0;
  const atmDeposited = Number(spentRow.atm_deposited) || 0;
  const depositCount = Number(spentRow.deposit_count) || 0;
  const todayDeposited = Number(spentRow.today_deposited) || 0;
  const cashSpent = Number(spentRow.cash_spent) || 0;

  let effectiveIncome;
  let activeSourceType;
  let activeSourceLabel;

  if (cycle.is_salary_settled && cycle.actual_salary !== null) {
    effectiveIncome = Number(cycle.actual_salary) + atmDeposited;
    activeSourceType = atmDeposited > 0 ? 'ATM_AND_BASE' : 'MANUAL_SETTLED';
    activeSourceLabel = atmDeposited > 0
      ? `🏧 金融卡存款 ($${atmDeposited.toLocaleString()}) ＋ 初始預算 ($${Number(cycle.actual_salary).toLocaleString()})`
      : `手動設定目前已領薪資 ($${effectiveIncome.toLocaleString()})`;
  } else if (atmDeposited > 0) {
    effectiveIncome = atmDeposited;
    activeSourceType = 'ATM_DEPOSIT';
    activeSourceLabel = `🏧 金融卡存款累計 ($${atmDeposited.toLocaleString()} · 共 ${depositCount} 筆)`;
  } else if (fullState) {
    if (mappingMode === 'NEXT_MONTH_PAY') {
      effectiveIncome = prevMonthEstNet;
      if (prevMonthShift.shiftCount > 0 || prevMonthShift.totalPay > 0) {
        activeSourceType = 'PREV_MONTH_SHIFT';
        activeSourceLabel = `${earnedShiftMonth} 上月班表（${cycle.start_date.slice(5).replace('-', '/')} 已發薪）`;
      } else {
        activeSourceType = 'AWAITING_CURRENT_BUDGET';
        activeSourceLabel = `待存入金融卡或設定目前預算（${accumulatingShiftMonth} 班表為領現參考）`;
      }
    } else {
      effectiveIncome = currMonthShift.totalPay > 0 ? currMonthEstNet : Number(cycle.estimated_net_pay);
      activeSourceType = 'CURR_MONTH_SHIFT';
      activeSourceLabel = `${accumulatingShiftMonth} 本月班表（當月直接抵用）`;
    }
  } else {
    effectiveIncome = Number(cycle.estimated_net_pay);
    activeSourceType = 'ESTIMATED_SUMMARY';
    activeSourceLabel = '預估實領薪資';
  }

  const startMs = new Date(`${cycle.start_date}T00:00:00`).getTime();
  const endMs = new Date(`${cycle.end_date}T00:00:00`).getTime();
  const refMs = Math.min(endMs, Math.max(startMs, new Date(`${refDate}T00:00:00`).getTime()));

  const totalCycleDays = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
  const daysElapsed = Math.max(1, Math.round((refMs - startMs) / 86400000) + 1);
  const daysRemaining = Math.max(1, Math.round((endMs - refMs) / 86400000) + 1);

  // 讀取目前皮包現金與悠遊卡水庫餘額
  const tankRow = db.prepare('SELECT cash_balance, easycard_balance FROM wallet_tank WHERE id = 1').get();
  const cashBalance = Number(tankRow?.cash_balance) || 0;
  const easycardBalance = Number(tankRow?.easycard_balance) || 0;

  const disposablePool = effectiveIncome - fixedAndInstallments;
  const cardRemainingBudget = disposablePool - totalSpent;
  // 本月總剩餘可用額度（包含金融卡預算 ＋ 皮包現金餘額）
  const remainingBudget = cardRemainingBudget + cashBalance;
  const dailySafeBudget = Math.floor(remainingBudget / daysRemaining);
  const idealDailyBudget = Math.max(1, Math.floor((disposablePool + cashBalance) / totalCycleDays));

  const avgDailyBurnRate = Math.round(totalSpent / daysElapsed);
  const isTodayOverspent = todaySpent > idealDailyBudget || (remainingBudget < (disposablePool + cashBalance) * (daysRemaining / totalCycleDays));

  let projectedBrokeDate = null, daysUntilBroke = null, overdraftDays = 0, bankruptcyWarningText = null;
  const effectiveBurnVelocity = Math.max(avgDailyBurnRate, todaySpent);
  const isInitialZeroState = effectiveIncome === 0 && fixedAndInstallments === 0 && totalSpent === 0 && totalDeposited === 0 && cashBalance === 0;

  if (!isInitialZeroState && remainingBudget <= 0) {
    daysUntilBroke = 0;
    projectedBrokeDate = refDate;
    overdraftDays = daysRemaining;
    bankruptcyWarningText = `🚨 緊急破產警報：可用安全預算已透支 $${Math.abs(remainingBudget)} 元！你已透支未來 ${daysRemaining} 天的餐費，接下來每天只能花 $0 元！`;
  } else if (!isInitialZeroState && effectiveBurnVelocity > Math.max(1, dailySafeBudget)) {
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

  const tier = isInitialZeroState
    ? {
        code: 'WEALTHY',
        emoji: '🏧',
        label: '等待 ATM 存款或登記現金',
        rangeText: '自動偵測金融卡存款',
        themeColor: 'emerald',
        advice: '💡 領現金再去 ATM 存進金融卡時，系統會自動偵測玉山「存款通知」並累加可用預算！你也可以在下方直接登記皮包現金與悠遊卡消費。'
      }
    : evaluateSurvivalTier(dailySafeBudget);

  // 計算下個發薪週期 (Next Payday Cycle) 供時間對照顯示
  const endDtNext = new Date(`${cycle.end_date}T00:00:00`);
  endDtNext.setDate(endDtNext.getDate() + 1);
  const nextPaydayDateStr = formatYMD(endDtNext);
  const nextRange = getCycleRangeForDate(nextPaydayDateStr, settings.payday_day);
  const nextStartMs = new Date(`${nextRange.startDate}T00:00:00`).getTime();
  const nextEndMs = new Date(`${nextRange.endDate}T00:00:00`).getTime();
  const nextTotalCycleDays = Math.max(1, Math.round((nextEndMs - nextStartMs) / 86400000) + 1);
  const projectedNextDisposable = Math.max(0, currMonthEstNet - fixedAndInstallments);
  const projectedNextDailySafe = Math.floor(projectedNextDisposable / nextTotalCycleDays);

  const timeMapping = {
    mappingMode,
    realToday: refDate,
    paydayDay: settings.payday_day,
    currentCycle: {
      cycleKey: cycle.cycle_key,
      startDate: cycle.start_date,
      endDate: cycle.end_date,
      paydayDate: cycle.start_date,
      daysRemaining,
      earnedShiftMonth,
      prevMonthShift: {
        ...prevMonthShift,
        estimatedNetPay: prevMonthEstNet
      },
      activeSourceType,
      activeSourceLabel,
      effectiveIncome
    },
    upcomingCycle: {
      workMonth: accumulatingShiftMonth,
      paydayDate: nextRange.startDate,
      cycleStartDate: nextRange.startDate,
      cycleEndDate: nextRange.endDate,
      totalCycleDays: nextTotalCycleDays,
      daysUntilPayday: daysRemaining,
      currMonthShift: {
        ...currMonthShift,
        estimatedNetPay: currMonthEstNet
      },
      fixedAndInstallments,
      projectedDisposable: projectedNextDisposable,
      projectedDailySafe: projectedNextDailySafe
    }
  };

  return {
    referenceDate: refDate,
    timeMapping,
    cycle: {
      cycleKey: cycle.cycle_key, startDate: cycle.start_date, endDate: cycle.end_date,
      paydayDay: settings.payday_day, totalCycleDays, daysElapsed, daysRemaining,
      targetShiftMonth: cycle.target_shift_month, shiftGrossPay: cycle.shift_gross_pay,
      normalHours: cycle.normal_hours, otMinutes: cycle.ot_minutes, bonusPay: cycle.bonus_pay,
      hourlyWage: cycle.hourly_wage || settings.default_hourly_wage,
      netPayFactor: settings.net_pay_factor, laborHealthDeduction: settings.labor_health_deduction,
      estimatedNetPay: cycle.estimated_net_pay, actualSalary: cycle.actual_salary,
      isSalarySettled: Boolean(cycle.is_salary_settled), shiftSyncSource: cycle.shift_sync_source,
      rawShiftPayload: parsedRawShiftPayload,
      lastSyncedAt: cycle.last_synced_at
    },
    budget: {
      effectiveIncome, fixedAndInstallments, disposablePool, totalSpent,
      totalDeposited, atmDeposited, depositCount, todayDeposited, cashSpent,
      pendingSpent: Number(spentRow.pending_spent) || 0, settledSpent: Number(spentRow.settled_spent) || 0,
      gapSpent: Number(spentRow.gap_spent) || 0, todaySpent,
      cardRemainingBudget, cardRemaining: cardRemainingBudget,
      cashBalance, easycardBalance,
      remainingBudget, totalRemaining: remainingBudget, dailySafeBudget,
      idealDailyBudget, avgDailyBurnRate, isTodayOverspent: isInitialZeroState ? false : isTodayOverspent, overdraftDays,
      daysUntilBroke, projectedBrokeDate, bankruptcyWarningText
    },
    tier
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
    /^全盈支付[\*\-\s_]*/,
    /^全盈[\*\-\s_]*/,
    /^拍付[\*\-\s_]*/,
    /^PI錢包[\*\-\s_]*/,
    /^一卡通[\*\-\s_]*/,
    /^IPASS[\*\-\s_]*/,
    /^悠遊付[\*\-\s_]*/,
    /^EASY\s*WALLET[\*\-\s_]*/,
    /^台灣PAY[\*\-\s_]*/,
    /^TWQR[\*\-\s_]*/,
    /^APPLE\s*PAY[\*\-\s_]*/,
    /^GOOGLE\s*PAY[\*\-\s_]*/,
    /^SAMSUNG\s*PAY[\*\-\s_]*/,
    /^玉山WALLET[\*\-\s_]*/
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
  if (/全家便利|全家超商|FAMILY\s*MART|FAMILYMART|^全家$/.test(s)) {
    return '全家便利商店';
  }
  if (/萊爾富|HI[\-\s]*LIFE/.test(s)) {
    return '萊爾富';
  }
  if (/OK超商|OK\s*MART|來來超商/.test(s)) {
    return 'OK超商';
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
  if (/MCDONALD|麥當勞/.test(s)) {
    return '麥當勞';
  }
  if (/STARBUCKS|星巴克|悠旅生活/.test(s)) {
    return '星巴克';
  }
  if (/SHOPEE|蝦皮/.test(s)) {
    return '蝦皮購物';
  }
  if (/玉山\s*ATM\s*無卡存款|無卡存款/.test(s)) {
    return '玉山 ATM 無卡存款';
  }
  if (/玉山\s*ATM\s*現金存款|玉山\s*ATM\s*存款|ATM\s*現金存款|ATM\s*存款|ATM\s*存入|自動化設備存款|跨行存款/.test(s)) {
    return '玉山 ATM 存款';
  }
  if (/玉山帳戶轉帳入帳|轉帳入帳|轉帳存入|匯款入帳/.test(s)) {
    return '玉山帳戶轉帳入帳';
  }
  if (/玉山金融卡存款/.test(s)) {
    return '玉山金融卡存款';
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
 * 1.1 銀行刷卡／簽帳卡消費／授權圈存／商店請款攔截規則
 * 只要銀行通知內含「簽帳、消費、授權、卡號、刷卡、圈存、請款、預授權、信用卡」等字眼，一律攔截忽略，
 * 避免與 iOS 捷徑「Apple Pay 交易」重複記帳。
 */
const BANK_CARD_BLOCK_REGEX = /簽帳|消費|授權|卡號|刷卡|圈存|請款|預授權|信用卡|特店名稱|特約商店|刷退|取消授權|解圈/i;

function isBankCardNotification(rawText) {
  const clean = toHalfWidth(String(rawText || '')).trim();
  if (!clean) return false;
  return BANK_CARD_BLOCK_REGEX.test(clean);
}

/**
 * 自動推斷消費分類與特殊標記（已移除銀行試刷驗證與加油站預授權狀態機）
 */
function classifyTransaction(rawMerchant, normalizedMerchant, amount, rawText, channelType = null, manualCategoryTag = null) {
  const combined = `${rawMerchant} ${normalizedMerchant} ${rawText || ''}`.toUpperCase();
  const tag = String(manualCategoryTag || '').trim().toUpperCase();

  const isDeposit = channelType === 'DEPOSIT_IN' || channelType === 'SALARY_IN' || channelType === 'TRANSFER_IN';

  let walletTankType = null;
  if (!isDeposit) {
    if (/自動加值|悠遊卡|EASYCARD|全支付|IPASS\s*MONEY|一卡通MONEY|街口儲值/.test(combined)) {
      walletTankType = 'EASYCARD';
    } else if (/ATM\s*提款|ATM\s*提領|提款|現金提領|跨行提款|無卡提款/.test(combined)) {
      walletTankType = 'CASH';
    }
  }

  const isApplePay = !isDeposit && /APPLE\s*PAY|APPLE\s*錢包|APPLE\s*WALLET|感應刷卡|錢包交易/.test(combined);
  const isForeignTx = !isDeposit && /STEAM|NETFLIX|APPLE\.COM|APP\s*STORE|ITUNES|SPOTIFY|GOOGLE|YOUTUBE|PLAYSTATION|NINTENDO|AMAZON|AGODA|BOOKING|AIRBNB|國外|海外|外幣|USD|JPY|EUR/.test(combined);

  let category = '一般消費';
  if (tag === 'ADVANCE' || manualCategoryTag === '代墊款') {
    category = '代墊款';
  } else if (tag === 'TRANSFER' || manualCategoryTag === '內部互轉') {
    category = '內部互轉';
  } else if (tag === 'EXPENSE' || manualCategoryTag === '一般支出') {
    category = '一般支出';
  } else if (channelType === 'SALARY_IN' || /薪資入帳|薪水入帳|薪資轉帳/.test(combined)) {
    category = '薪資入帳';
  } else if (isDeposit) {
    if (/轉帳|匯款|收到/.test(combined) && !/ATM|無卡存款|現金存/.test(combined)) category = '轉帳入帳';
    else category = 'ATM存款';
  } else if (walletTankType === 'EASYCARD') {
    category = '自動加值/儲值';
  } else if (walletTankType === 'CASH') {
    category = 'ATM提款';
  } else if (/中油|加油站|全國加油|台亞|速邁樂|台塑石油/.test(combined)) {
    category = '加油交通';
  } else if (/7-ELEVEN|全家|萊爾富|OK超商|便利商店/.test(combined)) {
    category = '超商小額';
  } else if (/五十嵐|50嵐|清心|迷客夏|可不可|麻古|茶湯會|得正|一沐日|星巴克|路易莎|飲料|咖啡|麥香/.test(combined)) {
    category = '手搖飲品';
  } else if (/優食|UBEREATS|FOODPANDA|富胖達|餐廳|美食|小吃|便當|火鍋|燒肉|麥當勞|肯德基|摩斯|壽司/.test(combined)) {
    category = '餐飲外食';
  } else if (/STEAM|NETFLIX|SPOTIFY|APPLE\.COM|APP\s*STORE|ITUNES|遊戲|娛樂|影城/.test(combined)) {
    category = '數位娛樂';
  } else if (/蝦皮|MOMO|PCHOME|淘寶|COUPANG|網購/.test(combined)) {
    category = '網購剁手';
  } else if (channelType === 'TRANSFER_OUT') {
    category = '一般支出';
  }

  return {
    category,
    isDeposit,
    isApplePay,
    isVerifyAuth: false,
    isGasStation: category === '加油交通',
    isGasPreAuth: false,
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
 * 解析轉帳／收帳螢幕 OCR 文字（`raw_text`）或銀行轉帳／存款／薪資通知
 * 注意：若偵測到銀行刷卡／簽帳／消費／授權／卡號等字眼，直接標記為 IGNORED_CARD_TX 攔截丟棄
 */
function parseEsunNotification(rawText, options = {}) {
  const cleanText = toHalfWidth(String(rawText || ''))
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\r\n/g, '\n')
    .trim();

  if (!cleanText && !options.overrideAmount) {
    throw new Error('通知文字不可為空');
  }

  const refDateStr = options.referenceDate || new Date().toISOString().slice(0, 10);
  const defaultYear = Number(refDateStr.slice(0, 4)) || new Date().getFullYear();

  // 【步驟 1：徹底攔截銀行刷卡／簽帳卡消費／授權圈存／商店請款通知】
  if (options.source !== 'apple_pay' && isBankCardNotification(cleanText)) {
    return {
      channelType: 'IGNORED_CARD_TX',
      isBlockedCardNotification: true,
      direction: 'OUT',
      rawMerchant: '銀行刷卡通知(已攔截)',
      normalizedMerchant: '銀行刷卡通知(已攔截)',
      amount: 0,
      txDate: refDateStr,
      eventDate: refDateStr,
      rawText: cleanText
    };
  }

  // 擷取通知內附帶的「可用餘額」（若有），並從金額匹配字串中移除餘額干擾
  let reportedAvailableBalance = null;
  const balMatch = cleanText.match(/(?:可用餘額|帳戶可用餘額|帳戶餘額|台幣餘額|臺幣餘額)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?/i);
  if (balMatch && balMatch[1]) {
    reportedAvailableBalance = parseInt(balMatch[1].replace(/,/g, ''), 10);
  }

  const textForAmount = cleanText
    .replace(/(?:可用餘額|帳戶可用餘額|帳戶餘額|台幣餘額|臺幣餘額|剩餘額度)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*[0-9,]+(?:\.[0-9]+)?\s*元?/gi, ' ')
    .replace(/手續費(?:優惠|減免)?[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*[0-9,]+(?:\.[0-9]+)?\s*元?/gi, ' ')
    .replace(/(?:轉出帳號|轉入帳號|入帳帳號|扣款帳號|帳號|交易序號|序號)[：:\s]*[0-9\-\*＊\s]+/gi, ' ')
    .replace(/\b\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?\b/g, ' ')
    .replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g, ' ');

  let amount = Number(options.overrideAmount) > 0 ? Math.round(Number(options.overrideAmount)) : 0;
  if (!amount) {
    const amountPatterns = [
      /(?:轉帳金額|交易金額|轉出金額|匯款金額|付款金額|扣款金額|存入金額|存款金額|轉入金額|入帳金額|收款金額|實付金額|金額)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?(?![0-9]*[\/\-年月:])/i,
      /(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?(?![0-9]*[\/\-年:])/i,
      /(?<![0-9.])([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?\s*元/,
      /(?:轉出|轉入|存入|存款|入帳|轉帳|匯款|扣款)[：:\s]*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?(?![0-9]*[\/\-年月:])/i
    ];
    for (const pat of amountPatterns) {
      const m = textForAmount.match(pat);
      if (m && m[1]) {
        amount = parseInt(m[1].replace(/,/g, ''), 10);
        break;
      }
    }
  }

  // 判定方向 (IN 收帳/存款 vs OUT 轉帳支出/代墊/互轉) 與通道類型
  const manualTag = String(options.categoryTag || options.category || '').trim().toUpperCase();
  let direction = options.direction ? String(options.direction).toUpperCase() : null;
  let channelType = 'TRANSFER_OUT';

  if (/薪資入帳|薪水入帳|薪資轉帳|薪轉入帳|發薪入帳|薪資發放/.test(cleanText)) {
    channelType = 'SALARY_IN';
    direction = 'IN';
  } else if (direction === 'IN' || direction === 'OUT') {
    channelType = direction === 'IN' ? 'DEPOSIT_IN' : 'TRANSFER_OUT';
  } else {
    const hasOutScreenSignals = /轉帳成功|交易成功|轉出成功|匯款成功|付款成功|轉出帳號|轉出金額|轉帳給|轉給|匯出|帳戶提款|ATM\s*提款|無卡提款/.test(cleanText);
    const hasInSignals = /ATM\s*存款|ATM\s*存入|自動化設備存款|無卡存款|跨行存款|現金存款|現金存入|存款通知|存入通知|帳戶入帳|臺幣帳戶入帳|台幣帳戶入帳|臺幣存匯通知|轉帳入帳|轉帳存入|匯款入帳|收到轉帳|入帳通知|存入金額|存款金額/.test(cleanText);

    if (hasOutScreenSignals && !/收到轉帳|轉帳入帳|存入通知|入帳通知/.test(cleanText)) {
      direction = 'OUT';
      channelType = 'TRANSFER_OUT';
    } else if (hasInSignals) {
      direction = 'IN';
      channelType = 'DEPOSIT_IN';
    } else {
      direction = 'OUT';
      channelType = 'TRANSFER_OUT';
    }
  }

  const allDateMatches = [...cleanText.matchAll(/(\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?|\d{1,2}[\/\-月]\d{1,2}日?)/g)];
  let eventDate = refDateStr;
  if (allDateMatches.length > 0) {
    const firstDate = normalizeDateToken(allDateMatches[0][1], defaultYear);
    if (firstDate) eventDate = firstDate;
  }

  let txTimeMinute = null;
  const timeMatch = cleanText.match(/(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?/);
  if (timeMatch) {
    const parts = timeMatch[0].split(':');
    txTimeMinute = `${String(parts[0]).padStart(2, '0')}:${String(parts[1]).padStart(2, '0')}`;
  }

  let authCode = null;
  let rawMerchant = String(options.merchant || options.debtorName || '').trim();
  let noteText = '';
  const noteMatch = cleanText.match(/(?:備註|交易備註|附言|說明|用途|留言)[：:\s]*([^\n，,。；;]+)/i);
  if (noteMatch && noteMatch[1]) {
    noteText = noteMatch[1].trim();
  }

  const headerIgnoreRegex = /玉山|銀行|轉帳|通知|存匯|臺幣|台幣|成功|交易/i;
  if (!rawMerchant) {
    const quoteMatches = [...cleanText.matchAll(/[「『]([^」』]+)[」』]/g)];
    for (const qm of quoteMatches) {
      const candidate = qm[1].trim();
      if (candidate && !headerIgnoreRegex.test(candidate)) {
        rawMerchant = candidate;
        break;
      }
    }
  }
  if (!rawMerchant && noteText) {
    rawMerchant = noteText;
  }
  if (!rawMerchant) {
    const targetMatch = cleanText.match(/(?:轉入戶名|收款人|轉帳對象|轉給|收款帳號|轉入帳號)[：:\s]*([^\n，,。；;]+)/i);
    if (targetMatch && targetMatch[1]) {
      rawMerchant = `轉帳 (${targetMatch[1].trim().slice(0, 18)})`;
    }
  }
  if (!rawMerchant || rawMerchant === '未知商店') {
    if (channelType === 'SALARY_IN') {
      rawMerchant = '玉山薪資轉帳';
    } else if (direction === 'IN') {
      if (/無卡存款/.test(cleanText)) {
        rawMerchant = '玉山 ATM 無卡存款';
      } else if (/ATM|自動化設備|現金存|跨行存款/i.test(cleanText)) {
        rawMerchant = '玉山 ATM 存款';
      } else if (/轉帳|匯款|收到/.test(cleanText)) {
        rawMerchant = '玉山帳戶轉帳入帳';
      } else {
        rawMerchant = '玉山 ATM 存款';
      }
    } else {
      if (manualTag === 'ADVANCE') rawMerchant = '轉帳代墊款';
      else if (manualTag === 'TRANSFER') rawMerchant = '帳戶內部互轉';
      else rawMerchant = '銀行轉帳支出';
    }
  }

  const normalizedMerchant = normalizeMerchant(rawMerchant);
  const classification = classifyTransaction(rawMerchant, normalizedMerchant, amount, cleanText, channelType, manualTag);

  return {
    channelType,
    direction,
    categoryTag: manualTag || (direction === 'IN' ? 'DEPOSIT' : 'EXPENSE'),
    rawMerchant,
    normalizedMerchant,
    noteText,
    amount,
    txDate: eventDate,
    originalTxDate: eventDate,
    eventDate,
    txTimeMinute,
    authCode,
    reportedAvailableBalance,
    isBlockedCardNotification: false,
    ...classification,
    rawText: cleanText
  };
}

module.exports = {
  toHalfWidth,
  normalizeMerchant,
  computeMerchantSimilarity,
  isBankCardNotification,
  classifyTransaction,
  parseEsunNotification
};


  },
  "reconciliationEngine": function(module, exports, require) {
'use strict';

const {
  parseEsunNotification,
  computeMerchantSimilarity,
  normalizeMerchant,
  isBankCardNotification,
  classifyTransaction
} = require('./esunParser');
const { ensureCurrentCycle, applyActualSalaryDeposit } = require('./survivalEngine');

const TRANSFER_IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000; // 5 分鐘轉帳/收帳防重複鎖 (300,000 ms)

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

/**
 * 【步驟 3：轉帳與收帳 5 分鐘內相同金額與方向的防重複鎖 (Idempotency Check)】
 * 若 5 分鐘 (300,000 ms) 內已有相同金額與相同方向 (IN / OUT) 的轉帳或收帳紀錄，直接忽略不寫入
 */
function checkTransferIdempotencyLock(db, amount, direction, nowIso, emailUid = null) {
  const nowMs = new Date(nowIso).getTime();
  const normDir = String(direction || 'OUT').toUpperCase() === 'IN' ? 'IN' : 'OUT';
  const targetHash = `TRANSFER_${normDir}|${Number(amount)}`;

  const logs = db.prepare('SELECT * FROM notification_logs ORDER BY id DESC LIMIT 100').all();

  if (emailUid) {
    const uidTag = `[UID:${emailUid}]`;
    const hitUid = logs.find(l => String(l.action_taken || '').includes(uidTag) || String(l.raw_text || '').includes(uidTag));
    if (hitUid) {
      return {
        isDuplicate: true,
        diffSeconds: 0,
        originalTxId: hitUid.linked_tx_id,
        reason: 'SAME_EMAIL_UID'
      };
    }
  }

  for (const log of logs) {
    if (log.channel_type === 'IGNORED_DEBOUNCE' || log.channel_type === 'IGNORED_CARD_TX') continue;

    const logTimeMs = new Date(log.received_at).getTime();
    const diffMs = Math.abs(nowMs - logTimeMs);
    if (diffMs > TRANSFER_IDEMPOTENCY_WINDOW_MS) continue;

    const isSameHash = log.dedupe_hash === targetHash;
    const logDir = (log.channel_type === 'DEPOSIT_IN' || log.channel_type === 'SALARY_IN' || log.channel_type === 'TRANSFER_IN' || String(log.dedupe_hash || '').startsWith('TRANSFER_IN|'))
      ? 'IN'
      : ((log.channel_type === 'TRANSFER_OUT' || String(log.dedupe_hash || '').startsWith('TRANSFER_OUT|')) ? 'OUT' : null);

    if (isSameHash || (logDir === normDir && Number(log.amount) === Number(amount))) {
      return {
        isDuplicate: true,
        diffSeconds: Math.round(diffMs / 1000),
        originalTxId: log.linked_tx_id,
        reason: 'IDEMPOTENCY_5MIN_SAME_AMOUNT_DIRECTION'
      };
    }
  }

  return { isDuplicate: false };
}

/**
 * 已停用舊版銀行雙通道 PENDING -> SETTLED 核銷演算法（保留空殼維持介面相容）
 */
function findBestPendingMatch() {
  return null;
}

/**
 * 【步驟 2：乾淨的 Apple Pay 專用接收處理】
 * 接收來自 iOS Apple Pay 捷徑的 JSON：{ source: "apple_pay", amount, merchant, card_name, timestamp }
 * 進來時直接視為已確認交易 (SETTLED) 並直接扣減當日與當月安全預算
 */
function processApplePayTransaction(db, payload = {}, options = {}) {
  const rawTimestamp = payload.timestamp || options.timestamp || new Date().toISOString();
  const parsedDt = new Date(rawTimestamp);
  const nowIso = Number.isNaN(parsedDt.getTime()) ? new Date().toISOString() : parsedDt.toISOString();
  const refDate = (options.referenceDate || payload.referenceDate || nowIso.slice(0, 10)).slice(0, 10);

  const rawAmtStr = String(payload.amount ?? payload.money ?? payload.price ?? '').replace(/,/g, '').trim();
  const amtMatch = rawAmtStr.match(/(\d+(?:\.\d+)?)/);
  const amount = amtMatch ? Math.round(Number(amtMatch[1])) : 0;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Apple Pay 交易金額必須大於 0');
  }

  const rawMerchant = String(payload.merchant || payload.store || payload.shop || payload.name || '未知商店').trim() || '未知商店';
  const cardName = String(payload.card_name || payload.cardName || payload.card || 'Apple Pay').trim() || 'Apple Pay';
  const normalizedMerchant = normalizeMerchant(rawMerchant);
  const classification = classifyTransaction(rawMerchant, normalizedMerchant, amount, `Apple Pay ${cardName} ${rawMerchant}`, 'APPLE_PAY');

  const cycle = ensureCurrentCycle(db, refDate);
  const dedupeHash = `APPLE_PAY|${normalizedMerchant}|${amount}`;
  const reconcileNote = `🍎 Apple Pay 即時確認入帳（${cardName} · 已直接確認 SETTLED 並扣減安全預算 $${amount.toLocaleString()}）`;
  const rawSummary = JSON.stringify({
    source: 'apple_pay',
    amount,
    merchant: rawMerchant,
    card_name: cardName,
    timestamp: nowIso
  });

  const insertRes = db.prepare(`
    INSERT INTO transactions (
      cycle_key, status, raw_merchant, normalized_merchant, category,
      auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
      tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
      reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
      channel_a_raw, channel_b_raw, created_at
    ) VALUES (?, 'SETTLED', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, 1, 100, ?, ?, 0, ?, NULL, ?)
  `).run(
    cycle.cycle_key,
    rawMerchant,
    normalizedMerchant,
    classification.category,
    amount,
    amount,
    amount,
    amount,
    refDate,
    nowIso,
    nowIso,
    reconcileNote,
    classification.isForeignTx ? 1 : 0,
    rawSummary,
    nowIso
  );

  const txId = Number(insertRes.lastInsertRowid);

  // 保護區連動：若 Apple Pay 為悠遊卡自動加值，自動注入電子票證水庫
  if (classification.walletTankType) {
    creditWalletTankFromTx(
      db,
      classification.walletTankType,
      amount,
      `Apple Pay 自動轉入水庫：${normalizedMerchant} +$${amount}`,
      txId,
      nowIso
    );
  }

  db.prepare(`
    INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
    VALUES (?, 'APPLE_PAY_SETTLED', ?, ?, ?, ?, ?, ?, ?)
  `).run('apple_pay', normalizedMerchant, amount, dedupeHash, reconcileNote, txId, rawSummary, nowIso);

  return {
    resultType: 'APPLE_PAY_SETTLED',
    channelType: 'APPLE_PAY_SETTLED',
    source: 'apple_pay',
    cardName,
    message: reconcileNote,
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId),
    parsed: {
      source: 'apple_pay',
      rawMerchant,
      normalizedMerchant,
      cardName,
      amount,
      txDate: refDate,
      category: classification.category,
      isForeignTx: classification.isForeignTx,
      walletTankType: classification.walletTankType
    }
  };
}

function processBankNotification(db, rawInput, options = {}) {
  const isObjInput = rawInput && typeof rawInput === 'object';
  const payloadObj = isObjInput ? rawInput : {};
  const rawTimestamp = payloadObj.timestamp || options.timestamp || new Date().toISOString();
  const parsedDt = new Date(rawTimestamp);
  const nowIso = Number.isNaN(parsedDt.getTime()) ? new Date().toISOString() : parsedDt.toISOString();
  const refDate = (options.referenceDate || payloadObj.referenceDate || nowIso.slice(0, 10)).slice(0, 10);
  const source = String(payloadObj.source || options.source || 'manual').trim();

  // 【步驟 2：若為 iOS Apple Pay 捷徑專用來源，直接走 Apple Pay 乾淨入帳流程】
  if (source === 'apple_pay' || source === 'apple_pay_auto') {
    if (isObjInput && (payloadObj.amount !== undefined || payloadObj.merchant !== undefined)) {
      return processApplePayTransaction(db, payloadObj, { ...options, timestamp: nowIso, referenceDate: refDate });
    }
    if (options.merchant !== undefined && options.amount !== undefined) {
      return processApplePayTransaction(db, {
        source: 'apple_pay',
        amount: options.amount,
        merchant: options.merchant,
        card_name: options.card_name || options.cardName || options.card,
        timestamp: nowIso
      }, { ...options, referenceDate: refDate });
    }
  }

  const rawText = isObjInput
    ? String(payloadObj.raw_text || payloadObj.rawText || payloadObj.text || '')
    : String(rawInput || '');
  const categoryTag = String(
    payloadObj.category || options.category || payloadObj.categoryTag || options.categoryTag || ''
  ).trim().toUpperCase();
  const explicitDirection = payloadObj.direction || options.direction || null;
  const overrideAmount = payloadObj.amount || options.amount || null;
  const customMerchant = payloadObj.merchant || payloadObj.debtor_name || payloadObj.debtorName || options.merchant || options.debtorName || null;

  // 【步驟 1：徹底攔截銀行刷卡／簽帳卡消費／授權圈存／商店請款通知】
  if (isBankCardNotification(rawText)) {
    const ignoreNote = '🛡️ 已攔截忽略銀行刷卡/簽帳/授權/請款通知（日常刷卡改由 Apple Pay 捷徑原生觸發，避免重複記帳）';
    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'IGNORED_CARD_TX', '銀行刷卡通知(已攔截)', 0, 'BLOCKED_BANK_CARD', ?, NULL, ?, ?)
    `).run(source, ignoreNote, rawText, nowIso);

    return {
      ignored: true,
      resultType: 'IGNORED_BANK_CARD',
      channelType: 'IGNORED_CARD_TX',
      message: ignoreNote
    };
  }

  const parsed = parseEsunNotification(rawText, {
    referenceDate: refDate,
    source,
    categoryTag,
    direction: explicitDirection,
    overrideAmount,
    merchant: customMerchant
  });

  if (options.emailUid || payloadObj.emailUid) {
    parsed.emailUid = String(options.emailUid || payloadObj.emailUid);
  }
  const uidSuffix = parsed.emailUid ? ` [UID:${parsed.emailUid}]` : '';

  if (!parsed.amount || parsed.amount <= 0) {
    return {
      ignored: true,
      resultType: 'IGNORED_NO_AMOUNT',
      channelType: parsed.channelType,
      message: '未偵測到有效金額，已忽略該通知',
      parsed
    };
  }

  // 【步驟 3：轉帳與收帳寫入前，執行「5 分鐘內相同金額與方向的防重複鎖 (Idempotency Check)」】
  const idempotency = checkTransferIdempotencyLock(db, parsed.amount, parsed.direction, nowIso, parsed.emailUid);
  const dedupeHash = `TRANSFER_${parsed.direction}|${parsed.amount}`;

  if (idempotency.isDuplicate) {
    const dirLabel = parsed.direction === 'IN' ? '收帳/轉入' : '轉帳/轉出';
    const ignoreMsg = `🛡️ 5分鐘防重複鎖觸發：5 分鐘內已有相同金額 ($${parsed.amount.toLocaleString()}) 與相同方向 (${dirLabel}) 的紀錄，已自動忽略！${uidSuffix}`;
    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'IGNORED_DEBOUNCE', ?, ?, ?, ?, ?, ?, ?)
    `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, ignoreMsg, idempotency.originalTxId, rawText, nowIso);

    return {
      ignored: true,
      isDuplicate: true,
      resultType: 'IDEMPOTENCY_IGNORED',
      channelType: parsed.channelType,
      direction: parsed.direction,
      amount: parsed.amount,
      message: ignoreMsg,
      originalTxId: idempotency.originalTxId,
      parsed
    };
  }

  const cycle = ensureCurrentCycle(db, parsed.txDate || refDate);

  // 情境 1：玉山薪資入帳通知 -> 自動以真實入帳金額覆蓋當月預估值，並同步寫入存款紀錄
  if (parsed.channelType === 'SALARY_IN') {
    const updatedCycle = applyActualSalaryDeposit(db, parsed.amount, refDate);
    const actionMsg = `💰 薪資入帳自動校正：以真實薪資 $${parsed.amount} 覆蓋原預估實領 ($${cycle.estimated_net_pay})`;
    const salTxRes = db.prepare(`
      INSERT INTO transactions (
        cycle_key, status, raw_merchant, normalized_merchant, category,
        auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
        tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
        reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
        channel_a_raw, channel_b_raw, created_at
      ) VALUES (?, 'DEPOSIT', ?, ?, '薪資入帳', ?, ?, 0, ?, 0, ?, ?, ?, NULL, 1, 100, ?, 0, 0, ?, NULL, ?)
    `).run(
      cycle.cycle_key, parsed.rawMerchant, parsed.normalizedMerchant,
      parsed.amount, parsed.amount, parsed.amount,
      parsed.txDate, nowIso, nowIso, actionMsg, rawText, nowIso
    );
    const salTxId = Number(salTxRes.lastInsertRowid);
    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'SALARY_IN', ?, ?, ?, ?, ?, ?, ?)
    `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, actionMsg, salTxId, rawText, nowIso);

    return {
      resultType: 'SALARY_CALIBRATED',
      channelType: 'SALARY_IN',
      message: actionMsg,
      cycle: updatedCycle,
      transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(salTxId),
      parsed
    };
  }

  // 情境 1.5：收帳／轉帳入帳／ATM 存款通知 (direction === 'IN')
  if (parsed.direction === 'IN') {
    if (parsed.reportedAvailableBalance !== null && Number.isFinite(parsed.reportedAvailableBalance)) {
      db.prepare('UPDATE user_settings SET last_known_bank_balance = ?, updated_at = ? WHERE id = 1')
        .run(parsed.reportedAvailableBalance, nowIso);
    }

    if (categoryTag === 'ADVANCE') {
      const openSplits = db.prepare(`
        SELECT s.*, t.normalized_merchant, t.tx_date, t.status AS tx_status
        FROM split_bills s
        LEFT JOIN transactions t ON t.id = s.transaction_id
        ORDER BY s.is_repaid ASC, s.id DESC
      `).all();
      const matchedSplit = openSplits.find(s => !s.is_repaid && Number(s.receivable_amount) === Number(parsed.amount));
      if (matchedSplit) {
        db.prepare('UPDATE split_bills SET is_repaid = 1, repaid_at = ? WHERE id = ?').run(nowIso, matchedSplit.id);
      }
      const advanceInNote = matchedSplit
        ? `🤝 代墊款收帳自動沖銷 +$${parsed.amount.toLocaleString()}（已自動結清「${matchedSplit.debtor_name}」之應收代墊款）${uidSuffix}`
        : `🤝 代墊款收帳入帳 +$${parsed.amount.toLocaleString()}（朋友還款收回，不重複計入薪資預算）${uidSuffix}`;

      const advInRes = db.prepare(`
        INSERT INTO transactions (
          cycle_key, status, raw_merchant, normalized_merchant, category,
          auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
          tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
          reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
          channel_a_raw, channel_b_raw, created_at
        ) VALUES (?, 'SETTLED', ?, ?, '代墊款收回', ?, ?, 0, ?, 0, ?, ?, ?, NULL, 1, 100, ?, 0, 0, ?, NULL, ?)
      `).run(
        cycle.cycle_key, parsed.rawMerchant, parsed.normalizedMerchant,
        parsed.amount, parsed.amount, parsed.amount,
        parsed.txDate, nowIso, nowIso, advanceInNote, rawText, nowIso
      );
      const advInTxId = Number(advInRes.lastInsertRowid);
      db.prepare(`
        INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
        VALUES (?, 'TRANSFER_IN', ?, ?, ?, ?, ?, ?, ?)
      `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, advanceInNote, advInTxId, rawText, nowIso);

      return {
        resultType: 'ADVANCE_REPAID_IN',
        channelType: 'TRANSFER_IN',
        direction: 'IN',
        category: 'ADVANCE',
        settledSplitBillId: matchedSplit ? matchedSplit.id : null,
        message: advanceInNote,
        transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(advInTxId),
        parsed
      };
    }

    let depositNote = `🏧 金融卡存款/轉帳入帳 +$${parsed.amount.toLocaleString()}（已直接計入本月可用預算池）${uidSuffix}`;
    if (options.deductFromWalletCash || payloadObj.deductFromWalletCash) {
      const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
      if (tank) {
        const curCash = Number(tank.cash_balance) || 0;
        const newCash = Math.max(0, curCash - Number(parsed.amount));
        const actualDeducted = curCash - newCash;
        db.prepare('UPDATE wallet_tank SET cash_balance = ?, updated_at = ? WHERE id = 1').run(newCash, nowIso);
        db.prepare(`
          INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
          VALUES ('CASH', ?, ?, ?, NULL, ?)
        `).run(-actualDeducted, newCash, `🏧 拿皮包現金去 ATM 存入金融卡 -$${parsed.amount}`, nowIso);
        depositNote = `🏧 領現轉存金融卡 +$${parsed.amount.toLocaleString()}（已同步從皮包現金扣除並轉入金融卡可用預算）${uidSuffix}`;
      }
    }

    const depRes = db.prepare(`
      INSERT INTO transactions (
        cycle_key, status, raw_merchant, normalized_merchant, category,
        auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
        tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
        reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
        channel_a_raw, channel_b_raw, created_at
      ) VALUES (?, 'DEPOSIT', ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, 1, 100, ?, 0, 0, ?, NULL, ?)
    `).run(
      cycle.cycle_key, parsed.rawMerchant, parsed.normalizedMerchant, parsed.category || 'ATM存款',
      parsed.amount, parsed.amount, parsed.amount,
      parsed.txDate, nowIso, nowIso, parsed.authCode, depositNote, rawText, nowIso
    );

    const depTxId = Number(depRes.lastInsertRowid);
    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'DEPOSIT_IN', ?, ?, ?, ?, ?, ?, ?)
    `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, depositNote, depTxId, rawText, nowIso);

    return {
      resultType: 'DEPOSIT_RECORDED',
      channelType: 'DEPOSIT_IN',
      direction: 'IN',
      message: depositNote,
      transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(depTxId),
      parsed
    };
  }

  // 情境 3：轉帳轉出 (direction === 'OUT') —— 支援 OCR 文字解析搭配分類標籤 (EXPENSE / ADVANCE / TRANSFER) 或銀行轉帳通知
  if (parsed.reportedAvailableBalance !== null && Number.isFinite(parsed.reportedAvailableBalance)) {
    db.prepare('UPDATE user_settings SET last_known_bank_balance = ?, updated_at = ? WHERE id = 1')
      .run(parsed.reportedAvailableBalance, nowIso);
  }

  const effectiveTag = ['EXPENSE', 'ADVANCE', 'TRANSFER'].includes(categoryTag)
    ? categoryTag
    : (['EXPENSE', 'ADVANCE', 'TRANSFER'].includes(parsed.categoryTag) ? parsed.categoryTag : 'EXPENSE');

  let personalAmount = parsed.amount;
  let finalCategory = parsed.category || '一般支出';
  let reconcileNote = `💸 轉帳支出（已直接確認 SETTLED 並從安全預算扣除 $${parsed.amount.toLocaleString()}）${uidSuffix}`;
  let resultType = 'TRANSFER_EXPENSE_RECORDED';

  if (effectiveTag === 'ADVANCE') {
    personalAmount = 0; // 代墊款不扣個人預算
    finalCategory = '代墊款';
    reconcileNote = `🤝 轉帳代墊款 $${parsed.amount.toLocaleString()}（不扣個人預算，已自動移入應收代墊款池 Advance Pool）${uidSuffix}`;
    resultType = 'TRANSFER_ADVANCE_RECORDED';
  } else if (effectiveTag === 'TRANSFER') {
    personalAmount = 0; // 內部互轉不扣個人預算
    finalCategory = '內部互轉';
    reconcileNote = `🔄 帳戶內部互轉 $${parsed.amount.toLocaleString()}（自己帳戶調度，不計入個人消費預算）${uidSuffix}`;
    resultType = 'INTERNAL_TRANSFER_RECORDED';
  }

  const insertRes = db.prepare(`
    INSERT INTO transactions (
      cycle_key, status, raw_merchant, normalized_merchant, category,
      auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
      tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
      reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
      channel_a_raw, channel_b_raw, created_at
    ) VALUES (?, 'SETTLED', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, 1, 100, ?, 0, 0, ?, NULL, ?)
  `).run(
    cycle.cycle_key,
    parsed.rawMerchant,
    parsed.normalizedMerchant,
    finalCategory,
    parsed.amount,
    parsed.amount,
    parsed.amount,
    personalAmount,
    parsed.txDate,
    nowIso,
    nowIso,
    reconcileNote,
    rawText,
    nowIso
  );

  const txId = Number(insertRes.lastInsertRowid);

  // 若分類為 ADVANCE（代墊款），自動寫入保護區「應收代墊款池 (split_bills)」
  let splitBill = null;
  if (effectiveTag === 'ADVANCE') {
    const debtorName = String(customMerchant || parsed.noteText || parsed.rawMerchant || '朋友代墊').trim() || '朋友代墊';
    const splitRes = db.prepare(`
      INSERT INTO split_bills (transaction_id, total_amount, self_amount, receivable_amount, debtor_name, is_repaid, created_at)
      VALUES (?, ?, 0, ?, ?, 0, ?)
    `).run(txId, parsed.amount, parsed.amount, debtorName, nowIso);
    const splitId = Number(splitRes.lastInsertRowid);
    splitBill = db.prepare('SELECT * FROM split_bills WHERE id = ?').get(splitId);
  }

  // 若為 ATM 提款領現，同步注入現金水庫 (Wallet Tank)
  if (parsed.walletTankType) {
    creditWalletTankFromTx(
      db,
      parsed.walletTankType,
      parsed.amount,
      `轉帳/提款自動轉入水庫：${parsed.normalizedMerchant} +$${parsed.amount}`,
      txId,
      nowIso
    );
  }

  db.prepare(`
    INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
    VALUES (?, 'TRANSFER_OUT', ?, ?, ?, ?, ?, ?, ?)
  `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, reconcileNote, txId, rawText, nowIso);

  return {
    resultType,
    channelType: 'TRANSFER_OUT',
    direction: 'OUT',
    category: effectiveTag,
    message: reconcileNote,
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId),
    splitBill,
    parsed
  };
}

/**
 * 相容保留：手動調整加油金額（直接設為 SETTLED）
 */
function resolveGasTempHoldManually(db, txId, actualGasAmount) {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(txId));
  if (!tx) throw new Error('找不到該筆交易');
  const amt = Math.max(0, Math.round(Number(actualGasAmount) || 0));
  const note = `⛽ 手動確認實際加油金額 $${amt}`;

  db.prepare(`
    UPDATE transactions
    SET status = 'SETTLED',
        effective_amount = ?,
        personal_amount = ?,
        reconcile_note = ?
    WHERE id = ?
  `).run(amt, amt, note, tx.id);

  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
}

/**
 * 相容保留：手動將某筆交易標記為 CANCELED
 */
function markTransactionCanceled(db, txId, reason = '取消交易') {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(txId));
  if (!tx) throw new Error('找不到該筆交易');
  const note = `❄️ 已標記取消交易：${reason}`;

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
 * 相容保留：因為所有消費進系統皆直接確認為 SETTLED，不再產生幽靈圈存
 */
function scanGhostHolds() {
  return [];
}

module.exports = {
  findBestPendingMatch,
  checkTransferIdempotencyLock,
  processApplePayTransaction,
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
 * 將任意時間轉換為台灣時區 (UTC+8, Asia/Taipei) 的日期與小時資訊，
 * 解決 Cloudflare Workers 雲端伺服器預設為 UTC (慢 8 小時) 導致半夜未自動觸發夜間防禦的問題
 */
function getTaipeiTimeParts(referenceNowIso) {
  let dt;
  if (!referenceNowIso) {
    dt = new Date();
  } else {
    const s = String(referenceNowIso).trim();
    // 若傳入無時區偏移的本地字串，視為台灣時間 (+08:00)
    const hasTz = /Z$|[+-]\d{2}:?\d{2}$/i.test(s);
    dt = new Date(hasTz ? s : (s.length === 10 ? `${s}T12:00:00+08:00` : `${s}+08:00`));
    if (Number.isNaN(dt.getTime())) dt = new Date();
  }
  const taipeiMs = dt.getTime() + 8 * 3600 * 1000;
  const taipeiDt = new Date(taipeiMs);
  const year = taipeiDt.getUTCFullYear();
  const month = String(taipeiDt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(taipeiDt.getUTCDate()).padStart(2, '0');
  const hour = taipeiDt.getUTCHours();
  const minute = taipeiDt.getUTCMinutes();
  return {
    hour,
    minute,
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

/**
 * 3.3 偵測「深夜 (23:00~05:00) 與發薪日後 72 小時內」高風險防禦模式
 */
function getHighRiskModeStatus(db, referenceNowIso) {
  const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get();
  const tp = getTaipeiTimeParts(referenceNowIso);
  const hour = tp.hour;
  const localDateStr = tp.dateStr;

  const isLateNight = hour >= 23 || hour < 5;
  const metrics = getSurvivalDashboardMetrics(db, localDateStr);
  const isPostPayday72h = metrics.cycle.daysElapsed >= 1 && metrics.cycle.daysElapsed <= 3;
  const isForced = Boolean(settings.force_high_risk_mode);

  const isHighRisk = isLateNight || isPostPayday72h || isForced;
  const reasons = [];
  if (isLateNight) reasons.push(`深夜腦波弱時段 (${tp.timeStr}，23:00~05:00 嚴格管制)`);
  if (isPostPayday72h) reasons.push(`發薪日後 72 小時暴富錯覺期 (週期第 ${metrics.cycle.daysElapsed} 天)`);
  if (isForced && !isLateNight && !isPostPayday72h) reasons.push('手動開啟高風險防禦演習模式');

  return {
    isHighRisk,
    isLateNight,
    isPostPayday72h,
    isForced,
    taipeiHour: hour,
    taipeiTime: tp.timeStr,
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
  const tp = getTaipeiTimeParts(nowIso);
  const refDate = tp.dateStr;
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
    WHERE status IN ('PENDING', 'SETTLED', 'CASH_SPENT')
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
  const estNetPay = Math.max(0, Number(metrics.budget.effectiveIncome) || Number(metrics.cycle.estimatedNetPay) || 0);

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
    const preemptedPercent = estNetPay > 0
      ? Number(((lockedTotal / estNetPay) * 100).toFixed(1))
      : (lockedTotal > 0 ? 100 : 0);
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

function normalizeSignedInputStr(val) {
  return String(val ?? '')
    .trim()
    .replace(/[＋]/g, '+')
    .replace(/[－﹣—–]/g, '-')
    .replace(/[$,，\s元]/g, '');
}

function parseSignedInt(val) {
  const s = normalizeSignedInputStr(val);
  if (!s) return NaN;
  const isNeg = s.startsWith('-');
  const numPart = s.replace(/^[+-]+/, '');
  if (!numPart) return NaN;
  const n = Math.round(Number(numPart));
  if (!Number.isFinite(n)) return NaN;
  return isNeg ? -Math.abs(n) : Math.abs(n);
}

function quickAdjustWalletTank(db, { tankType = 'CASH', deltaAmount = -50, note = '快速扣水庫銅板消費' }) {
  const type = String(tankType).toUpperCase() === 'EASYCARD' ? 'EASYCARD' : 'CASH';
  const col = type === 'EASYCARD' ? 'easycard_balance' : 'cash_balance';
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  const parsed = parseSignedInt(deltaAmount);
  const delta = Number.isFinite(parsed) ? parsed : 0;
  const newBalance = Math.max(0, (Number(tank[col]) || 0) + delta);
  const nowIso = new Date().toISOString();

  db.prepare(`UPDATE wallet_tank SET ${col} = ?, updated_at = ? WHERE id = 1`).run(newBalance, nowIso);
  db.prepare(`
    INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(type, delta, newBalance, String(note || '水庫變動'), nowIso);

  return getWalletTankStatus(db, nowIso);
}

function auditWalletTank(db, { easycardBalance, cashBalance, easycardMode, cashMode }) {
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  const nowIso = new Date().toISOString();
  const curEasy = Number(tank.easycard_balance) || 0;
  const curCash = Number(tank.cash_balance) || 0;

  let newEasy = curEasy;
  let noteEasy = '3天定期盤點手動校正';
  if (easycardBalance !== undefined && easycardBalance !== null && String(easycardBalance).trim() !== '') {
    const strEasy = normalizeSignedInputStr(easycardBalance);
    const numEasy = parseSignedInt(strEasy);
    if (Number.isFinite(numEasy)) {
      if (numEasy < 0 || easycardMode === 'DELTA' || strEasy.startsWith('+')) {
        newEasy = Math.max(0, curEasy + numEasy);
        noteEasy = numEasy < 0 ? '自訂扣款消費' : '自訂加值存入';
      } else {
        newEasy = Math.max(0, numEasy);
      }
    }
  }

  let newCash = curCash;
  let noteCash = '3天定期盤點手動校正';
  if (cashBalance !== undefined && cashBalance !== null && String(cashBalance).trim() !== '') {
    const strCash = normalizeSignedInputStr(cashBalance);
    const numCash = parseSignedInt(strCash);
    if (Number.isFinite(numCash)) {
      if (numCash < 0 || cashMode === 'DELTA' || strCash.startsWith('+')) {
        newCash = Math.max(0, curCash + numCash);
        noteCash = numCash < 0 ? '自訂扣款消費' : '自訂加值存入';
      } else {
        newCash = Math.max(0, numCash);
      }
    }
  }

  const diffEasy = newEasy - curEasy;
  const diffCash = newCash - curCash;

  db.prepare(`
    UPDATE wallet_tank SET easycard_balance = ?, cash_balance = ?, last_audit_at = ?, updated_at = ? WHERE id = 1
  `).run(newEasy, newCash, nowIso, nowIso);

  if (diffEasy !== 0) {
    db.prepare(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
      VALUES ('EASYCARD', ?, ?, ?, NULL, ?)
    `).run(diffEasy, newEasy, noteEasy, nowIso);
  }
  if (diffCash !== 0) {
    db.prepare(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
      VALUES ('CASH', ?, ?, ?, NULL, ?)
    `).run(diffCash, newCash, noteCash, nowIso);
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
  const systemExpected = Number(metrics.budget.cardRemainingBudget !== undefined ? metrics.budget.cardRemainingBudget : metrics.budget.remainingBudget);
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

/**
 * 4.4 首頁「使用現金直接登記」：同時扣減皮包現金水庫，並寫入交易明細（可選是否同步扣本月防剁手預算）
 */
function recordCashTransaction(db, { itemName, amount, category = '餐飲外食', countInBudget = true, txDate = null, referenceDateStr = null } = {}) {
  const amt = Math.round(Number(amount) || 0);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('請輸入大於 0 的現金消費金額');
  }
  const merchant = String(itemName || '現金消費').trim() || '現金消費';
  const cat = String(category || '餐飲外食').trim() || '餐飲外食';
  const nowIso = new Date().toISOString();
  const refDate = (referenceDateStr || txDate || nowIso.slice(0, 10)).slice(0, 10);
  const dateStr = (txDate || refDate).slice(0, 10);
  const cycle = ensureCurrentCycle(db, dateStr);

  // 1. 扣減皮包現金水庫
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  const curCash = Number(tank?.cash_balance) || 0;
  const newCash = Math.max(0, curCash - amt);
  db.prepare('UPDATE wallet_tank SET cash_balance = ?, updated_at = ? WHERE id = 1').run(newCash, nowIso);

  const personalAmt = countInBudget !== false ? amt : 0;
  const note = countInBudget !== false
    ? `💵 現金直接消費 -$${amt}（已扣減皮包現金，並計入本月總花費扣減防剁手預算）`
    : `💵 現金直接消費 -$${amt}（已從皮包現金水庫扣除，不重複扣減金融卡額度）`;

  // 2. 寫入 transactions 供「扣款紀錄」統一檢視
  const res = db.prepare(`
    INSERT INTO transactions (
      cycle_key, status, raw_merchant, normalized_merchant, category,
      auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
      tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
      reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
      channel_a_raw, channel_b_raw, created_at
    ) VALUES (?, 'CASH_SPENT', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, 1, 100, ?, 0, 0, 'CASH_DIRECT', NULL, ?)
  `).run(
    cycle.cycle_key, merchant, merchant, cat,
    amt, amt, amt, personalAmt,
    dateStr, nowIso, nowIso, note, nowIso
  );

  const txId = Number(res.lastInsertRowid);
  db.prepare(`
    INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
    VALUES ('CASH', ?, ?, ?, ?, ?)
  `).run(-amt, newCash, `💵 現金消費：${merchant}`, txId, nowIso);

  return {
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId),
    walletTank: getWalletTankStatus(db, nowIso)
  };
}

/**
 * 4.5 手動或從皮包現金轉存「金融卡 ATM 存款紀錄」
 */
function recordManualAtmDeposit(db, { amount, merchant = '玉山 ATM 存款', category = 'ATM存款', deductFromWalletCash = false, txDate = null, referenceDateStr = null } = {}) {
  const amt = Math.round(Number(amount) || 0);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('請輸入大於 0 的存款金額');
  }
  const cleanMerchant = String(merchant || '玉山 ATM 存款').trim() || '玉山 ATM 存款';
  const cat = String(category || 'ATM存款').trim() || 'ATM存款';
  const nowIso = new Date().toISOString();
  const refDate = (referenceDateStr || txDate || nowIso.slice(0, 10)).slice(0, 10);
  const dateStr = (txDate || refDate).slice(0, 10);
  const cycle = ensureCurrentCycle(db, dateStr);

  let note = `🏧 金融卡存款入帳 +$${amt.toLocaleString()}（已直接計入本月金融卡可用預算）`;
  if (deductFromWalletCash) {
    const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
    const curCash = Number(tank?.cash_balance) || 0;
    const newCash = Math.max(0, curCash - amt);
    db.prepare('UPDATE wallet_tank SET cash_balance = ?, updated_at = ? WHERE id = 1').run(newCash, nowIso);
    db.prepare(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
      VALUES ('CASH', ?, ?, ?, NULL, ?)
    `).run(-amt, newCash, `🏧 拿皮包現金去 ATM 存入金融卡 -$${amt}`, nowIso);
    note = `🏧 領現去 ATM 存入金融卡 +$${amt.toLocaleString()}（已同步扣減皮包現金並加入金融卡可用預算）`;
  }

  const res = db.prepare(`
    INSERT INTO transactions (
      cycle_key, status, raw_merchant, normalized_merchant, category,
      auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
      tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
      reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
      channel_a_raw, channel_b_raw, created_at
    ) VALUES (?, 'DEPOSIT', ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, NULL, 1, 100, ?, 0, 0, 'MANUAL_DEPOSIT', NULL, ?)
  `).run(
    cycle.cycle_key, cleanMerchant, cleanMerchant, cat,
    amt, amt, amt,
    dateStr, nowIso, nowIso, note, nowIso
  );

  const txId = Number(res.lastInsertRowid);
  return {
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId),
    walletTank: getWalletTankStatus(db, nowIso)
  };
}

/**
 * 4.6 刪除單筆交易或存款紀錄（若為現金消費則自動加回皮包現金）
 */
function deleteTransactionRecord(db, txId) {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(txId));
  if (!tx) throw new Error('找不到該筆紀錄');
  const nowIso = new Date().toISOString();

  if (tx.status === 'CASH_SPENT') {
    const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
    const curCash = Number(tank?.cash_balance) || 0;
    const refundAmt = Number(tx.effective_amount) || 0;
    const newCash = curCash + refundAmt;
    db.prepare('UPDATE wallet_tank SET cash_balance = ?, updated_at = ? WHERE id = 1').run(newCash, nowIso);
    db.prepare(`
      INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
      VALUES ('CASH', ?, ?, ?, NULL, ?)
    `).run(refundAmt, newCash, `↩️ 刪除現金消費退回：${tx.normalized_merchant}`, nowIso);
  }

  // 若該筆交易曾轉入水庫 (如 ATM 提款自動存入皮包現金)，刪除時自動回扣水庫
  const linkedLogs = db.prepare('SELECT * FROM wallet_tank_logs WHERE linked_tx_id = ?').all(tx.id);
  for (const log of linkedLogs) {
    if (log.delta_amount > 0) {
      const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
      const col = log.tank_type === 'CASH' ? 'cash_balance' : 'easycard_balance';
      const curBal = Number(tank?.[col]) || 0;
      const newBal = Math.max(0, curBal - Number(log.delta_amount));
      db.prepare(`UPDATE wallet_tank SET ${col} = ?, updated_at = ? WHERE id = 1`).run(newBal, nowIso);
      db.prepare(`
        INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)
      `).run(log.tank_type, -Number(log.delta_amount), newBal, `↩️ 刪除交易扣回水庫：${tx.normalized_merchant}`, nowIso);
    }
  }

    db.prepare('DELETE FROM transactions WHERE id = ?').run(tx.id);
  return { deletedId: tx.id };
}

module.exports = {
  splitTransactionBill, settleSplitBill, getSplitBillsSummary,
  getWalletTankStatus, quickAdjustWalletTank, auditWalletTank,
  syncEsunAvailableBalance, splitUnknownGapTransaction,
  recordCashTransaction, recordManualAtmDeposit, deleteTransactionRecord
};



  },
  "gmailImapService": function(module, exports, require) {
'use strict';

let tls = null;
try {
  tls = require('node:tls');
} catch (_) {}
const { processBankNotification } = require('./reconciliationEngine');

const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatImapDate(dt) {
  const d = String(dt.getDate()).padStart(2, '0');
  const m = IMAP_MONTHS[dt.getMonth()];
  const y = dt.getFullYear();
  return `${d}-${m}-${y}`;
}

function base64ToUtf8(b64) {
  const clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return '';
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(clean, 'base64').toString('utf8');
    }
    if (typeof atob === 'function' && typeof TextDecoder !== 'undefined') {
      const bin = atob(clean);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }
  } catch (_) {}
  return '';
}

function decodeQuotedPrintableUtf8(qp) {
  const softJoined = String(qp || '').replace(/=\r?\n/g, '');
  try {
    const bytes = [];
    for (let i = 0; i < softJoined.length; i++) {
      if (softJoined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(softJoined.slice(i + 1, i + 3))) {
        bytes.push(parseInt(softJoined.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(softJoined.charCodeAt(i));
      }
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes).toString('utf8');
    }
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    }
  } catch (_) {}
  return softJoined;
}

function decodeRfc2047Word(str) {
  return String(str || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _charset, enc, payload) => {
    if (String(enc).toUpperCase() === 'B') {
      return base64ToUtf8(payload);
    }
    return decodeQuotedPrintableUtf8(String(payload).replace(/_/g, ' '));
  });
}

function stripHtmlTags(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 將原始 MIME 信件內容解碼為乾淨純文字（支援 Base64、Quoted-Printable、Multipart 與 HTML 表格）
 */
function decodeEmailMimeToText(rawMime) {
  const raw = String(rawMime || '');
  if (!raw.trim()) return '';

  const decodedHeaders = decodeRfc2047Word(raw);
  const subjectMatch = decodedHeaders.match(/^Subject:\s*(.+)$/im);
  const subject = subjectMatch ? subjectMatch[1].trim() : '';

  const decodedParts = [];
  if (subject) decodedParts.push(subject);

  const b64Blocks = raw.match(/(?:^[A-Za-z0-9+/]{40,76}\r?\n)+(?:[A-Za-z0-9+/=]{4,76})?/gm) || [];
  for (const blk of b64Blocks) {
    const txt = base64ToUtf8(blk);
    if (txt && /[\u4e00-\u9fa5]|NT\$|TWD|消費|刷卡|扣款|玉山/.test(txt)) {
      decodedParts.push(stripHtmlTags(txt));
    }
  }

  if (/=[0-9A-F]{2}=[0-9A-F]{2}=[0-9A-F]{2}/i.test(raw)) {
    const qpTxt = decodeQuotedPrintableUtf8(raw);
    decodedParts.push(stripHtmlTags(qpTxt));
  }

  if (decodedParts.length <= 1) {
    decodedParts.push(stripHtmlTags(decodedHeaders));
  }

  return decodedParts.join('\n').trim();
}

function isBankTransactionEmailText(text) {
  const t = String(text || '');
  // 排除常見的雲端服務預算警示、廣告支出上限、非銀行扣款通知
  if (/支出上限警告|預算上限|支出金額上限|達到支出金額上限|Google Cloud|AWS Budget|Budget Alert|廣告預算/i.test(t)) {
    return false;
  }
  // 攔截丟棄所有含刷卡、簽帳、消費、授權、卡號字眼的銀行信件（日常刷卡改由 Apple Pay 捷徑觸發）
  if (/簽帳|消費|授權|卡號|刷卡|圈存|請款|預授權|信用卡|刷退|取消授權|解圈/i.test(t)) {
    return false;
  }
  const hasBankTransferOrDeposit = /玉山|E\.?SUN|薪資入帳|薪資轉帳|存款通知|存入通知|帳戶入帳|ATM|自動櫃員機|無卡存款|跨行存款|轉帳入帳|轉帳成功|存匯通知/i.test(t);
  const hasAmount = /(?:NT\$|TWD|新[台臺]幣|\$)\s*[0-9,]+|[0-9,]+\s*元/i.test(t);
  return hasBankTransferOrDeposit && hasAmount;
}

function buildGoogleAppsScriptCode(webhookUrl) {
  const targetUrl = webhookUrl || 'https://anti-broke-finance-app.mr-haibaoseal.workers.dev/api/notifications/webhook';
  return `// ============================================================================
// 🛡️ 防破產記帳系統 — Gmail 轉帳與 ATM 存款通知 24 小時雲端全自動偵測腳本 (Google Apps Script)
// 設定步驟（只需設定一次，終身全自動，不需開電腦、不需手動貼上）：
// 1. 前往 https://script.google.com 新增專案，貼上此程式碼並按 Ctrl+S 儲存
// 2. 點選左側「觸發條件 (鬧鐘圖示)」➔「+ 新增觸發條件」
//    - 執行函式：autoSyncCreditCardNotifications
//    - 時間驅動 ➔ 分鐘計時器 ➔ 每分鐘 (或每 5 分鐘) ➔ 儲存
// ============================================================================

const WEBHOOK_URL = "${targetUrl}";

function autoSyncCreditCardNotifications() {
  const props = PropertiesService.getScriptProperties();
  const syncedIds = JSON.parse(props.getProperty("SYNCED_MSG_IDS") || "[]");
  const syncedSet = new Set(syncedIds);
  const query = 'newer_than:3d (存款通知 OR 帳戶入帳 OR ATM存款 OR 薪資入帳 OR 轉帳入帳 OR 臺幣存匯通知)';
  const threads = GmailApp.search(query, 0, 15);
  let newSynced = false;

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const msgId = msg.getId();
      if (syncedSet.has(msgId)) continue;
      const subject = msg.getSubject() || "";
      const plainBody = msg.getPlainBody() || msg.getBody().replace(/<[^>]+>/g, " ");
      const fullText = "【" + subject + "】\\n" + plainBody;
      try {
        UrlFetchApp.fetch(WEBHOOK_URL, {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify({
            source: "gmail_gas_cloud_auto",
            emailUid: msgId,
            timestamp: msg.getDate().toISOString(),
            text: fullText
          }),
          muteHttpExceptions: true
        });
        syncedSet.add(msgId);
        newSynced = true;
      } catch (err) {}
    }
  }
  if (newSynced) {
    props.setProperty("SYNCED_MSG_IDS", JSON.stringify(Array.from(syncedSet).slice(-200)));
  }
}`;
}

function createUnifiedImapTransport(host, port, callbacks) {
  if (tls && typeof tls.connect === 'function') {
    const socket = tls.connect({ host, port, rejectUnauthorized: true });
    socket.on('data', chunk => callbacks.onData(chunk.toString('utf8')));
    socket.on('error', err => callbacks.onError(err));
    return {
      write(str) {
        try { socket.write(str); } catch (_) {}
      },
      close() {
        try { socket.end(); socket.destroy(); } catch (_) {}
      }
    };
  }

  if (typeof globalThis.__cfSocketConnect === 'function') {
    const sock = globalThis.__cfSocketConnect({ hostname: host, port }, { secureTransport: 'on' });
    const writer = sock.writable.getWriter();
    const reader = sock.readable.getReader();
    const decoder = new TextDecoder('utf-8');
    const encoder = new TextEncoder();

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) callbacks.onData(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        callbacks.onError(err);
      }
    })();

    return {
      write(str) {
        writer.write(encoder.encode(str)).catch(() => {});
      },
      close() {
        try { writer.close(); } catch (_) {}
        try { sock.close(); } catch (_) {}
      }
    };
  }

  return null;
}

/**
 * 原生 TLS / Cloudflare Sockets IMAP 玉山與信用卡通知信全自動掃描與對帳引擎
 */
async function pollEsunEmailsViaImap(db) {
  const settings = db.prepare('SELECT gmail_user, gmail_app_password FROM user_settings WHERE id = 1').get();
  if (!settings || !settings.gmail_user || !settings.gmail_app_password) {
    return {
      ok: false,
      mode: 'NOT_CONFIGURED',
      processedCount: 0,
      newTransactions: [],
      message: '請先輸入您的 Gmail 信箱與 16 碼 Google 應用程式密碼，系統即可每分鐘全自動抓取所有刷卡通知（含 Apple Pay、LINE Pay 與實體卡）！'
    };
  }

  const hasTransport = (tls && typeof tls.connect === 'function') || (typeof globalThis.__cfSocketConnect === 'function');
  if (!hasTransport) {
    return {
      ok: true,
      mode: 'CLOUD_WEBHOOK_READY',
      processedCount: 0,
      newTransactions: [],
      message: '已儲存您的 Gmail 設定！'
    };
  }

  const cleanPass = String(settings.gmail_app_password).replace(/\s+/g, '');

  return new Promise(resolve => {
    try {
      let buffer = '';
      let step = 0;
      const processedResults = [];
      let transport = null;

      const timeout = setTimeout(() => {
        if (transport) transport.close();
        resolve({
          ok: false,
          mode: 'TIMEOUT',
          processedCount: processedResults.length,
          newTransactions: processedResults,
          message: 'Gmail IMAP 連線逾時，請確認網路與 16 碼應用程式密碼是否正確。'
        });
      }, 12000);

      transport = createUnifiedImapTransport('imap.gmail.com', 993, {
        onData(chunkStr) {
          buffer += chunkStr;

          if (step === 0 && /^\* OK/m.test(buffer)) {
            step = 1;
            buffer = '';
            transport.write(`A1 LOGIN "${settings.gmail_user}" "${cleanPass}"\r\n`);
          } else if (step === 1 && /^A1 (OK|NO|BAD)/m.test(buffer)) {
            if (!/^A1 OK/m.test(buffer)) {
              clearTimeout(timeout);
              transport.write('A9 LOGOUT\r\n');
              transport.close();
              return resolve({
                ok: false,
                mode: 'AUTH_FAILED',
                processedCount: 0,
                newTransactions: [],
                message: '❌ Gmail 登入失敗：請確認填寫的是 Google「16 碼應用程式密碼」（而非一般 Gmail 登入密碼）。'
              });
            }
            step = 2;
            buffer = '';
            transport.write('A2 SELECT INBOX\r\n');
          } else if (step === 2 && /^A2 (OK|NO|BAD)/m.test(buffer)) {
            step = 3;
            buffer = '';
            const sinceDt = new Date(Date.now() - 7 * 86400000);
            transport.write(`A3 SEARCH SINCE ${formatImapDate(sinceDt)}\r\n`);
          } else if (step === 3 && /^A3 (OK|NO|BAD)/m.test(buffer)) {
            const searchMatch = buffer.match(/^\* SEARCH(?: (.+))?\r?$/m);
            const seqNums = searchMatch && searchMatch[1]
              ? searchMatch[1].trim().split(/\s+/).filter(Boolean).slice(-12)
              : [];

            buffer = '';
            if (seqNums.length === 0) {
              clearTimeout(timeout);
              transport.write('A5 LOGOUT\r\n');
              transport.close();
              return resolve({
                ok: true,
                mode: 'IMAP_SYNCED',
                processedCount: 0,
                newTransactions: [],
                message: '✅ Gmail 全自動連線成功！最近 7 天信箱內尚無新的刷卡通知信，之後每分鐘將自動在背景幫您抓信入帳！'
              });
            }

            step = 4;
            const fetchSet = seqNums.join(',');
            transport.write(`A4 FETCH ${fetchSet} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT])\r\n`);
          } else if (step === 4 && /^A4 (OK|NO|BAD)/m.test(buffer)) {
            clearTimeout(timeout);
            const rawResponse = buffer;
            buffer = '';
            transport.write('A5 LOGOUT\r\n');
            transport.close();

            const msgBlocks = rawResponse.split(/^\* \d+ FETCH /m).slice(1);
            for (const block of msgBlocks) {
              const uidMatch = block.match(/UID\s+(\d+)/i);
              const uid = uidMatch ? uidMatch[1] : null;
              const decodedText = decodeEmailMimeToText(block);
              if (!isBankTransactionEmailText(decodedText)) continue;

              try {
                const res = processBankNotification(db, decodedText, {
                  source: 'gmail_imap_auto',
                  emailUid: uid || undefined
                });
                if (res && res.resultType !== 'DEBOUNCE_IGNORED') {
                  processedResults.push(res);
                }
              } catch (_) {}
            }

            resolve({
              ok: true,
              mode: 'IMAP_SYNCED',
              processedCount: processedResults.length,
              newTransactions: processedResults,
              message: processedResults.length > 0
                ? `⚡ 全自動偵測成功！已從 Gmail 自動抓取並寫入 ${processedResults.length} 筆最新刷卡/入帳紀錄！`
                : '✅ Gmail 全自動連線成功！目前已同步所有刷卡通知，系統將在背景每分鐘自動抓信！'
            });
          }
        },
        onError(err) {
          clearTimeout(timeout);
          resolve({
            ok: false,
            mode: 'SOCKET_ERROR',
            processedCount: 0,
            newTransactions: [],
            message: `連線異常 (${err?.message || 'Socket Error'})，請確認 Gmail 與 16 碼密碼。`
          });
        }
      });
    } catch (err) {
      resolve({
        ok: false,
        mode: 'ERROR',
        processedCount: 0,
        newTransactions: [],
        message: `連線錯誤：${err?.message || '未知錯誤'}`
      });
    }
  });
}

module.exports = {
  pollEsunEmailsViaImap,
  decodeEmailMimeToText,
  isBankTransactionEmailText,
  buildGoogleAppsScriptCode
};

  },
  "api": function(module, exports, require) {
'use strict';

const { getDb } = require('../db/database');
const { getSurvivalDashboardMetrics, syncCycleWithShiftData } = require('../services/survivalEngine');
const { processApplePayTransaction, processBankNotification, resolveGasTempHoldManually, markTransactionCanceled, scanGhostHolds } = require('../services/reconciliationEngine');
const { getHighRiskModeStatus, evaluateImpulsePurchase, getCooldownCartSummary, fastForwardCooldownItem, resolveCooldownItem, getVampireAndSubscriptionRadar } = require('../services/impulseControlService');
const { splitTransactionBill, settleSplitBill, getSplitBillsSummary, getWalletTankStatus, quickAdjustWalletTank, auditWalletTank, syncEsunAvailableBalance, splitUnknownGapTransaction, recordCashTransaction, recordManualAtmDeposit, deleteTransactionRecord } = require('../services/accountingPatchService');
const { pollEsunEmailsViaImap, decodeEmailMimeToText, buildGoogleAppsScriptCode } = require('../services/gmailImapService');

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

  // 0. 領現金後去 ATM 存入金融卡示範 (DEPOSIT 存款紀錄)
  processBankNotification(db, `【玉山銀行】存款通知：您的玉山帳戶於 ${d4} 12:10 於 ATM 現金存入 NT$15,000 元，可用餘額 NT$15,000 元。`, {
    timestamp: `${d4}T12:10:00+08:00`, referenceDate: d0
  });

  // 1. Apple Pay 原生捷徑消費示範（直接為 SETTLED 已確認交易）
  processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 10,
    merchant: '7-ELEVEN',
    card_name: '玉山簽帳金融卡',
    timestamp: `${d4}T08:15:00+08:00`,
    referenceDate: d4
  });
  processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 65,
    merchant: '50嵐',
    card_name: '玉山簽帳金融卡',
    timestamp: `${d3}T15:10:00+08:00`,
    referenceDate: d3
  });
  processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 89,
    merchant: '全家便利商店',
    card_name: '玉山簽帳金融卡',
    timestamp: `${d2}T23:40:00+08:00`,
    referenceDate: d2
  });
  processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 10,
    merchant: '7-ELEVEN',
    card_name: '玉山簽帳金融卡',
    timestamp: `${d1}T09:05:00+08:00`,
    referenceDate: d1
  });
  processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 60,
    merchant: '得正飲品',
    card_name: '玉山簽帳金融卡',
    timestamp: `${d0}T13:20:00+08:00`,
    referenceDate: d0
  });
  processApplePayTransaction(db, {
    source: 'apple_pay',
    amount: 155,
    merchant: '星巴克',
    card_name: '玉山 Unicard',
    timestamp: `${d0}T15:00:00+08:00`,
    referenceDate: d0
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
    automation: {
      gmailAutoPollEnabled: Boolean(settings.gmail_user && settings.gmail_app_password),
      shiftSyncSource: survival.cycle.shiftSyncSource,
      lastShiftSyncedAt: survival.cycle.lastSyncedAt,
      gasScriptCode: buildGoogleAppsScriptCode()
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

function extractAnyBodyText(body = {}, searchParams = null) {
  const getParam = key => (searchParams && typeof searchParams.get === 'function') ? searchParams.get(key) : null;

  // 優先處理新版 iOS 捷徑「當收到 App 通知時」自動生成的 { title: [標題], body: [內文] } 結構
  if (body && typeof body === 'object' && (body.title !== undefined && body.body !== undefined)) {
    const t = String(body.title || '').trim();
    const b = String(body.body || '').trim();
    if (t && b) return `【${t}】${b}`;
    return b || t;
  }

  let directText = body.raw_text || body.rawText || body.text || body.message || body.notification || body.body || body.input || body.content || body.transaction || body[''] || getParam('raw_text') || getParam('text') || getParam('message') || getParam('input') || '';

  if (!directText && body && typeof body === 'object') {
    const extraVals = Object.entries(body)
      .filter(([k, v]) => !['_clientState', 'source', 'timestamp', 'referenceDate', 'emailUid', 'category', 'categoryTag', 'direction', 'card_name', 'cardName'].includes(k) && (typeof v === 'string' || typeof v === 'number'))
      .map(([, v]) => String(v).trim())
      .filter(Boolean);
    if (extraVals.length > 0) {
      directText = extraVals.join(' ');
    }
  }

  if (typeof directText === 'string' && /%[0-9A-Fa-f]{2}/.test(directText)) {
    try {
      directText = decodeURIComponent(directText.replace(/\+/g, ' '));
    } catch (_) {}
  }
  return String(directText || '').trim();
}

function extractApplePayPayload(body = {}, searchParams = null) {
  const getParam = key => (searchParams && typeof searchParams.get === 'function') ? searchParams.get(key) : null;
  const merchant = String(body.merchant || body.store || body.shop || body.name || body.商家 || body.商店 || body.名稱 || getParam('merchant') || getParam('store') || getParam('name') || '未知商店').trim();
  const amount = body.amount ?? body.money ?? body.price ?? body.金額 ?? getParam('amount') ?? getParam('price') ?? 0;
  const cardName = String(body.card_name || body.cardName || body.card || body.pass || body.卡片 || body.票卡 || getParam('card_name') || getParam('card') || 'Apple Pay').trim();
  const timestamp = body.timestamp || getParam('timestamp') || new Date().toISOString();

  return {
    source: 'apple_pay',
    amount,
    merchant,
    card_name: cardName,
    timestamp,
    referenceDate: body.referenceDate || getParam('referenceDate') || undefined
  };
}

let lastDashboardImapPollMs = 0;

async function handleApiRequest(method, pathname, body = {}, searchParams, options = {}) {
  const db = options.db || getDb();

  if ((method === 'GET' || method === 'POST') && pathname === '/api/dashboard') {
    if (body && body.autoShiftState) {
      try {
        syncCycleWithShiftData(db, { rawJsonPayload: body.autoShiftState, isAutoSync: true });
      } catch (_) {}
    }
    // 若已綁定 Gmail 帳號與 16 碼密碼，前端輪詢 Dashboard 時每 45 秒自動背景掃描一次信箱
    const s = db.prepare('SELECT gmail_user, gmail_app_password FROM user_settings WHERE id = 1').get();
    if (s && s.gmail_user && s.gmail_app_password && (Date.now() - lastDashboardImapPollMs > 45000)) {
      lastDashboardImapPollMs = Date.now();
      try {
        await pollEsunEmailsViaImap(db);
      } catch (_) {}
    }
    return { status: 200, data: { ok: true, ...buildFullDashboardSnapshot(db) } };
  }

  // 1A. 【步驟 2：Apple Pay 專用接收端點】直接寫入 SETTLED 並更新當日安全額度
  if ((method === 'GET' || method === 'POST') && (pathname === '/api/notifications/apple-pay' || pathname === '/api/transactions/apple-pay')) {
    const applePayload = extractApplePayPayload(body, searchParams);
    const result = processApplePayTransaction(db, applePayload, {
      timestamp: applePayload.timestamp,
      referenceDate: applePayload.referenceDate
    });
    const dashboard = buildFullDashboardSnapshot(db);
    return {
      status: 200,
      data: {
        ok: true,
        result,
        dailySafeBudget: dashboard.survival?.budget?.dailySafeBudget ?? 0,
        dashboard
      }
    };
  }

  // 1B. 【Webhook 主接收端】支援：
  //  - Apple Pay 乾淨 JSON ({ source: "apple_pay", amount, merchant, card_name, timestamp })
  //  - 轉帳／收帳螢幕 OCR 文字 ({ raw_text, category: "EXPENSE" | "ADVANCE" | "TRANSFER" }) 與銀行轉帳/存款通知
  //  - 自動攔截並忽略所有含「簽帳、消費、授權、卡號」等字眼的銀行刷卡通知
  if ((method === 'GET' || method === 'POST') && (pathname === '/api/notifications/parse' || pathname === '/api/notifications/webhook' || pathname === '/api/notifications/batch' || pathname === '/api/transactions/transfer')) {
    const getParam = key => (searchParams && typeof searchParams.get === 'function') ? searchParams.get(key) : null;
    const reqSource = String(body.source || getParam('source') || (
      pathname.endsWith('/webhook') ? 'auto_webhook' : (pathname.endsWith('/batch') ? 'auto_batch_webhook' : 'manual_ui')
    )).trim();

    if (reqSource === 'apple_pay' || reqSource === 'apple_pay_auto') {
      const applePayload = extractApplePayPayload(body, searchParams);
      const result = processApplePayTransaction(db, applePayload, {
        timestamp: applePayload.timestamp,
        referenceDate: applePayload.referenceDate
      });
      const dashboard = buildFullDashboardSnapshot(db);
      return {
        status: 200,
        data: {
          ok: true,
          result,
          dailySafeBudget: dashboard.survival?.budget?.dailySafeBudget ?? 0,
          dashboard
        }
      };
    }

    const batchList = Array.isArray(body.notifications)
      ? body.notifications
      : (Array.isArray(body.messages) ? body.messages : null);

    if (batchList && batchList.length > 0) {
      const results = [];
      for (const item of batchList) {
        const itemObj = typeof item === 'string' ? { raw_text: item } : (item || {});
        if (itemObj.source === 'apple_pay' || itemObj.source === 'apple_pay_auto') {
          try {
            const r = processApplePayTransaction(db, extractApplePayPayload(itemObj), {
              timestamp: itemObj.timestamp || new Date().toISOString(),
              referenceDate: itemObj.referenceDate || body.referenceDate
            });
            results.push(r);
          } catch (_) {}
          continue;
        }
        const text = itemObj.rawEmail
          ? decodeEmailMimeToText(itemObj.rawEmail)
          : extractAnyBodyText(itemObj);
        if (!String(text).trim() && !itemObj.amount) continue;
        try {
          const r = processBankNotification(db, text, {
            source: itemObj.source || reqSource,
            category: itemObj.category || body.category,
            direction: itemObj.direction || body.direction,
            amount: itemObj.amount,
            merchant: itemObj.merchant || itemObj.debtor_name || itemObj.debtorName,
            emailUid: itemObj.emailUid || itemObj.messageId || itemObj.uid,
            timestamp: itemObj.timestamp || new Date().toISOString(),
            referenceDate: itemObj.referenceDate || body.referenceDate
          });
          results.push(r);
        } catch (_) {}
      }
      const dashboard = buildFullDashboardSnapshot(db);
      return {
        status: 200,
        data: {
          ok: true,
          processedCount: results.length,
          results,
          result: results[results.length - 1] || null,
          dailySafeBudget: dashboard.survival?.budget?.dailySafeBudget ?? 0,
          dashboard
        }
      };
    }

    const rawText = body.rawEmail
      ? decodeEmailMimeToText(body.rawEmail)
      : extractAnyBodyText(body, searchParams);
    const result = processBankNotification(db, rawText, {
      source: reqSource,
      category: body.category || getParam('category'),
      direction: body.direction || getParam('direction'),
      amount: body.amount || getParam('amount'),
      merchant: body.merchant || body.debtor_name || body.debtorName || getParam('merchant'),
      emailUid: body.emailUid || body.messageId || body.uid,
      timestamp: body.timestamp || new Date().toISOString(),
      referenceDate: body.referenceDate
    });
    const dashboard = buildFullDashboardSnapshot(db);
    return {
      status: 200,
      data: {
        ok: true,
        result,
        dailySafeBudget: dashboard.survival?.budget?.dailySafeBudget ?? 0,
        dashboard
      }
    };
  }

  // 2. Gmail IMAP 主動與背景自動掃描
  if (method === 'POST' && pathname === '/api/notifications/gmail-poll') {
    const imapRes = await pollEsunEmailsViaImap(db);
    return { status: 200, data: { ok: true, imap: imapRes, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 3. 薪資設定與跨專案班表全自動同步 (支援 shift-pay-app 即時自動推送、外部目錄自動掃描、或手動微調)
  if ((method === 'GET' || method === 'POST') && pathname === '/api/shift/state') {
    const survival = getSurvivalDashboardMetrics(db);
    const rawPayload = survival.cycle.rawShiftPayload || null;
    const fullState = rawPayload?.fullState || null;
    const hasShiftData = Boolean(
      (fullState?.shifts && Object.keys(fullState.shifts).length > 0) ||
      (rawPayload && Number(rawPayload.totalPay) > 0)
    );
    return {
      status: 200,
      data: {
        ok: true,
        hasShiftData,
        fullState,
        shiftSummary: rawPayload,
        hourlyWage: survival.cycle.hourlyWage,
        updatedAt: survival.cycle.lastSyncedAt
      }
    };
  }

  if (method === 'POST' && (pathname === '/api/shift/sync' || pathname === '/api/shift/webhook')) {
    if (body.mappingMode === 'NEXT_MONTH_PAY' || body.mappingMode === 'SAME_MONTH_PAY') {
      db.prepare('UPDATE user_settings SET llm_api_key = ?, updated_at = ? WHERE id = 1')
        .run(body.mappingMode, new Date().toISOString());
    }
    if (body.clearManualSalary === true) {
      const curCycle = syncCycleWithShiftData(db, { recalculateOnly: true, referenceDateStr: body.referenceDate || null });
      db.prepare('UPDATE income_cycles SET actual_salary = NULL, is_salary_settled = 0, last_synced_at = ? WHERE cycle_key = ?')
        .run(new Date().toISOString(), curCycle.cycle_key);
    }
    const cycle = syncCycleWithShiftData(db, {
      rawJsonPayload: body.rawJsonPayload || body.shiftState || body.payload || null,
      manualNetSalary: body.manualNetSalary,
      manualGrossPay: body.manualGrossPay,
      manualHourlyWage: body.manualHourlyWage,
      recalculateOnly: Boolean(body.recalculateOnly),
      isAutoSync: Boolean(body.autoSync),
      referenceDateStr: body.referenceDate || null
    });
    const fullDash = buildFullDashboardSnapshot(db);
    const effective = fullDash.survival.budget.effectiveIncome;
    const nextEst = fullDash.survival.timeMapping?.upcomingCycle?.currMonthShift?.estimatedNetPay || 0;
    return {
      status: 200,
      data: {
        ok: true,
        message: `✅ 已同步薪資與時間對照！目前可用預算 $${effective.toLocaleString()}｜下月發薪預估 $${nextEst.toLocaleString()}`,
        cycle,
        dashboard: fullDash
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

  // 9B. 首頁使用現金直接登記消費 & ATM 金融卡存款登記 & 刪除單筆紀錄
  if (method === 'POST' && pathname === '/api/cash/spend') {
    const res = recordCashTransaction(db, body);
    return { status: 200, data: { ok: true, ...res, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/deposits/add') {
    const res = recordManualAtmDeposit(db, body);
    return { status: 200, data: { ok: true, ...res, dashboard: buildFullDashboardSnapshot(db) } };
  }

  if (method === 'POST' && pathname === '/api/transactions/delete') {
    const res = deleteTransactionRecord(db, body.txId);
    return { status: 200, data: { ok: true, ...res, dashboard: buildFullDashboardSnapshot(db) } };
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

    syncCycleWithShiftData(db, { recalculateOnly: true });
    return { status: 200, data: { ok: true, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 12. 展示資料重置 / 清空帳本（完全歸零）
  if (method === 'POST' && pathname === '/api/demo/reset') {
    db.exec(`
      DELETE FROM split_bills;
      DELETE FROM transactions;
      DELETE FROM notification_logs;
      DELETE FROM cooldown_cart;
      DELETE FROM wallet_tank_logs;
      DELETE FROM balance_sync_logs;
      DELETE FROM income_cycles;
      DELETE FROM fixed_expenses;
    `);
    const nowIso = new Date().toISOString();
    db.prepare('UPDATE wallet_tank SET easycard_balance = 0, cash_balance = 0, last_audit_at = ?, updated_at = ? WHERE id = 1').run(nowIso, nowIso);
    db.prepare('UPDATE user_settings SET last_known_bank_balance = 0, updated_at = ? WHERE id = 1').run(nowIso);

    if (body.withDemoData === true) {
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
