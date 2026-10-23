# 🛡️ 餘額守門員 GuardPay v2 — 全新重構架構與規格書 (REFACTOR_PLAN)

> **狀態**：階段三（架構與規格確認）  
> **核心目標**：徹底掃除舊版修補痕跡、殭屍狀態機、假 SQLite 引擎與混亂的預算/轉帳邏輯，建立高內聚、低耦合、帳務絕對精準的 GuardPay v2。

---

## 一、 核心設計哲學與舊版問題根治對照

| 舊版痛點 (`_legacy`) | 新版解決方案 (`v2`) |
| :--- | :--- |
| **多重預算來源打架**：ATM 存款或班表變動會自動覆蓋當月總預算 | **單一權威預算源 (`base_budget`)**：每月起始數位預算僅能由使用者「手動設定/確認」或於試算後「手動點擊帶入」，任何存款或排班變動**嚴禁自動覆蓋**。 |
| **圈存/請款殭屍狀態機**：半廢除的 `PENDING`/`TEMP_HOLD`/`AUTH_VERIFY` 殘留於 DB 與 UI | **全面單一確認制**：徹底移除圈存、請款、加油預授權、幽靈圈存雷達；所有消費入帳皆為乾淨的已確認紀錄，僅聚焦 **Apple Pay 捷徑** 與 **轉帳/存款解析**。 |
| **多通道撞車與重複入帳**：Gmail IMAP、剪貼簿偷讀、銀行重複推播導致同一筆帳記兩次 | **收斂通道 + 雙層防重複引擎 (Deduplication)**：砍除 Gmail IMAP/GAS 與剪貼簿自動讀取；後端實作 **10 分鐘智慧指紋去重鎖**（自動攔截或標記為 `SUSPECTED_DUPLICATE` 待確認）。 |
| **轉帳、代墊、提款、還款混為一談**：內部互轉被當成消費、朋友還款亂加進總預算 | **資金流向徹底分流 (`flow_type`)**：在資料表層級嚴格區分 `EXPENSE`、`INTERNAL_TRANSFER`、`ADVANCE_OUT`、`ADVANCE_IN`、`INCOME_DEPOSIT`、`UNKNOWN_GAP`。 |
| **數位預算與皮包現金混算**：提款或存現時發生重複扣款或額度虛增 | **三大核心指標獨立並排顯示**：1. 💳 本月數位可用預算（決定四級生存狀態） 2. 💵 實體水庫總額（現金＋悠遊卡） 3. 💰 最終總可用剩餘（1 + 2 總和）。 |
| **手寫 Regex 假 SQLite (`portableDb.js`) 與 `_clientState` 整包同步** | **標準 Repository 架構**：統一使用標準 SQL Repository 層（同時支援本機 `node:sqlite` 與 Cloudflare 原生 `D1`），前端僅負責 UI 渲染與 REST API 呼叫。 |
| **硬編碼店名前綴與分類規則、1,650 行單一 `app.js` 巨型檔案** | **字典檔抽離 + 前後端 ES 模組化**：商店正規化前綴與分類關鍵字抽離至 `src/config/merchantRules.js`；前端按 5 大分頁拆分為獨立 ES Modules。 |

---

## 二、 全新目錄結構與模組劃分 (`./v2`)

採用 **「設定檔 (Config) ➔ 資料存取層 (Repositories) ➔ 領域服務層 (Services) ➔ 路由層 (Routes) ➔ 模組化前端 (Frontend Modules)」** 的五層清晰架構：

