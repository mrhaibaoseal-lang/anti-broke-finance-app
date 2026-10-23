# 🛡️ 餘額守門員 GuardPay V2 — 智慧防破產與防衝動消費記帳系統

**GuardPay V2 (`v2.0.0`)** 為全端智慧記帳與防破產預警平台，同時支援 **本機獨立運作（Node.js + 原生 `node:sqlite`）** 與 **Cloudflare 雲端無伺服器部署（Cloudflare Workers + Cloudflare Pages + D1 雲端資料庫）**。

專為解決 **iPhone Apple Pay 雙捷徑自動偵測（NFC 感應 + 錢包交易通知）**、**零相簿殘留之轉帳截圖 OCR 智慧辨識**、**單一權威預算源（數位預算 vs 實體水庫嚴格分流）**，並內建**跨專案班表算錢程式 (`shift-pay`) 橋接匯入**與 **72 小時防衝動冷卻池**。

---

## 🌐 線上雲端網址與 GitHub 儲存庫

- **GitHub 儲存庫**：`https://github.com/mrhaibaoseal-lang/anti-broke-finance-app`
- **Cloudflare Workers + D1 正式網址**：`https://anti-broke-finance-app.mr-haibaoseal.workers.dev`
- **Cloudflare Pages 正式網址**：`https://anti-broke-finance-app.pages.dev`
- **iOS Apple Pay 捷徑雲端 Webhook API**：
  - `POST https://anti-broke-finance-app.mr-haibaoseal.workers.dev/api/ledger/apple-pay`
  - 相容舊版路徑：`POST https://anti-broke-finance-app.mr-haibaoseal.workers.dev/api/notifications/webhook`
- **iOS 轉帳截圖 OCR 雲端 API**：
  - `POST https://anti-broke-finance-app.mr-haibaoseal.workers.dev/api/ledger/transfer-ocr`

---

## 🚀 快速啟動、測試與部署

```bash
# 1. 切換至專案目錄
cd D:\Cline\anti-broke-finance-app

# 2. 執行 GuardPay V2 核心單元與整合測試 (6 大核心場景全覆蓋)
npm test

# 3. 啟動本機獨立伺服器 (預設 Port: 3088，或雙擊 start-app.bat)
npm start
# 開啟瀏覽器訪問：http://localhost:3088

# 4. 一鍵同步部署至 Cloudflare Workers + Cloudflare Pages (共享同一顆 D1 資料庫)
npm run deploy
```

---

## ✨ GuardPay V2 六大核心架構特色

1. **單一權威預算源與三大核心資產指標 (`budgetEngine.js`)**
   - **💳 數位剩餘預算**、**💵 實體水庫總額（皮包現金 + 悠遊卡）**、**💰 最終總可動用資金** 三大指標嚴格獨立計算。
   - 外部轉入或 ATM 存款不會污染或覆蓋使用者設定的基礎預算，支援「班表算錢程式 (`shift-pay`)」一鍵試算匯入。
   - 內建自訂發薪日生存週期、每日安全可用額度與 **🟢🟡🟠🔴 四級吃土預警指標**。
2. **Apple Pay 雙捷徑自動偵測與雙層防重複引擎 (`ingestionService.js` + `ledgerRoutes.js`)**
   - 支援 **方案 A（交易捷徑：NFC 感應自動抓取金額與店名）** + **方案 B（打開玉山 Wallet 自動化：5 秒內靜默合併補齊精確金額，不重複扣款）**。
   - **雙層防重複保護**：
     - **0 ~ 5 秒**：雙捷徑連發自動靜默合併（若前筆為 `$0` 待補金額則自動升級補齊）。
     - **5 秒 ~ 10 分鐘**：同金額刷卡自動標記為 `SUSPECTED_DUPLICATE`（疑似重複待確認），待使用者於明細頁一鍵「確認為真消費」才計入預算，或一鍵「確認重複並刪除」。
3. **零相簿殘留之轉帳截圖 OCR 智慧分流 (`ingestionService.js`)**
   - 透過 iOS 捷徑「擷取螢幕截圖 ➔ 從影像中擷取文字 ➔ 直接上傳雲端」，無須儲存照片。
   - 自動過濾手機狀態列與底部選單雜訊（如底部「信用卡」導覽列不誤判），並支援 **一般轉出消費**、**朋友聚餐代墊拆帳**、**朋友轉入還款自動沖銷**。
4. **實體水庫 (`Wallet Tank`) 與 ATM 存入金融卡 100% 雙向反悔回滾 (`splitAndTankService.js`)**
   - 完整追蹤 **ATM 提領現鈔**、**悠遊卡自動加值**、**ATM 現鈔存入金融卡**。
   - 當 ATM 存款或任何明細打錯金額時，支援 **直接修改金額 (`PUT /api/ledger/:id`)** 與 **反悔撤銷刪除 (`DELETE /api/ledger/:id`)**，自動將皮包現金與數位預算 100% 精準回滾。
5. **玉山可用餘額校正與未知漏帳黑洞拆分 (`splitAndTankService.js`)**
   - 輸入玉山 App 實際可用餘額即可自動比對帳面差額，生成「未知漏帳（待查黑洞）」，事後可隨時拆分補齊真實消費明細。
6. **72 小時防衝動冷卻池與夜間高風險防禦 (`impulseService.js`)**
   - **AI 毒舌勸退守門員**：自動換算血汗工時與購買後每日可用額度跌幅。
   - **深夜 (23:00~05:00) 與發薪日後 72h 腦波弱高風險防禦模式** + **小額高頻吸血鬼抓漏雷達**。

