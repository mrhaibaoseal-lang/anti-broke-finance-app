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

