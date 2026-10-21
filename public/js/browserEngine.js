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
  if (data.state && typeof data.state === 'object' && data.state.shifts) {
    const computed = computeShiftPayFromFullState(data.state, preferredMonth || data.month);
    return { ...computed, fullState: data.state };
  }
  if (data.shifts && typeof data.shifts === 'object') {
    const computed = computeShiftPayFromFullState(data, preferredMonth);
    return { ...computed, fullState: data };
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
      shiftCount: Number(data.shiftCount) || (Array.isArray(data.upcoming7Days) ? data.upcoming7Days.filter(d => d.hasShift).length : 0)
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

module.exports = {
  computeShiftPayFromFullState,
  parseShiftPayload,
  saveLatestShiftSyncCache,
  readExternalShiftDirectory,
  calculateEstimatedNetPay
};

  },
  "survivalEngine": function(module, exports, require) {
'use strict';

const { readExternalShiftDirectory, parseShiftPayload, saveLatestShiftSyncCache, calculateEstimatedNetPay } = require('./shiftSyncService');

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

  // 模式 D：從自動連動的 shift-pay-app 狀態或外部目錄唯讀同步
  let synced;
  if (rawJsonPayload) {
    synced = {
      ...parseShiftPayload(rawJsonPayload, cycle.target_shift_month),
      syncSource: 'shift_pay_app_auto_sync'
    };
    if ((synced.totalPay > 0 || synced.shiftCount > 0) && !process.env.NODE_TEST_CONTEXT) {
      saveLatestShiftSyncCache(rawJsonPayload);
    }
    // 自動背景同步保護：若班表 App 尚無排班 (totalPay === 0) 且記帳系統已有設定薪資，僅同步時薪而不歸零預算
    if (isAutoSync && synced.totalPay === 0 && Number(cycle.shift_gross_pay) > 0) {
      if (synced.hourlyWage > 0) {
        db.prepare('UPDATE user_settings SET default_hourly_wage = ?, updated_at = ? WHERE id = 1').run(synced.hourlyWage, nowIso);
        db.prepare('UPDATE income_cycles SET hourly_wage = ?, last_synced_at = ? WHERE cycle_key = ?').run(synced.hourlyWage, nowIso, cycle.cycle_key);
      }
      return db.prepare('SELECT * FROM income_cycles WHERE cycle_key = ?').get(cycle.cycle_key);
    }
  } else {
    synced = readExternalShiftDirectory(settings.shift_app_path, cycle.target_shift_month);
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
  const isInitialZeroState = effectiveIncome === 0 && fixedAndInstallments === 0 && totalSpent === 0;

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
        emoji: '✨',
        label: '初始待設定狀態',
        rangeText: '請輸入本月薪資',
        themeColor: 'emerald',
        advice: '帳本已歸零為初始狀態！請點選右上角「💰 設定薪資 / 班表同步」輸入您目前的薪資與時薪，並新增您的固定扣款與消費。'
      }
    : evaluateSurvivalTier(dailySafeBudget);

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

  const isApplePay = /APPLE\s*PAY|APPLE\s*錢包|APPLE\s*WALLET|感應刷卡|錢包交易/.test(combined);
  const isForeignTx = /STEAM|NETFLIX|APPLE\.COM|APP\s*STORE|ITUNES|SPOTIFY|GOOGLE|YOUTUBE|PLAYSTATION|NINTENDO|AMAZON|AGODA|BOOKING|AIRBNB|國外|海外|外幣|USD|JPY|EUR/.test(combined);

  let category = '一般消費';
  if (isVerifyAuth) category = '綁卡驗證';
  else if (isGasStation) category = '加油交通';
  else if (walletTankType === 'EASYCARD') category = '自動加值/儲值';
  else if (walletTankType === 'CASH') category = 'ATM提款';
  else if (/7-ELEVEN|全家|萊爾富|OK超商|便利商店/.test(combined)) category = '超商小額';
  else if (/五十嵐|清心|迷客夏|可不可|麻古|茶湯會|得正|一沐日|星巴克|路易莎|飲料|咖啡|麥香/.test(combined)) category = '手搖飲品';
  else if (/優食|UBEREATS|FOODPANDA|富胖達|餐廳|美食|小吃|便當|火鍋|燒肉|麥當勞|肯德基|摩斯|壽司/.test(combined)) category = '餐飲外食';
  else if (/STEAM|NETFLIX|SPOTIFY|APPLE\.COM|APP\s*STORE|ITUNES|遊戲|娛樂|影城/.test(combined)) category = '數位娛樂';
  else if (/蝦皮|MOMO|PCHOME|淘寶|COUPANG|網購/.test(combined)) category = '網購剁手';

  return {
    category,
    isApplePay,
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
 * 解析玉山銀行與台灣常見信用卡/簽帳金融卡通知文字（支援 Email、Wallet 推播、LINE 通知、簡訊、iOS/Android 捷徑文字）
 * 區分：
 *  - CHANNEL_A_AUTH (第 1 次通知：信用卡刷卡 / 簽帳金融卡消費 / 授權 / 圈存)
 *  - CHANNEL_B_SETTLE (第 2 次通知：帳戶扣款 / 簽帳卡消費扣款 / 商店請款 / 帳單請款)
 *  - SALARY_IN (薪資入帳通知)
 *  - REFUND (刷退 / 取消授權 / 解圈退回)
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

  if (!cleanText) {
    throw new Error('通知文字不可為空');
  }

  const refDateStr = options.referenceDate || new Date().toISOString().slice(0, 10);
  const defaultYear = Number(refDateStr.slice(0, 4)) || new Date().getFullYear();

  // 剔除銀行推播/信件末尾常見的「實際請款金額以帳單/商店請款為準」免責聲明，避免將通道 A 刷卡誤判為通道 B 請款
  const textWithoutDisclaimer = cleanText
    .replace(/(?:實際|最終)?(?:請款|扣款|入帳)金額以(?:帳單|特約商店|商店請款|實際請款|銀行帳單)[^。；\n]*/g, '')
    .replace(/本筆交易為(?:授權|圈存)[^。；\n]*待(?:特約)?商店請款[^。；\n]*/g, '')
    .replace(/待(?:特約)?商店請款後(?:始進行)?扣款/g, '')
    .replace(/尚未請款|未請款/g, '');

  // 1. 判定通道類型 (優先順序：薪資入帳 > 刷退沖銷 > 通道 B 請款扣款 > 通道 A 刷卡授權圈存)
  let channelType = 'CHANNEL_A_AUTH';
  if (/薪資入帳|薪水入帳|薪資轉帳|薪轉入帳|發薪入帳|薪資發放/.test(textWithoutDisclaimer)) {
    channelType = 'SALARY_IN';
  } else if (/刷退|退貨|取消授權|解圈退回|沖銷入帳|退單|取消交易|退款/.test(textWithoutDisclaimer)) {
    channelType = 'REFUND';
  } else if (/帳戶扣款|簽帳卡消費扣款|簽帳金融卡請款|商店請款|請款扣款|實際請款扣款|實際扣款|請款入帳|帳單請款/.test(textWithoutDisclaimer)) {
    channelType = 'CHANNEL_B_SETTLE';
  } else if (/信用卡|簽帳金融卡|簽帳卡|玉山卡|授權|刷卡|圈存|一般消費|消費通知|消費金額|特店名稱|新增消費/.test(textWithoutDisclaimer)) {
    channelType = 'CHANNEL_A_AUTH';
  } else if (/請款/.test(textWithoutDisclaimer)) {
    channelType = 'CHANNEL_B_SETTLE';
  }

  // 1.5 辨識卡別 (CREDIT 信用卡 vs DEBIT 簽帳金融卡) 與卡號末四碼
  const cardType = /簽帳金融卡|簽帳卡|DEBIT|圈存|帳戶扣款/.test(cleanText) ? 'DEBIT' : 'CREDIT';
  let cardLast4 = null;
  const last4Match = cleanText.match(/(?:末四碼|末4碼|卡號末四碼|卡號|\*)\s*([0-9]{4})(?!\d)/);
  if (last4Match) cardLast4 = last4Match[1];

  // 1.6 擷取通知內附帶的「可用餘額」（若有），並從金額匹配字串中移除餘額與卡號干擾
  let reportedAvailableBalance = null;
  const balMatch = cleanText.match(/(?:可用餘額|帳戶可用餘額|帳戶餘額)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?/i);
  if (balMatch && balMatch[1]) {
    reportedAvailableBalance = parseInt(balMatch[1].replace(/,/g, ''), 10);
  }

  const textForAmount = cleanText
    .replace(/(?:可用餘額|帳戶可用餘額|帳戶餘額|剩餘額度|信用額度)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*[0-9,]+(?:\.[0-9]+)?\s*元?/gi, ' ')
    .replace(/(?:卡號)?(?:末四碼|末4碼)[：:\s(（]*[0-9]{4}[)）]?/g, ' ');

  // 2. 擷取金額 (支援整數與 .00 小數格式，優先匹配消費/扣款/金額標籤與 NT$/TWD/新臺幣，並排除日期年份)
  let amount = 0;
  const amountPatterns = [
    /(?:消費金額|刷卡金額|交易金額|實際請款扣款|請款扣款|實際扣款|扣款金額|請款金額|授權金額|入帳金額|刷退金額|金額)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?(?![0-9]*[\/\-年月:])/i,
    /(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?(?![0-9]*[\/\-年:])/i,
    /(?<![0-9.])([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?\s*元/,
    /(?:消費|扣款|入帳|刷退|刷卡|授權)[：:\s]*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?(?![0-9]*[\/\-年月:])/i
  ];
  for (const pat of amountPatterns) {
    const m = textForAmount.match(pat);
    if (m && m[1]) {
      amount = parseInt(m[1].replace(/,/g, ''), 10);
      break;
    }
  }

  // 3. 擷取「原始消費日期（刷卡日）」、「通知/請款當日日期」與「精確刷卡時間 (HH:mm)」
  let originalTxDate = null;
  const origDateMatch = cleanText.match(/(?:原始交易日|原交易日|原消費日|原始消費日|刷卡日|消費日期|交易日期|交易日)[：:\s]*(\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?|\d{1,2}[\/\-月]\d{1,2}日?)/);
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

  let txTimeMinute = null;
  const timeMatch = cleanText.match(/(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?/);
  if (timeMatch) {
    const parts = timeMatch[0].split(':');
    txTimeMinute = `${String(parts[0]).padStart(2, '0')}:${String(parts[1]).padStart(2, '0')}`;
  }

  // 4. 擷取授權碼 (若有)
  let authCode = null;
  const authMatch = cleanText.match(/(?:授權碼|Auth\s*Code)[：:\s]*([A-Z0-9]{4,8})/i);
  if (authMatch) authCode = authMatch[1].toUpperCase();

  // 5. 擷取原始商店名稱 (優先提取「...」引號內店名，再提取結構化欄位或於/在...消費結構)
  const headerIgnoreRegex = /玉山|銀行|信用卡|簽帳|消費通知|刷卡通知|授權通知|扣款通知|請款通知|帳戶扣款|薪資入帳|交易通知|入帳通知|^一般消費$|^Apple\s*Pay(?:\s*感應刷卡)?$|^Apple\s*錢包$/i;
  let rawMerchant = '未知商店';
  const quoteMatches = [...cleanText.matchAll(/[「『]([^」』]+)[」』]/g)];
  for (const qm of quoteMatches) {
    const candidate = qm[1].trim();
    if (candidate && !headerIgnoreRegex.test(candidate)) {
      rawMerchant = candidate;
      break;
    }
  }

  if (rawMerchant === '未知商店') {
    const merchantPatterns = [
      /(?:特店名稱|商店名稱|特約商店|消費商店|請款商店|交易地點|消費地點|商家名稱|商家|請款扣款|商店)[：:\s]*([^」】\n，,。；;（(]+?)(?:\s*(?:消費金額|刷卡金額|交易金額|實際請款|一般消費|消費|刷卡|請款|扣款|授權|刷退|金額|NT\$|TWD|新[台臺]幣|\$|\d+元|$))/i,
      /(?:於|在)\s*(?:\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s*(?:於|在)?\s*)?([^」】\n，,。；;（(]+?)\s*(?:使用\s*Apple\s*Pay\s*)?(?:一般消費|刷卡消費|感應刷卡|刷卡|消費|請款|扣款|授權|刷退|金額|NT\$|TWD|新[台臺]幣)/i,
      /【([^】]+)】/
    ];
    for (const pat of merchantPatterns) {
      const m = cleanText.match(pat);
      if (m && m[1]) {
        const candidate = m[1].trim();
        if (candidate && !headerIgnoreRegex.test(candidate) && !/^\d{4}/.test(candidate)) {
          rawMerchant = candidate;
          break;
        }
      }
    }
  }
  if (rawMerchant === '未知商店' && channelType === 'SALARY_IN') {
    rawMerchant = '玉山薪資轉帳';
  }

  // 5.5 針對新版 iOS AI 捷徑或極簡 Apple Pay 交易文字（如「星巴克 NT$155」或「NT$155 麥當勞」）的智慧店名擷取兜底
  if (rawMerchant === '未知商店' && channelType === 'CHANNEL_A_AUTH') {
    const residual = cleanText
      .replace(/【[^】]*】/g, ' ')
      .replace(/\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?/g, ' ')
      .replace(/\d{1,2}[\/\-月]\d{1,2}日?/g, ' ')
      .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
      .replace(/(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)\s*[0-9,]+(?:\.[0-9]+)?\s*元?/gi, ' ')
      .replace(/[0-9,]+(?:\.[0-9]+)?\s*元/g, ' ')
      .replace(/(?:Apple\s*Pay|感應刷卡|一般消費|刷卡消費|消費通知|刷卡通知|交易通知|使用|您的|玉山銀行卡|玉山銀行|玉山信用卡|玉山簽帳金融卡|玉山簽帳卡|玉山Wallet|玉山\s*U\s*Bear|信用卡|簽帳金融卡|簽帳卡|綁定卡|末四碼\s*\d{4}|末4碼\s*\d{4})/gi, ' ')
      .replace(/[，,。；;：:（）()「」『』\[\]\-]+/g, ' ')
      .trim();
    const tokens = residual.split(/\s+/).filter(t => t && !/^\d+$/.test(t) && !headerIgnoreRegex.test(t));
    if (tokens.length > 0) {
      rawMerchant = tokens.slice(0, 2).join(' ');
    }
  }

  const normalizedMerchant = normalizeMerchant(rawMerchant);
  const classification = classifyTransaction(rawMerchant, normalizedMerchant, amount, cleanText);

  return {
    channelType,
    cardType,
    cardLast4,
    rawMerchant,
    normalizedMerchant,
    amount,
    txDate: originalTxDate || eventDate,
    originalTxDate, // null 代表通道 B 通知中未明確附帶原始刷卡日
    eventDate,
    txTimeMinute,
    authCode,
    reportedAvailableBalance,
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

function checkDebounceDuplicate(db, dedupeHash, nowIso, parsed = null) {
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

  // 進階跨管道防重（例如：Apple Pay 感應秒級入帳後，玉山推播或 Gmail 信件幾分鐘後才收進來；或具有相同 Email UID / 刷卡時間 HH:mm / 授權碼 AuthCode）
  if (parsed) {
    if (parsed.emailUid) {
      const logs = db.prepare('SELECT * FROM notification_logs ORDER BY id DESC LIMIT 100').all();
      const uidTag = `[UID:${parsed.emailUid}]`;
      const hitLog = logs.find(l => String(l.action_taken || '').includes(uidTag) || String(l.raw_text || '').includes(uidTag));
      if (hitLog) {
        return { isDuplicate: true, diffSeconds: 0, originalTxId: hitLog.linked_tx_id, reason: 'SAME_EMAIL_UID' };
      }
    }
    const candidates = db.prepare(`
      SELECT * FROM transactions
      WHERE status IN ('PENDING', 'TEMP_HOLD') AND is_reconciled_locked = 0
      ORDER BY tx_date ASC, tx_timestamp ASC, id ASC
    `).all();
    for (const tx of candidates) {
      if (tx.tx_date !== parsed.txDate || Number(tx.auth_amount) !== Number(parsed.amount)) continue;
      const sim = computeMerchantSimilarity(tx.normalized_merchant, parsed.normalizedMerchant);
      if (sim < 0.7) continue;

      if (parsed.authCode && tx.auth_code && parsed.authCode === tx.auth_code) {
        return { isDuplicate: true, diffSeconds: 0, originalTxId: tx.id, reason: 'SAME_AUTH_CODE' };
      }
      if (parsed.txTimeMinute && tx.channel_a_raw && tx.channel_a_raw.includes(parsed.txTimeMinute)) {
        return { isDuplicate: true, diffSeconds: 0, originalTxId: tx.id, reason: 'SAME_TX_TIME_MINUTE' };
      }
      // Apple Pay + 銀行雙重通道 A 防重：若其中一筆為 Apple Pay 感應紀錄，且另一筆為 30 分鐘內的銀行同店同金額刷卡通知，自動視為同一筆消費不重複扣款
      const existingIsApplePay = /APPLE\s*PAY|感應刷卡/i.test(`${tx.channel_a_raw || ''} ${tx.reconcile_note || ''}`);
      if (existingIsApplePay !== Boolean(parsed.isApplePay)) {
        const txTimeMs = new Date(tx.tx_timestamp || tx.created_at || nowIso).getTime();
        if (Math.abs(nowMs - txTimeMs) <= 30 * 60 * 1000) {
          return { isDuplicate: true, diffSeconds: Math.round(Math.abs(nowMs - txTimeMs) / 1000), originalTxId: tx.id, reason: 'APPLE_PAY_BANK_MERGED' };
        }
      }
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
  if (options.emailUid) {
    parsed.emailUid = String(options.emailUid);
  }
  const uidSuffix = parsed.emailUid ? ` [UID:${parsed.emailUid}]` : '';
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

  // 情境 3：通道 A（第 1 次通知：簽帳金融卡消費 / 授權圈存 / 信用卡刷卡）
  if (parsed.channelType === 'CHANNEL_A_AUTH') {
    const debounce = checkDebounceDuplicate(db, dedupeHash, nowIso, parsed);
    if (debounce.isDuplicate) {
      const ignoreMsg = `🛡️ 防重複扣款鎖觸發：與既有「${parsed.normalizedMerchant} $${parsed.amount}」為同一筆刷卡通知，已自動忽略不重複扣款！${uidSuffix}`;
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
    const cardLabel = parsed.isApplePay
      ? '🍎 Apple Pay 感應刷卡'
      : (parsed.cardType === 'CREDIT' ? '信用卡刷卡' : '簽帳卡圈存');
    let reconcileNote = `${cardLabel}（已立即從當月可用安全預算精準扣除 $${parsed.amount}）${uidSuffix}`;

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
  const hasBankOrCard = /玉山|E\.?SUN|信用卡|簽帳金融卡|簽帳卡|消費通知|刷卡|帳戶扣款|請款|薪資入帳|薪資轉帳/i.test(t);
  const hasAmount = /(?:NT\$|TWD|新[台臺]幣|\$)\s*[0-9,]+|[0-9,]+\s*元/i.test(t);
  return hasBankOrCard && hasAmount;
}

function buildGoogleAppsScriptCode(webhookUrl) {
  const targetUrl = webhookUrl || 'https://anti-broke-finance-app.mr-haibaoseal.workers.dev/api/notifications/webhook';
  return `// ============================================================================
// 🛡️ 防破產記帳系統 — Gmail 刷卡通知 24 小時雲端全自動偵測腳本 (Google Apps Script)
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
  const query = 'newer_than:3d (玉山 OR esunbank OR 信用卡消費 OR 簽帳金融卡 OR 刷卡消費 OR 帳戶扣款 OR 薪資入帳)';
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
const { processBankNotification, resolveGasTempHoldManually, markTransactionCanceled, scanGhostHolds } = require('../services/reconciliationEngine');
const { getHighRiskModeStatus, evaluateImpulsePurchase, getCooldownCartSummary, fastForwardCooldownItem, resolveCooldownItem, getVampireAndSubscriptionRadar } = require('../services/impulseControlService');
const { splitTransactionBill, settleSplitBill, getSplitBillsSummary, getWalletTankStatus, quickAdjustWalletTank, auditWalletTank, syncEsunAvailableBalance, splitUnknownGapTransaction } = require('../services/accountingPatchService');
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

  let directText = body.text || body.rawText || body.message || body.notification || body.body || body.input || body.content || body.transaction || body[''] || getParam('text') || getParam('message') || getParam('input') || '';

  if (body && typeof body === 'object') {
    const extraVals = Object.entries(body)
      .filter(([k, v]) => k !== '_clientState' && k !== 'source' && k !== 'timestamp' && k !== 'referenceDate' && k !== 'emailUid' && (typeof v === 'string' || typeof v === 'number'))
      .map(([, v]) => String(v).trim())
      .filter(Boolean);
    if (extraVals.length > 0 && (!directText || extraVals.length > 1)) {
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

function buildStructuredApplePayText(body = {}, searchParams = null) {
  const getParam = key => (searchParams && typeof searchParams.get === 'function') ? searchParams.get(key) : null;
  const merchant = String(body.merchant || body.store || body.shop || body.name || body.商家 || body.商店 || body.名稱 || getParam('merchant') || getParam('store') || getParam('name') || '').trim();
  const rawAmt = String(body.amount ?? body.money ?? body.price ?? body.金額 ?? getParam('amount') ?? getParam('price') ?? '').trim();
  const card = String(body.card || body.cardName || body.pass || body.卡片 || body.票卡 || getParam('card') || 'Apple Pay 綁定卡').trim();

  if (merchant && rawAmt) {
    const numMatch = rawAmt.replace(/,/g, '').match(/(\d+)(?:\.\d+)?/);
    const cleanAmt = numMatch ? numMatch[1] : '0';
    const refDt = body.timestamp ? new Date(body.timestamp) : new Date();
    const dateStr = body.referenceDate
      ? String(body.referenceDate).slice(0, 10).replace(/-/g, '/')
      : `${refDt.getFullYear()}/${String(refDt.getMonth() + 1).padStart(2, '0')}/${String(refDt.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(refDt.getHours()).padStart(2, '0')}:${String(refDt.getMinutes()).padStart(2, '0')}`;
    return `【Apple Pay 感應刷卡】您的 ${card} 於 ${dateStr} ${timeStr} 在「${merchant}」使用 Apple Pay 一般消費 NT$${cleanAmt} 元。`;
  }

  const directText = extractAnyBodyText(body, searchParams);
  if (directText && !/Apple\s*Pay/i.test(directText)) {
    return `【Apple Pay 感應刷卡】${directText}`;
  }
  return directText;
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

  // 1A. Apple Pay 感應刷卡專屬秒級自動入帳端點 (支援 iOS 捷徑「交易 Transaction」自動化 GET 網址參數或 POST JSON)
  if ((method === 'GET' || method === 'POST') && pathname === '/api/notifications/apple-pay') {
    const applePayText = buildStructuredApplePayText(body, searchParams);
    const result = processBankNotification(db, applePayText, {
      source: body.source || 'apple_pay_auto',
      timestamp: body.timestamp || new Date().toISOString(),
      referenceDate: body.referenceDate
    });
    return { status: 200, data: { ok: true, result, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 1B. 銀行與信用卡刷卡通知全自動接收與解析 (支援 GET/POST Webhook、Apple Pay、Google Apps Script、Email MIME 與批次陣列)
  if ((method === 'GET' || method === 'POST') && (pathname === '/api/notifications/parse' || pathname === '/api/notifications/webhook' || pathname === '/api/notifications/batch')) {
    const source = pathname.endsWith('/webhook')
      ? (body.source || 'auto_webhook')
      : (pathname.endsWith('/batch') ? (body.source || 'auto_batch_webhook') : (body.source || 'manual_ui'));

    const batchList = Array.isArray(body.notifications)
      ? body.notifications
      : (Array.isArray(body.messages) ? body.messages : null);

    if (batchList && batchList.length > 0) {
      const results = [];
      for (const item of batchList) {
        const itemObj = typeof item === 'string' ? { text: item } : (item || {});
        const text = itemObj.rawEmail
          ? decodeEmailMimeToText(itemObj.rawEmail)
          : ((itemObj.merchant && itemObj.amount) ? buildStructuredApplePayText(itemObj) : extractAnyBodyText(itemObj));
        if (!String(text).trim()) continue;
        try {
          const r = processBankNotification(db, text, {
            source: itemObj.source || source,
            emailUid: itemObj.emailUid || itemObj.messageId || itemObj.uid,
            timestamp: itemObj.timestamp || new Date().toISOString(),
            referenceDate: itemObj.referenceDate || body.referenceDate
          });
          results.push(r);
        } catch (_) {}
      }
      return {
        status: 200,
        data: {
          ok: true,
          processedCount: results.length,
          results,
          result: results[results.length - 1] || null,
          dashboard: buildFullDashboardSnapshot(db)
        }
      };
    }

    const rawText = body.rawEmail
      ? decodeEmailMimeToText(body.rawEmail)
      : ((body.merchant && body.amount)
          ? buildStructuredApplePayText(body, searchParams)
          : extractAnyBodyText(body, searchParams));
    const result = processBankNotification(db, rawText, {
      source,
      emailUid: body.emailUid || body.messageId || body.uid,
      timestamp: body.timestamp || new Date().toISOString(),
      referenceDate: body.referenceDate
    });
    return { status: 200, data: { ok: true, result, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 2. Gmail IMAP 主動與背景自動掃描
  if (method === 'POST' && pathname === '/api/notifications/gmail-poll') {
    const imapRes = await pollEsunEmailsViaImap(db);
    return { status: 200, data: { ok: true, imap: imapRes, dashboard: buildFullDashboardSnapshot(db) } };
  }

  // 3. 薪資設定與跨專案班表全自動同步 (支援 shift-pay-app 即時自動推送、外部目錄自動掃描、或手動微調)
  if (method === 'POST' && (pathname === '/api/shift/sync' || pathname === '/api/shift/webhook')) {
    const cycle = syncCycleWithShiftData(db, {
      rawJsonPayload: body.rawJsonPayload || body.shiftState || body.payload || null,
      manualNetSalary: body.manualNetSalary,
      manualGrossPay: body.manualGrossPay,
      manualHourlyWage: body.manualHourlyWage,
      isAutoSync: Boolean(body.autoSync),
      referenceDateStr: body.referenceDate || null
    });
    const effective = cycle.is_salary_settled && cycle.actual_salary !== null ? cycle.actual_salary : cycle.estimated_net_pay;
    return {
      status: 200,
      data: {
        ok: true,
        message: `✅ 已自動同步本月薪資與班表！目前可用薪資預算 $${effective.toLocaleString()}（時薪 $${cycle.hourly_wage}）`,
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