```text
v2/
├── package.json
├── wrangler.jsonc                   # Cloudflare Workers + 原生 D1 綁定設定
├── REFACTOR_PLAN.md                 # 本架構與規格說明書
├── data/
│   └── guardpay_v2.sqlite           # 本機開發 SQLite 資料庫檔案 (自動生成)
├── src/
│   ├── server.js                    # 本機 Node.js HTTP 伺服器入口 (無背景亂抓信排程)
│   ├── worker.js                    # Cloudflare Workers 無伺服器入口
│   ├── config/                      # 【設定與字典層】零業務邏輯，純常數與規則表
│   │   ├── constants.js             # 生存四級門檻、高風險時段、去重時間窗(10m)、吸血鬼門檻等常數
│   │   └── merchantRules.js         # 第三方支付前綴詞表(連加*、街口*等)、標準化店名字典、自動分類關鍵字
│   ├── db/                          # 【資料庫底層】
│   │   ├── schema.sql               # v2 乾淨關聯式 Schema (相容 SQLite 與 Cloudflare D1)
│   │   └── dbAdapter.js             # 統一非同步 DB 介面 (封裝 node:sqlite 與 Cloudflare D1)
│   ├── repositories/                # 【標準資料存取層 (Repository)】純 SQL 操作，不混雜業務判斷
│   │   ├── settingsRepo.js          # 系統與週期參數設定 CRUD
│   │   ├── cycleRepo.js             # 發薪週期與起始預算 CRUD
│   │   ├── ledgerRepo.js            # 帳務明細 (消費/轉帳/代墊/存款/黑洞) 查詢與寫入
│   │   ├── dedupeRepo.js            # 10 分鐘防重複指紋查詢與紀錄
│   │   ├── splitBillRepo.js         # 朋友聚餐拆帳與應收代墊款池 CRUD
│   │   ├── walletTankRepo.js        # 皮包現金與悠遊卡水庫餘額及異動日誌 CRUD
│   │   └── impulseRepo.js           # 72h 冷卻購物車與每月固定扣款/訂閱 CRUD
│   ├── services/                    # 【核心領域服務層 (Domain Services)】高內聚商業邏輯
│   │   ├── budgetEngine.js          # 數位預算、實體水庫、總可用剩餘、四級生存狀態與破產倒數計算
│   │   ├── merchantClassifier.js    # 讀取 merchantRules.js 進行店名正規化與消費分類推斷
│   │   ├── ingestionService.js      # Apple Pay / 轉帳 OCR 入帳、10分鐘去重引擎、資金流向分流器
│   │   ├── splitAndTankService.js   # 朋友拆帳/還款沖銷、現金/悠遊卡水庫連動、玉山餘額校正與黑洞拆分
│   │   ├── impulseService.js        # AI 靈魂拷問、工時換算、72h 冷卻池、高風險模式、吸血鬼雷達、固定扣款提醒
│   │   └── shiftBridgeService.js    # 與 shift-pay 解耦之單向試算解析器 (僅供手動點擊帶入預算)
│   └── routes/                      # 【REST API 路由層】按領域拆分，取代舊版單一巨型 api.js
│       ├── router.js                # 輕量路由分發與統一錯誤/回應格式封裝
│       ├── dashboardRoutes.js       # GET /api/dashboard (聚合前端所需狀態)
│       ├── ledgerRoutes.js          # POST /api/webhook/apple-pay, /api/webhook/transfer, 手動記帳, 重複確認, 刪除
│       ├── budgetRoutes.js          # PUT /api/budget/cycle, PUT /api/settings, POST /api/fixed-expenses
│       ├── walletRoutes.js          # POST /api/wallet/adjust, /api/wallet/audit, /api/splits, /api/balance/sync
│       └── impulseRoutes.js         # POST /api/impulse/evaluate, /api/cooldown/:id/resolve, /api/dev/fast-forward
├── public/                          # 【前端靜態資源】
│   ├── index.html                   # 乾淨語意化 HTML 骨架 (5 分頁 + Bottom Sheets，無隱藏垃圾節點)
│   ├── shift-pay.html               # 獨立打工薪水試算工具 (僅單向提供手動帶入，不背景同步覆蓋)
│   ├── manifest.json                # PWA 設定檔
│   ├── icons/                       # 應用圖示
│   ├── css/
│   │   ├── tokens.css               # Apple Dark Mode 色彩、圓角、陰影、8px 間距與字體 CSS 變數
│   │   └── components.css           # Bento 卡片、四級微光(.tier-glow-*)、高風險暗紅主題、膠囊標籤、抽屜動畫
│   └── js/                          # 【原生 ES Modules 模組化前端】
│       ├── main.js                  # 應用啟動、分頁切換、全域事件綁定
│       ├── apiClient.js             # 標準 REST fetch 封裝 (無 _clientState 快照夾帶)
│       ├── store.js                 # 前端單向狀態管理與局部渲染觸發
│       ├── utils/
│       │   └── formatters.js        # 金額格式化、HTML 跳脫、台灣時區日期工具
│       └── views/
│           ├── homeView.js          # 分頁 1：首頁 (三大資產並排卡片、生存等級、破產預警、快捷行動)
│           ├── walletView.js        # 分頁 2：錢包 (現金/悠遊卡水庫、代墊應收池、玉山餘額校正)
│           ├── recordsView.js       # 分頁 3：明細 (依資金流向篩選、疑似重複確認橫幅、黑洞拆分、拆帳)
│           ├── impulseView.js       # 分頁 4：防剁 (衝動急救彈窗、省錢戰績榜、72h 冷卻清單)
│           ├── settingsView.js      # 分頁 5：設定 (起始預算設定、班表手動帶入、固定扣款、吸血鬼雷達、開發測試區)
│           └── modals.js            # 統一管理 Bottom Sheet 彈窗與浮動 Toast 提示
└── tests/
    └── guardpay.test.js             # 涵蓋 10 分鐘去重、轉帳/代墊分流、三大資產計算與水庫回滾之完整單元測試
```

---

## 三、 全新資料庫 Schema 設計 (`src/db/schema.sql`)

徹底清除舊版 `auth_amount`、`settled_amount`、`is_reconciled_locked`、`channel_a_raw` 等圈存對帳殘骸，建立職責單一的 8 張資料表：

### 1. `user_settings`（系統參數設定表）
```sql
CREATE TABLE IF NOT EXISTS user_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payday_day INTEGER NOT NULL DEFAULT 10,              -- 每月發薪結算日 (1~28)
  default_hourly_wage INTEGER NOT NULL DEFAULT 200,    -- 換算血汗工時用之時薪
  net_pay_factor REAL NOT NULL DEFAULT 0.95,           -- 班表試算實領折數 (僅供試算帶入參考)
  labor_health_deduction INTEGER NOT NULL DEFAULT 0,   -- 勞健保自付額 (僅供試算帶入參考)
  dedupe_window_minutes INTEGER NOT NULL DEFAULT 10,   -- 防重複入帳時間窗 (預設 10 分鐘)
  last_known_bank_balance INTEGER NOT NULL DEFAULT 0,  -- 最近一次玉山帳戶可用餘額參考值
  force_high_risk_mode INTEGER NOT NULL DEFAULT 0,     -- 手動強制開啟高風險防禦模式 (0/1)
  updated_at TEXT NOT NULL
);
```

