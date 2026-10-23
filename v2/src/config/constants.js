'use strict';

/**
 * 餘額守門員 GuardPay v2 — 系統核心常數設定
 */
module.exports = {
  // 預設參數
  DEFAULT_PAYDAY_DAY: 10,
  DEFAULT_HOURLY_WAGE: 200,
  DEFAULT_NET_PAY_FACTOR: 0.95,
  DEFAULT_LABOR_DEDUCTION: 0,
  DEFAULT_DEDUPE_WINDOW_MINUTES: 10,
  EXACT_BLOCK_WINDOW_SECONDS: 120, // 2 分鐘內同通道完全相同金額與商家直接攔截
  COFFEE_UNIT_PRICE: 65,
  COOLDOWN_HOURS: 72,
  TANK_AUDIT_REMINDER_DAYS: 3,

  // 隱形吸血鬼抓漏雷達門檻 (過去 7 天單筆 < $200 且 > 4 次)
  VAMPIRE_WINDOW_DAYS: 7,
  VAMPIRE_MAX_SINGLE_AMOUNT: 200,
  VAMPIRE_WARNING_COUNT: 3,
  VAMPIRE_ALERT_COUNT: 4,

  // 訂閱扣款前提醒天數
  SUBSCRIPTION_PRE_ALERT_DAYS: 3,

  // 高風險防禦時段 (台灣時間 23:00 ~ 05:00，以及發薪日後前 3 天)
  LATE_NIGHT_START_HOUR: 23,
  LATE_NIGHT_END_HOUR: 5,
  POST_PAYDAY_HIGH_RISK_DAYS: 3,

  // 四級生存狀態門檻 (完全由「💳 本月數位可用預算 ÷ 剩餘天數」決定)
  SURVIVAL_TIERS: {
    WEALTHY: {
      code: 'WEALTHY',
      minDaily: 500,
      emoji: '🟢',
      label: '富裕層',
      rangeText: '日均可用 ≥ $500',
      themeColor: 'emerald',
      advice: '數位可用額度充裕！保持理性消費節奏，多餘額度可轉為儲蓄。'
    },
    NORMAL: {
      code: 'NORMAL',
      minDaily: 300,
      emoji: '🔵',
      label: '平民層',
      rangeText: '日均可用 $300 ~ $499',
      themeColor: 'sky',
      advice: '目前處於穩定安全區，注意控制手搖飲與超商小額消費即可安全度過本月。'
    },
    BEGGAR_HERO: {
      code: 'BEGGAR_HERO',
      minDaily: 150,
      emoji: '🟠',
      label: '乞丐超人層',
      rangeText: '日均可用 $150 ~ $299',
      themeColor: 'amber',
      advice: '⚠️ 數位預算開始吃緊！建議鎖定超商友善時光/i珍食，暫停所有非必要網購。'
    },
    DIRT_EATING: {
      code: 'DIRT_EATING',
      minDaily: -Infinity,
      emoji: '🔴',
      label: '吃土警戒層',
      rangeText: '日均可用 < $150',
      themeColor: 'rose',
      advice: '🚨 紅色吃土警報！每日數位可用額度低於 $150，請立即凍結所有「想要」的消費！'
    }
  },

  // 六大資金流向定義
  FLOW_TYPES: {
    EXPENSE: 'EXPENSE',                     // 一般消費支出 (扣減數位預算或皮包現金)
    INTERNAL_TRANSFER: 'INTERNAL_TRANSFER', // 內部互轉 (ATM提款、悠遊卡加值、拿皮包現鈔存ATM、自己帳戶互轉)
    ADVANCE_OUT: 'ADVANCE_OUT',             // 幫朋友代墊支出 (不扣個人預算，進應收代墊池)
    ADVANCE_IN: 'ADVANCE_IN',               // 收到朋友轉帳還款 (不加進總預算，沖銷應收代墊池)
    INCOME_DEPOSIT: 'INCOME_DEPOSIT',       // 外部存款/薪資入帳 (僅記錄或手動帶入，絕不自動覆蓋起始預算)
    UNKNOWN_GAP: 'UNKNOWN_GAP'              // 玉山餘額校正未知漏帳黑洞 (可事後拆分為 EXPENSE)
  },

  // 支付/資金媒介
  PAYMENT_MEDIA: {
    DIGITAL_BANK: 'DIGITAL_BANK',           // 金融卡 / Apple Pay / 銀行數位帳戶
    CASH: 'CASH',                           // 皮包現金水庫
    EASYCARD: 'EASYCARD'                    // 悠遊卡水庫
  },

  // 防重複入帳狀態
  DEDUPE_STATUS: {
    CONFIRMED: 'CONFIRMED',                 // 已確認入帳
    SUSPECTED_DUPLICATE: 'SUSPECTED_DUPLICATE' // 10 分鐘內疑似重複待使用者確認 (暫不扣預算)
  }
};
