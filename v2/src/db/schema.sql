PRAGMA foreign_keys = ON;

-- 1. 系統與週期參數設定表
CREATE TABLE IF NOT EXISTS user_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payday_day INTEGER NOT NULL DEFAULT 10,
  default_hourly_wage INTEGER NOT NULL DEFAULT 200,
  net_pay_factor REAL NOT NULL DEFAULT 0.95,
  labor_health_deduction INTEGER NOT NULL DEFAULT 0,
  dedupe_window_minutes INTEGER NOT NULL DEFAULT 10,
  last_known_bank_balance INTEGER NOT NULL DEFAULT 0,
  force_high_risk_mode INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- 2. 發薪週期與單一權威預算表 (base_budget 僅由使用者手動設定或手動帶入，絕不被存款或班表自動覆蓋)
CREATE TABLE IF NOT EXISTS budget_cycles (
  cycle_key TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  base_budget INTEGER NOT NULL DEFAULT 0,
  budget_note TEXT NOT NULL DEFAULT '手動設定',
  updated_at TEXT NOT NULL
);

-- 3. 核心帳務分流明細表 (徹底取代舊版 transactions，支援完整雙向回滾與編輯)
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_key TEXT NOT NULL,
  flow_type TEXT NOT NULL DEFAULT 'EXPENSE',
  payment_medium TEXT NOT NULL DEFAULT 'DIGITAL_BANK',
  dedupe_status TEXT NOT NULL DEFAULT 'CONFIRMED',
  dedupe_fingerprint TEXT DEFAULT NULL,
  raw_merchant TEXT NOT NULL,
  normalized_merchant TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '一般消費',
  card_last4 TEXT DEFAULT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  budget_impact_amount INTEGER NOT NULL DEFAULT 0,
  cash_delta INTEGER NOT NULL DEFAULT 0,
  easycard_delta INTEGER NOT NULL DEFAULT 0,
  tx_date TEXT NOT NULL,
  tx_timestamp TEXT NOT NULL,
  source_channel TEXT NOT NULL DEFAULT 'manual',
  note TEXT NOT NULL DEFAULT '',
  raw_payload TEXT DEFAULT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_cycle_flow ON ledger_entries(cycle_key, flow_type, dedupe_status);
CREATE INDEX IF NOT EXISTS idx_ledger_dedupe ON ledger_entries(dedupe_fingerprint, tx_timestamp);

-- 4. 入帳與防重複日誌表
CREATE TABLE IF NOT EXISTS ingestion_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_channel TEXT NOT NULL,
  dedupe_fingerprint TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL DEFAULT 0,
  normalized_merchant TEXT NOT NULL DEFAULT '',
  action_taken TEXT NOT NULL,
  linked_entry_id INTEGER DEFAULT NULL,
  raw_text TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- 5. 朋友聚餐拆帳與應收代墊款池
CREATE TABLE IF NOT EXISTS split_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_entry_id INTEGER NOT NULL,
  debtor_name TEXT NOT NULL DEFAULT '朋友',
  total_amount INTEGER NOT NULL,
  self_amount INTEGER NOT NULL,
  receivable_amount INTEGER NOT NULL,
  is_repaid INTEGER NOT NULL DEFAULT 0,
  repaid_entry_id INTEGER DEFAULT NULL,
  created_at TEXT NOT NULL,
  repaid_at TEXT DEFAULT NULL,
  FOREIGN KEY (ledger_entry_id) REFERENCES ledger_entries(id) ON DELETE CASCADE
);

-- 6. 實體水庫 (皮包現金 & 悠遊卡) 與異動日誌
CREATE TABLE IF NOT EXISTS wallet_tank (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cash_balance INTEGER NOT NULL DEFAULT 0,
  easycard_balance INTEGER NOT NULL DEFAULT 0,
  last_audit_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_tank_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tank_type TEXT NOT NULL,
  delta_amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  note TEXT NOT NULL,
  linked_entry_id INTEGER DEFAULT NULL,
  created_at TEXT NOT NULL
);

-- 7. 每月固定扣款與訂閱守門員
CREATE TABLE IF NOT EXISTS fixed_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  expense_type TEXT NOT NULL DEFAULT 'FIXED',
  monthly_amount INTEGER NOT NULL,
  billing_day INTEGER NOT NULL DEFAULT 15,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 8. 72 小時防衝動冷卻購物車
CREATE TABLE IF NOT EXISTS cooldown_cart (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  item_type TEXT NOT NULL DEFAULT 'WANT',
  work_hours_equivalent REAL NOT NULL DEFAULT 0,
  daily_budget_before INTEGER NOT NULL DEFAULT 0,
  daily_budget_after INTEGER NOT NULL DEFAULT 0,
  tier_before TEXT NOT NULL DEFAULT '',
  tier_after TEXT NOT NULL DEFAULT '',
  ai_roast_message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'COOLING',
  created_at TEXT NOT NULL,
  unlock_at TEXT NOT NULL,
  resolved_at TEXT DEFAULT NULL
);

-- 9. 玉山可用餘額校正歷史表
CREATE TABLE IF NOT EXISTS balance_sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expected_digital_balance INTEGER NOT NULL,
  actual_bank_balance INTEGER NOT NULL,
  discrepancy_amount INTEGER NOT NULL,
  generated_gap_entry_id INTEGER DEFAULT NULL,
  note TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL
);