### 2. `budget_cycles`（發薪週期與單一權威預算表）
> **關鍵改良**：`base_budget` 為該週期唯一權威的「本月數位起始預算」，只由使用者手動設定或從班表試算手動點擊帶入，**絕不被 ATM 存款或背景程式自動覆寫**。

```sql
CREATE TABLE IF NOT EXISTS budget_cycles (
  cycle_key TEXT PRIMARY KEY,                          -- 格式: '2026-10-10_2026-11-09'
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  base_budget INTEGER NOT NULL DEFAULT 0,              -- 手動設定/確認之本月起始數位預算
  budget_note TEXT NOT NULL DEFAULT '',                -- 預算來源備註 (如: '手動設定' / '自10月班表試算帶入')
  updated_at TEXT NOT NULL
);
```

### 3. `ledger_entries`（核心帳務分流明細表 — 取代舊版 `transactions`）
> **關鍵改良**：透過 `flow_type`（資金流向）、`payment_medium`（支付媒介）與 `budget_impact_amount`（對數位預算的實際扣減額），將「一般消費」、「內部互轉」、「朋友代墊/還款」、「外部存款」與「待查黑洞」徹底分流。

```sql
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_key TEXT NOT NULL,
  
  -- 【核心分流欄位】
  -- 'EXPENSE'           : 一般消費支出 (Apple Pay / 轉帳消費 / 現金消費)
  -- 'INTERNAL_TRANSFER' : 內部互轉調度 (ATM提款領現 / 悠遊卡加值 / 自己帳戶互轉 / 皮包現金存回ATM)
  -- 'ADVANCE_OUT'       : 幫朋友代墊支出 (不扣個人預算，進應收池)
  -- 'ADVANCE_IN'        : 朋友還款轉入 (不加進個人預算，沖銷應收池)
  -- 'INCOME_DEPOSIT'    : 外部存款 / 薪資入帳 (僅記錄或手動選擇是否追加預算，絕不覆蓋 base_budget)
  -- 'UNKNOWN_GAP'       : 玉山餘額校正產生的未知漏帳黑洞 (可事後拆分為 EXPENSE)
  flow_type TEXT NOT NULL DEFAULT 'EXPENSE',

  -- 支付或收付媒介: 'DIGITAL_BANK' (金融卡/Apple Pay/網銀) | 'CASH' (皮包現金) | 'EASYCARD' (悠遊卡)
  payment_medium TEXT NOT NULL DEFAULT 'DIGITAL_BANK',

  -- 防重複狀態: 'CONFIRMED' (正常入帳) | 'SUSPECTED_DUPLICATE' (10分鐘內疑似重複待確認，暫不扣預算)
  dedupe_status TEXT NOT NULL DEFAULT 'CONFIRMED',
  dedupe_fingerprint TEXT DEFAULT NULL,

  raw_merchant TEXT NOT NULL,
  normalized_merchant TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '一般消費',
  card_last4 TEXT DEFAULT NULL,                        -- 卡號或轉帳帳號末四碼 (供去重比對)

  -- 【金額與精準帳務影響值】
  amount INTEGER NOT NULL DEFAULT 0,                   -- 交易帳面總金額 (恆為正整數)
  budget_impact_amount INTEGER NOT NULL DEFAULT 0,     -- 對「💳 本月數位可用預算」的實際扣減值 (內部互轉/代墊/還款/純花現金皆為 0)
  cash_delta INTEGER NOT NULL DEFAULT 0,               -- 對「皮包現金水庫」的增減值 (如 ATM 提款為 +1000，花現金為 -100)
  easycard_delta INTEGER NOT NULL DEFAULT 0,           -- 對「悠遊卡水庫」的增減值 (如自動加值為 +500)

  tx_date TEXT NOT NULL,                               -- YYYY-MM-DD (台灣時間)
  tx_timestamp TEXT NOT NULL,                          -- ISO 時間戳
  source_channel TEXT NOT NULL DEFAULT 'manual',       -- 'apple_pay_webhook' | 'transfer_ocr' | 'manual_paste' | 'manual_form'
  note TEXT NOT NULL DEFAULT '',
  raw_payload TEXT DEFAULT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_cycle_flow ON ledger_entries(cycle_key, flow_type, dedupe_status);
CREATE INDEX IF NOT EXISTS idx_ledger_dedupe ON ledger_entries(dedupe_fingerprint, tx_timestamp);
```

