# 🛡️ 防破產與防衝動消費之智慧記帳系統 (Anti-Broke & Impulse-Control Finance Tracker)

本系統為**全端智慧記帳與防破產預警平台**，同時支援 **本機獨立運作（Node.js + 原生 `node:sqlite`）** 與 **Cloudflare 雲端無伺服器部署（Cloudflare Workers / Pages + D1 雲端資料庫 + 瀏覽器離線同步引擎）**。專為解決**「台灣玉山銀行簽帳金融卡（Debit Card）雙重通知（圈存 vs 請款）」**對帳難題，並透過**唯讀（Read-Only）跨專案同步模組**自動讀取外部「班表算錢程式 (`shift-pay-app`)」之排班薪資與時薪數據。

---

## 🌐 線上雲端網址與 GitHub 儲存庫

- **GitHub 儲存庫**：`https://github.com/mrhaibaoseal-lang/anti-broke-finance-app`
- **Cloudflare Workers + D1 正式網址**：`https://anti-broke-finance-app.mr-haibaoseal.workers.dev`
- **Cloudflare Pages 正式網址**：`https://anti-broke-finance-app.pages.dev`
- **iOS 捷徑雲端 Webhook API**：`POST https://anti-broke-finance-app.mr-haibaoseal.workers.dev/api/notifications/webhook`

---

## 🚀 快速啟動與單元測試

```bash
# 1. 切換至專案目錄
cd C:\Users\mrhai\.gemini\antigravity\scratch\anti-broke-finance-app

# 2. 執行玉山雙重通知、防剁手與 Cloudflare 相容引擎單元測試 (8 大情境全覆蓋)
npm test

# 3. 打包前端離線引擎與靜態資源
npm run build

# 4. 啟動本機獨立伺服器 (預設 Port: 3088)
npm start
# 開啟瀏覽器訪問：http://localhost:3088

# 5. 一鍵部署至 Cloudflare Workers + D1
npm run deploy
```

---

## ✨ 四大核心模組一覽

1. **收入源頭與生存週期引擎 (`shiftSyncService.js` + `survivalEngine.js`)**
   - **唯讀跨專案班表串接**：絕不修改原 `shift-pay-app`，支援自動掃描班表資料夾與直接貼上 `shiftpay-v2` JSON 數據。
   - **實領折數（預設 `×0.95`）與發薪日入帳自動校正**：收到玉山「薪資入帳」通知自動覆蓋預估值。
   - **自訂發薪日生存週期（如每月 10 號重置）**、**破產倒數預警**與 **🟢🟡🟠🔴 四級吃土狀態指標**。
2. **玉山簽帳金融卡「雙重通知」對帳核心演算法 (`esunParser.js` + `reconciliationEngine.js`)**
   - **雙通道狀態機 (`PENDING` / `SETTLED` / `TEMP_HOLD` / `CANCELED` / `AUTH_VERIFY`)**。
   - **解決「常買同價商品（$10 麥香問題）」**：權重配對（金額 60% + 原始消費日 30% + 正規化店名 10%）+ **嚴格 FIFO 先進先出 1-to-1 Lock** + **3 分鐘防抖動鎖**。
   - **第三方支付店名正規化**：自動剔除 `連加*`(LINE Pay)、`街口*`、`優食*`、`綠界*` 等前綴。
   - **跨國匯差與 1.5% 海外手續費自動修正（`±6%` 容許誤差比對）**。
   - **特殊邊界防護**：`$1~$2` 綁卡驗證過濾、加油站 `$1,500/$2,250` 預授權白名單、14 天幽靈圈存雷達與先買後退原則。
3. **防衝動消費與抓漏進階機制 (`impulseControlService.js`)**
   - **AI 勸退守門員（血汗工時換算 + 月底生存衝擊 + 毒舌靈魂拷問）**。
   - **72 小時冷靜期購物車 & 防剁手省錢成就榜**。
   - **深夜 (23:00~05:00) 與發薪日後 72h 高風險防禦模式**。
   - **隱形吸血鬼抓漏雷達（單筆 < $200 且 7 天內 > 4 次）** 與 **訂閱扣款前 3 天提醒 / 未來月份薪水分期預支壓條**。
4. **日常真實生活補丁 (`accountingPatchService.js`)**
   - **朋友聚餐一鍵拆帳 / 應收代墊款池（不扣個人預算）**。
   - **悠遊卡自動加值 ($500) / ATM 提款 黑洞追蹤水庫 (`Wallet Tank`)** 與 3 天定期盤點提醒。
   - **玉山可用餘額一鍵校正 (`Balance Sync`)**：自動生成 `$XXX 未知漏帳（待查黑洞）` 並支援事後拆分補齊明細。
