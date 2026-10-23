PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payday_day INTEGER NOT NULL DEFAULT 10,
  net_pay_factor REAL NOT NULL DEFAULT 0.95,
  labor_health_deduction INTEGER NOT NULL DEFAULT 0,
  default_hourly_wage INTEGER NOT NULL DEFAULT 200,
  shift_app_path TEXT NOT NULL DEFAULT 'C:\Users\mrhai\.gemini\antigravity\scratch\shift-pay-app',
  last_known_bank_balance INTEGER NOT NULL DEFAULT 0,
  force_high_risk_mode INTEGER NOT NULL DEFAULT 0,
  llm_api_key TEXT NOT NULL DEFAULT '',
  gmail_user TEXT NOT NULL DEFAULT '',
  gmail_app_password TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS income_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_key TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  target_shift_month TEXT NOT NULL,
  shift_gross_pay INTEGER NOT NULL DEFAULT 0,
  normal_hours REAL NOT NULL DEFAULT 0,
  ot_minutes INTEGER NOT NULL DEFAULT 0,
  bonus_pay INTEGER NOT NULL DEFAULT 0,
  hourly_wage INTEGER NOT NULL DEFAULT 200,
  estimated_net_pay INTEGER NOT NULL DEFAULT 0,
  actual_salary INTEGER DEFAULT NULL,
  is_salary_settled INTEGER NOT NULL DEFAULT 0,
  shift_sync_source TEXT NOT NULL DEFAULT 'init',
  raw_shift_payload TEXT DEFAULT NULL,
  last_synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_key TEXT NOT NULL,
  status TEXT NOT NULL,
  raw_merchant TEXT NOT NULL,
  normalized_merchant TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '一般消費',
  auth_amount INTEGER NOT NULL DEFAULT 0,
  settled_amount INTEGER DEFAULT NULL,
  fx_fee_diff INTEGER NOT NULL DEFAULT 0,
  effective_amount INTEGER NOT NULL DEFAULT 0,
  personal_amount INTEGER NOT NULL DEFAULT 0,
  tx_date TEXT NOT NULL,
  tx_timestamp TEXT NOT NULL,
  settled_at TEXT DEFAULT NULL,
  auth_code TEXT DEFAULT NULL,
  is_reconciled_locked INTEGER NOT NULL DEFAULT 0,
  reconcile_score REAL DEFAULT NULL,
  reconcile_note TEXT DEFAULT NULL,
  is_foreign_tx INTEGER NOT NULL DEFAULT 0,
  is_ghost_alerted INTEGER NOT NULL DEFAULT 0,
  channel_a_raw TEXT DEFAULT NULL,
  channel_b_raw TEXT DEFAULT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_status_lock ON transactions(status, is_reconciled_locked, tx_date);
CREATE INDEX IF NOT EXISTS idx_tx_cycle ON transactions(cycle_key, status);

CREATE TABLE IF NOT EXISTS notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'manual',
  channel_type TEXT NOT NULL,
  normalized_merchant TEXT DEFAULT '',
  amount INTEGER DEFAULT 0,
  dedupe_hash TEXT DEFAULT '',
  action_taken TEXT NOT NULL,
  linked_tx_id INTEGER DEFAULT NULL,
  raw_text TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notif_dedupe ON notification_logs(dedupe_hash, received_at);

CREATE TABLE IF NOT EXISTS split_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL,
  total_amount INTEGER NOT NULL,
  self_amount INTEGER NOT NULL,
  receivable_amount INTEGER NOT NULL,
  debtor_name TEXT NOT NULL,
  is_repaid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  repaid_at TEXT DEFAULT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cooldown_cart (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  item_type TEXT NOT NULL DEFAULT 'WANT',
  work_hours_equivalent REAL NOT NULL DEFAULT 0,
  work_time_text TEXT NOT NULL DEFAULT '',
  daily_budget_before INTEGER NOT NULL DEFAULT 0,
  daily_budget_after INTEGER NOT NULL DEFAULT 0,
  tier_before TEXT NOT NULL DEFAULT '',
  tier_after TEXT NOT NULL DEFAULT '',
  ai_roast_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  unlock_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'COOLING',
  resolved_at TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS fixed_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  expense_type TEXT NOT NULL DEFAULT 'FIXED',
  monthly_amount INTEGER NOT NULL,
  billing_day INTEGER NOT NULL DEFAULT 15,
  total_installments INTEGER DEFAULT NULL,
  remaining_installments INTEGER DEFAULT NULL,
  note TEXT DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_tank (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  easycard_balance INTEGER NOT NULL DEFAULT 0,
  cash_balance INTEGER NOT NULL DEFAULT 0,
  last_audit_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_tank_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tank_type TEXT NOT NULL,
  delta_amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  note TEXT NOT NULL,
  linked_tx_id INTEGER DEFAULT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS balance_sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_expected_balance INTEGER NOT NULL,
  actual_esun_balance INTEGER NOT NULL,
  discrepancy_amount INTEGER NOT NULL,
  generated_gap_tx_id INTEGER DEFAULT NULL,
  note TEXT DEFAULT '',
  synced_at TEXT NOT NULL
);