### 4. `ingestion_logs`、`split_bills`、`wallet_tank`、`fixed_expenses`、`cooldown_cart`
```sql
CREATE TABLE IF NOT EXISTS ingestion_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_channel TEXT NOT NULL,
  dedupe_fingerprint TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  normalized_merchant TEXT NOT NULL DEFAULT '',
  action_taken TEXT NOT NULL,                          -- 'ACCEPTED' | 'BLOCKED_DUPLICATE' | 'FLAGGED_SUSPECTED' | 'IGNORED_CARD_NOTIF'
  linked_entry_id INTEGER DEFAULT NULL,
  raw_text TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS split_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_entry_id INTEGER NOT NULL,
  debtor_name TEXT NOT NULL DEFAULT '朋友',
  total_amount INTEGER NOT NULL,
  self_amount INTEGER NOT NULL,                        -- 自己負擔金額
  receivable_amount INTEGER NOT NULL,                  -- 應收代墊金額 (不扣個人預算)
  is_repaid INTEGER NOT NULL DEFAULT 0,                -- 0: 未收訖, 1: 已收訖沖銷
  repaid_entry_id INTEGER DEFAULT NULL,                -- 關聯沖銷的 ADVANCE_IN 轉帳紀錄 ID
  created_at TEXT NOT NULL,
  repaid_at TEXT DEFAULT NULL,
  FOREIGN KEY (ledger_entry_id) REFERENCES ledger_entries(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS wallet_tank (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cash_balance INTEGER NOT NULL DEFAULT 0,
  easycard_balance INTEGER NOT NULL DEFAULT 0,
  last_audit_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_tank_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tank_type TEXT NOT NULL,                             -- 'CASH' | 'EASYCARD'
  delta_amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  note TEXT NOT NULL,
  linked_entry_id INTEGER DEFAULT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fixed_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  expense_type TEXT NOT NULL DEFAULT 'FIXED',          -- 'FIXED' | 'SUBSCRIPTION' (前3天提醒)
  monthly_amount INTEGER NOT NULL,
  billing_day INTEGER NOT NULL DEFAULT 15,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

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
  status TEXT NOT NULL DEFAULT 'COOLING',              -- 'COOLING' | 'ABANDONED' | 'PURCHASED'
  created_at TEXT NOT NULL,
  unlock_at TEXT NOT NULL,
  resolved_at TEXT DEFAULT NULL
);
```

---

## 四、 核心機制詳解：防重複入帳、轉帳/代墊分流與三大資產公式

### 1. 雙層防重複入帳機制 (Deduplication Engine)

為了解決銀行 App 通知規則改變、OCR 重複觸發或捷徑重送導致「同一筆帳被記兩次」的問題，`ingestionService.js` 在入帳前會執行嚴格的去重檢查：

1. **規則一：銀行刷卡/簽帳通知強制過濾（維持單一通道純淨）**
   - 日常刷卡消費統一由 **Apple Pay 原生捷徑** 觸發。若貼上或傳入的銀行通知含有「簽帳、刷卡、消費、授權、圈存、請款、信用卡」等字眼，系統直接記錄為 `IGNORED_CARD_NOTIF` 並忽略，從源頭杜絕「Apple Pay + 銀行刷卡通知」雙重記帳。
2. **規則二：標準化去重指紋生成 (`dedupe_fingerprint`)**
   - 系統從每筆入帳請求提取：`Direction` (`OUT`/`IN`)、`Amount`（整數金額）、`IdentityKey`（正規化店名 `NormalizedMerchant` 或卡號/帳號末四碼 `CardOrAccountLast4`）。
   - 組合指紋：`{Direction}|{Amount}|{IdentityKey}`（同時計算次級指紋 `{Direction}|{Amount}`）。
3. **規則三：10 分鐘時間窗雙層攔截與待確認機制**
   - 查詢過去 **10 分鐘內（預設 600 秒，可於設定調整）** 的已入帳紀錄：
     - **🛑 絕對重複自動攔截 (`BLOCKED_DUPLICATE`)**：
       - 若 **2 分鐘內** 出現「完全相同的原始文字 (`raw_payload`)」或「同來源通道 + 相同金額 + 相同店名/末四碼」，系統直接判定為捷徑重試或重複推播，**自動攔截不寫入帳本**。
     - **⚠️ 疑似重複標記待確認 (`SUSPECTED_DUPLICATE`)**：
       - 若在 **2 ~ 10 分鐘內** 出現「相同金額 + 相同店名/卡號末四碼」，或「10 分鐘內跨通道出現相同金額與同方向支出」，系統會寫入 `ledger_entries`，但將 `dedupe_status` 設為 `'SUSPECTED_DUPLICATE'`，且 **`budget_impact_amount` 暫設為 `0`（不扣減預算）**。
       - 前端首頁與明細頁會跳出醒目的琥珀色提醒卡片：**「⚠️ 偵測到 10 分鐘內疑似重複入帳」**，提供 **[🗑️ 是重複的，刪除]** 與 **[✅ 我真的買了兩次，確認入帳]** 兩個一鍵按鈕。

---

### 2. 轉帳 / 收帳 / 內部互轉 / 朋友代墊 徹底分流矩陣

新版透過 `flow_type` 將所有金流嚴格分流，**內部互轉與朋友還款絕對不會污染個人消費或亂加進每月總預算**：

| 交易情境 | `flow_type` | `💳 本月數位可用預算` 影響 | `💵 實體水庫 (現金/悠遊卡)` 影響 | `💰 最終總可用剩餘` 影響 | `🤝 應收代墊款池` 影響 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Apple Pay 刷卡 / 一般轉帳消費** ($150) | `EXPENSE` | **-$150** (`budget_impact = 150`) | $0 | **-$150** | 無 |
| **2. 刷卡/Apple Pay 觸發悠遊卡自動加值** ($500) | `INTERNAL_TRANSFER` | **-$500** (`budget_impact = 500`，數位錢轉入悠遊卡) | **悠遊卡 +$500** | **$0** (左口袋換右口袋，不計為個人花費項目) | 無 |
| **3. ATM 提款領現金** ($2,000) | `INTERNAL_TRANSFER` | **-$2,000** (`budget_impact = 2000`，數位錢轉為現鈔) | **皮包現金 +$2,000** | **$0** (資產形式轉換，不計入消費排行) | 無 |
| **4. 拿皮包現金去 ATM 存入金融卡** ($1,000) | `INTERNAL_TRANSFER` | **+$1,000** (`budget_impact = -1000`，現鈔轉回數位可用額) | **皮包現金 -$1,000** | **$0** (絕不覆蓋 `base_budget` 起始預算) | 無 |
| **5. 自己銀行帳戶間內部互轉** ($5,000) | `INTERNAL_TRANSFER` | **$0** (`budget_impact = 0`) | $0 | **$0** (純記錄，不扣預算) | 無 |
| **6. 聚餐刷卡 $2,000（自付 $500、代墊 $1,500）** | `EXPENSE` + `split_bills` | **-$500** (僅扣自己負擔的 $500！) | $0 | **-$500** | **+$1,500 應收代墊** |
| **7. 轉帳幫朋友全額代墊** ($800，標記 `ADVANCE`) | `ADVANCE_OUT` | **$0** (`budget_impact = 0`，代墊不扣個人預算) | $0 | **$0** | **+$800 應收代墊** |
| **8. 收到朋友轉帳還款** ($800 / $1,500，標記 `ADVANCE_IN`) | `ADVANCE_IN` | **$0** (絕不亂加進每月總預算！) | $0 | **$0** | **自動/手動沖銷結清 -$800 / -$1,500** |
| **9. 使用皮包現金買便當** ($100) | `EXPENSE` (`CASH`) | **$0** (花的是皮包現鈔，不扣數位卡預算) | **皮包現金 -$100** | **-$100** | 無 |
| **10. 外部薪資入帳 / 一般 ATM 存款** ($25,000) | `INCOME_DEPOSIT` | **$0** (嚴禁自動覆蓋 `base_budget`，僅更新銀行參考餘額) | $0 | **$0** (提供一鍵按鈕可手動設為起始預算) | 無 |

---

### 3. 三大核心資產指標與四級生存狀態公式 (`budgetEngine.js`)

首頁主卡片將清晰並排呈現您指定的三大指標：

1. **💳 本月數位可用預算 (`digitalRemainingBudget`)** —— **決定您的四級生存狀態與破產預警**
   - `本月數位可用預算 = 每月起始預算 (base_budget) - 每月固定扣款總額 - SUM(已確認數位扣減 budget_impact_amount)`
   - **今日數位安全可用額度 (`dailySafeBudget`)** = `Math.floor(本月數位可用預算 / 本週期剩餘天數)`
   - **四級生存狀態（完全由 `dailySafeBudget` 驅動）**：
     - 🟢 **富裕層 (`WEALTHY`)**：`dailySafeBudget >= $500`
     - 🔵 **平民層 (`NORMAL`)**：`$300 <= dailySafeBudget < $500`
     - 🟠 **乞丐超人層 (`BEGGAR_HERO`)**：`$150 <= dailySafeBudget < $300`
     - 🔴 **吃土警戒層 (`DIRT_EATING`)**：`dailySafeBudget < $150`
2. **💵 實體水庫總額 (`physicalTankTotal`)**
   - `實體水庫總額 = 皮包現金餘額 (cash_balance) + 悠遊卡餘額 (easycard_balance)`
3. **💰 最終總可用剩餘 (`grandTotalAvailable`)**
   - `最終總可用剩餘 = 💳 本月數位可用預算 + 💵 實體水庫總額`

---

## 五、 商店正規化與分類字典抽離設計 (`src/config/merchantRules.js`)

不再將 Regex 硬編碼於解析器內，改為結構化設定檔，抽離為四大規則表：
1. `THIRD_PARTY_PREFIXES`：自動剔除 `連加*`、`LINE PAY`、`街口*`、`優食*`、`綠界*`、`藍新*`、`全支付*`、`全盈*`、`拍付*`、`一卡通*`、`悠遊付*`、`台灣PAY` 等前綴。
2. `MERCHANT_ALIASES`：統一超商/7-11 ➔ `7-ELEVEN`、全家 ➔ `全家便利商店`、中油 ➔ `台灣中油`、星巴克/悠旅生活 ➔ `星巴克`、蝦皮 ➔ `蝦皮購物` 等同義店名標準化。
3. `TANK_TRANSFER_RULES`：自動識別「悠遊卡自動加值 (`EASYCARD`)」與「ATM 提款領現 (`CASH`)」，自動轉換為 `INTERNAL_TRANSFER` 並連動水庫。
4. `CATEGORY_RULES`：自動歸類 `超商小額`、`手搖飲品`、`餐飲外食`、`加油交通`、`數位娛樂`、`網購剁手` 等分類。

---

## 六、 UI 視覺與 5 大分頁元件架構 (`public/`)

保留 **Apple Dark Mode 深色毛玻璃 + Bento 卡片風格 + 四級生存微光 (`.tier-glow-*`) + 高風險暗紅模式 (`body.high-risk-mode`)**，消除雜亂 inline style：

1. **分頁 1：【首頁 (`homeView.js`)】**
   - **頂部核心生存大卡片**：並排呈現 **💳 本月數位可用預算**（含四級生存徽章与今日可用額度）、**💵 實體水庫總額（現金＋悠遊卡）**、**💰 最終總可用剩餘（數位＋水庫）** 與破產倒數預警。
   - **⚠️ 疑似重複入帳待確認警示卡**（支援一鍵刪除重複或確認入帳）。
   - **4 大快捷行動鈕**（記現金消費、Apple Pay/轉帳入帳、想買急救、預算設定）與雙水庫/防剁戰績速覽。
2. **分頁 2：【錢包 (`walletView.js`)】**
   - **皮包現金 & 悠遊卡雙水庫控制面板**（含 3 天盤點提醒、快捷加減、自訂金額與異動日誌）。
   - **🤝 朋友聚餐拆帳 & 應收代墊款池**（代墊不扣個人預算，收到還款一鍵或自動沖銷）。
   - **🏦 玉山可用餘額一鍵校正**（自動生成 `🕳️ 未知漏帳黑洞` 並支援事後拆分明細）。
3. **分頁 3：【明細 (`recordsView.js`)】**
   - **資金流向篩選膠囊列**：`全部`、`💸 一般消費`、`🔄 內部互轉`、`🤝 代墊與還款`、`💰 存款/收入`、`⚠️ 疑似重複`、`🕳️ 待查黑洞`。
   - 支援單筆聚餐拆帳、黑洞拆分、以及刪除紀錄（自動精準回滾水庫與代墊池）。
4. **分頁 4：【防剁 (`impulseView.js`)】**
   - **衝動急救靈魂拷問彈窗**（血汗工時 + 咖啡杯數 + 日預算衝擊 + AI 毒舌勸退）、**防剁省錢戰績與稱號榜**、**72 小時冷卻清單**。
5. **分頁 5：【設定 (`settingsView.js`)】**
   - **每月起始數位預算 (`base_budget`) 與發薪日設定**。
   - **打工薪水試算 (`shift-pay`) 獨立開啟與手動帶入區**（僅手動點擊時帶入，絕不自動覆蓋）。
   - **每月固定扣款與訂閱守門員**（含扣款前 3 天提醒，已移除未來 3 個月分期壓條）。
   - **7 天內 `< $200` 隱形吸血鬼抓漏雷達**。
   - **🛠️ 開發者與自動化測試區（收合於底部）**：iOS 捷徑 Webhook 說明、**「⏩ 快轉滿 72h」測試按鈕**、模擬通知與去重測試、載入範例資料、清空歸零帳本。

---

## 七、 雙核心自動偵測通道深度除錯與「相簿零殘留」架構規範

針對您目前的兩大唯一自動入帳來源：**1. Apple Pay 捷徑** 與 **2. 截圖記錄轉帳【轉入／轉出】**，新版架構專門修復了舊版的 4 大隱藏 Bug，並提供「手機相簿零殘留截圖」的完整機制：

### 1. 修復舊版的 4 大核心邏輯破洞

1. **修復 Bug A：【轉帳截圖被舊版 `BANK_CARD_BLOCK_REGEX` 誤殺吞掉】**
   - **舊版問題**：舊版只要看到文字裡有「消費、信用卡、授權」其中一個詞就整筆攔截。但網銀轉帳截圖的底部選單常印有「信用卡」分頁、或轉帳備註寫「聚餐消費」，導致轉帳截圖被誤判為刷卡通知而無法入帳。
   - **v2 修正**：將端點物理拆分為 `POST /api/webhook/apple-pay` 與 `POST /api/webhook/transfer-ocr`。在 `transfer-ocr` 轉帳截圖通道中，不再無腦封鎖「消費/信用卡」單字，確保任何網銀轉帳截圖 100% 成功入帳。
2. **修復 Bug B：【轉帳截圖 OCR 誤抓「手續費 0元/15元、銀行代碼 808、手機電量」當作金額】**
   - **舊版問題**：iPhone 截圖頂部有時間與電量 (`12:30`、`85%`)，內文有銀行代號 (`808`)、帳號、手續費 (`0元`/`15元`) 與可用餘額，舊版 Regex 常誤抓手續費或抓不到無「元」字結尾的大字體金額。
   - **v2 修正**：實作多階段 OCR 雜訊清洗器，先剝離手續費、餘額、銀行三碼代號、帳號與狀態列，再依權重擷取主金額（支援 `NT$ 1,200`、`$1,200`、`轉帳金額 1,200` 等所有網銀版型）。
3. **修復 Bug C：【轉入 vs 轉出方向在明細截圖上判反】**
   - **舊版問題**：轉帳成功或明細截圖常同時印出「轉出帳號」與「轉入帳號」，舊版看到「轉出帳號」就強制判為 `OUT`（轉出扣款），導致別人轉錢給您卻變成扣您的預算。
   - **v2 修正**：
     - **優先權 1（iOS 捷徑選單明確指定）**：支援捷徑傳入 `direction` (`OUT`/`IN`) 與 `flowType` (`EXPENSE` / `ADVANCE_OUT` / `ADVANCE_IN` / `INTERNAL_TRANSFER` / `INCOME_DEPOSIT`)，100% 依指定分流，絕不猜錯。
     - **優先權 2（智慧語意權重判定）**：若未傳入 `direction`，則綜合比對標題句型（如「轉入成功 / 收到轉帳 / 存入金額」vs「轉帳成功 / 轉出金額 / 付款成功」）而非單看「轉出帳號」四字。
4. **修復 Bug D：【轉入 (IN) 朋友分批/合併還款沖銷與預算污染】**
   - **v2 修正**：
     - **轉入—朋友還款 (`ADVANCE_IN`)**：支援自動沖銷同金額代墊單；若朋友一次合併還多筆或部分還款，亦支援自動/手動勾選沖銷對應的 `split_bills`，**且絕不加進每月總預算**。
     - **轉入—一般入帳/薪資 (`INCOME_DEPOSIT`)**：僅記錄入帳並更新銀行餘額參考，**嚴禁自動覆蓋 `base_budget` 每月起始預算**。

---

### 2. 📱 截圖記錄轉帳「手機相簿零殘留」iOS 捷徑架構設計

為了解決「每次截圖記轉帳，iPhone 相簿就多一張垃圾截圖」的問題，v2 後端 API 與前端設定頁將內建支援並提供以下兩種 **相簿零殘留方案**：

#### 🌟 方案 A（最推薦）：iOS 捷徑「記憶體直接截圖法」—— 照片從頭到尾不進相簿！
- **原理**：不要按實體「電源鍵＋音量鍵」截圖！改用 iOS 捷徑內建的 **「擷取螢幕畫面 (Take Screenshot)」** 動作（透過 **敲擊手機背面兩下 Back Tap** 或 **動作按鈕 / 控制中心** 觸發）。該動作產生的圖片**只存在捷徑暫存記憶體中**，只要不接「儲存到相簿」，捷徑執行完的瞬間圖片就會自動銷毀，**相簿與「最近刪除」都不會有任何照片**！
- **捷徑 5 步驟流程**：
  1. **擷取螢幕畫面 (`Take Screenshot`)**（僅存於 RAM 記憶體）
  2. **從影像中擷取文字 (`Extract Text from Image`)**
  3. **從選單中選擇 (`Choose from Menu`)**（1 秒點選本次轉帳性質）：
     - `💸 轉出：一般消費 (扣預算)` ➔ `direction="OUT", flowType="EXPENSE"`
     - `🤝 轉出：幫朋友代墊 (進代墊池)` ➔ `direction="OUT", flowType="ADVANCE_OUT"`
     - `💰 轉入：收到朋友還款 (沖銷代墊)` ➔ `direction="IN", flowType="ADVANCE_IN"`
     - `🔄 轉出/轉入：內部互轉或存款紀錄 (不影響消費)` ➔ `flowType="INTERNAL_TRANSFER"`
  4. **取得 URL 內容 (`POST /api/webhook/transfer-ocr`)**：送出 `raw_text`、`direction`、`flowType`。
  5. **顯示通知 (`Show Notification`)**：即時跳出推播顯示入帳結果與今日剩餘可用額度！

#### 🌟 方案 B：實體鍵截圖後「OCR 完成自動靜默刪除法」
- 若習慣按實體鍵截圖，只需在 iPhone `設定 ➔ App ➔ 捷徑 ➔ 進階` 開啟 **「允許刪除而不確認 (Allow Deleting Without Confirmation)」**，並在捷徑最後一步加上 **「刪除照片 (Delete Photos: 最新的螢幕截圖)」**，即可在傳送 API 成功後自動清除該張截圖。

---

### 3. ↩️ ATM 存入金融卡與全帳務「隨時反悔撤銷 ＆ 自由修改編輯」機制

針對舊版「輸入 ATM 存入金融卡不小心打錯金額，卻無法反悔或修改（甚至刪除後被扣掉的皮包現金不會退回來）」的痛點，v2 從資料庫欄位到 UI 設計了三層反悔與修改保護：

1. **修復舊版水庫回滾 Bug（100% 原子化雙向回滾 `Atomic Reversibility`）**
   - **舊版 Bug 根源**：舊版記錄 ATM 存款扣皮包現金時，`linked_tx_id` 寫為 `NULL`，且刪除時只判斷 `delta_amount > 0`，導致「拿皮包現金去存 ATM (`delta_amount < 0`)」一旦輸入錯誤，刪除該筆存款也拿不回皮包現金。
   - **v2 徹底根治**：在 `ledger_entries` 表中直接記錄該筆交易的 `budget_impact_amount`、`cash_delta` 與 `easycard_delta`。
     - 當您執行「🏧 ATM 存入金融卡 $1,000（勾選從皮包現金扣除）」時，該筆紀錄明確記載：`budget_impact_amount = -1000`（增加數位可用預算 $1,000）、`cash_delta = -1000`（扣減皮包現金 $1,000）。
     - **一旦點擊「↩️ 反悔撤銷 / 刪除」**：系統直接將 `-cash_delta`（即 `+$1,000`）精準退回皮包現金水庫，並將數位可用預算扣回 `$1,000`，同時寫入水庫退回日誌，**所有帳戶與水庫餘額 100% 瞬間恢復原狀**！
2. **新增「✏️ 隨時修改任何一筆紀錄（含 ATM 存款、轉帳、消費）」功能 (`PUT /api/ledger/:id`)**
   - 不小心把 ATM 存入 `$1,000` 打成 `$10,000`？或忘記勾選「從皮包現金扣除」？或轉帳分類選錯？
   - 點擊任何一筆紀錄旁的 **「✏️ 修改」** 按鈕，即可直接更改：
     - **金額 (`amount`)**
     - **項目名稱 / 備註 (`merchant` / `note`)**
     - **資金流向分類 (`flow_type`)**（一般消費 / 內部互轉 / 朋友代墊 / 朋友還款 / ATM 存入）
     - **是否同步連動皮包現金 / 悠遊卡水庫**
   - 後端更新時採用 **「先完整回滾舊金額對預算與水庫的影響 ➔ 再套用新金額」** 的原子更新演算法，怎麼改都不會算亂帳務。
3. **三處直覺的「反悔 / 修改」入口（免翻找明細）**
   - **入口 1（送出後 Toast 立即反悔）**：每次完成 ATM 存款或記帳，畫面彈出的成功提示條直接附帶 **[↩️ 剛打錯？立即撤銷]** 按鈕，點一下 1 秒復原。
   - **入口 2（ATM 存款彈窗內建「最近存入紀錄」列表）**：在「存入金融卡」彈窗下方直接顯示最近 5 筆存入紀錄，每筆旁邊皆有 **[✏️ 改金額]** 與 **[↩️ 撤銷退回]** 按鈕。
   - **入口 3（明細頁完整管理）**：明細頁中所有紀錄皆可隨時點擊 **[✏️ 修改]** 或 **[🗑️ 刪除並回滾]**。

---

## 八、 階段四分步實作計畫（已完成）

1. **Step 1**：建立 `./v2` 基礎建設、設定與字典檔 (`src/config/constants.js`, `src/config/merchantRules.js`) 及資料庫底層 (`src/db/schema.sql`, `src/db/dbAdapter.js`)。
2. **Step 2**：實作標準 Repository 資料存取層 (`src/repositories/*.js`)。
3. **Step 3**：實作核心領域服務層 (`budgetEngine.js`, `merchantClassifier.js`, `ingestionService.js`, `splitAndTankService.js`, `impulseService.js`, `shiftBridgeService.js`)。
4. **Step 4**：實作模組化 REST API 路由與伺服器入口 (`src/routes/*.js`, `src/server.js`, `src/worker.js`)。
5. **Step 5**：實作模組化前端 (`public/index.html`, `public/css/*.css`, `public/js/**/*.js`) 與自動化單元測試 (`tests/guardpay.test.js`)，並啟動伺服器進行完整驗證。

---

## 九、 長期維護與修改之「五道防 Bug 與防腐敗工程防線」（永久開發守則）

未來在對本專案進行任何 Bug 修復、規則調整或功能擴充時，必須嚴格遵守以下五道防線，杜絕舊版「修東壞西、代碼腐敗」的情況重演：

1. **防線一：嚴格遵守五層職責隔離（單一修改落點）**
   - 店名前綴、同義詞與分類規則變更 ➔ **只改 `src/config/merchantRules.js`**。
   - Apple Pay 與轉帳截圖 OCR 解析及去重邏輯變更 ➔ **只改 `src/services/ingestionService.js`**。
   - 預算、生存等級與破產預警公式變更 ➔ **只改 `src/services/budgetEngine.js`**。
   - 單一分頁 UI 調整 ➔ **只改 `public/js/views/` 下對應的單一視圖模組**（前端嚴禁夾帶帳務計算或偷改 `localStorage`）。
2. **防線二：原子化帳務影響欄位（確保 100% 雙向可逆回滾）**
   - 任何新增或修改的帳務類型，寫入 `ledger_entries` 時皆必須明確填寫 `budget_impact_amount`、`cash_delta` 與 `easycard_delta`，確保既有的「✏️ 修改 (`updateAndReconcileLedgerEntry`)」與「↩️ 反悔撤銷 (`deleteAndRollbackLedgerEntry`)」永遠能 100% 自動精準回滾。
3. **防線三：重構取代修補（嚴禁殘留殭屍代碼與隱藏 DOM）**
   - 當既有規則改變時，直接移除被淘汰的舊邏輯與舊 HTML 節點，絕不用「前面加攔截器、後面留空殼函式或 `<div class="hidden">`」的方式疊床架屋。
4. **防線四：強制回歸測試（Regression Testing）**
   - 每次修改代碼或修復 Bug 後，必須執行 `node --test tests/guardpay.test.js`，確認所有核心測試 100% 通過；修復新發現的 Bug 時，須同步新增對應測試案例防止復發。
5. **防線五：變更前先盤點影響範圍**
   - 動手修改前先列出受影響的模組清單，保持小步、清晰、零副作用的提交。





