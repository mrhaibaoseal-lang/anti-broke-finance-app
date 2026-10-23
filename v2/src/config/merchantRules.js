'use strict';

/**
 * 餘額守門員 GuardPay v2 — 商店名稱正規化、支付前綴剔除與自動消費分類字典檔
 * 與核心業務邏輯完全解耦，日後新增通路或分類關鍵字僅需調整此設定檔。
 */
module.exports = {
  // 1. 自動剔除之第三方支付與電子支付前綴詞
  THIRD_PARTY_PREFIXES: [
    '連加網路',
    '連加',
    'LINE PAY',
    'LINEPAY',
    '街口電支',
    '街口支付',
    '街口',
    'JKOPAY',
    '優食',
    'UBEREATS',
    'UBER EATS',
    '綠界科技',
    '綠界',
    'ECPAY',
    '藍新金流',
    '藍新',
    'NEWEBPAY',
    '全支付',
    'PXPAY',
    '全盈支付',
    '全盈',
    '拍付',
    'PI錢包',
    '一卡通',
    'IPASS MONEY',
    'IPASS',
    '悠遊付',
    'EASY WALLET',
    '台灣PAY',
    'TWQR',
    'APPLE PAY',
    'GOOGLE PAY',
    'SAMSUNG PAY',
    '玉山WALLET'
  ],

  // 2. 同義店名標準化映射表
  MERCHANT_ALIASES: [
    { pattern: /7[\-\s]*11|7[\-\s]*ELEVEN|統一超商/i, normalized: '7-ELEVEN' },
    { pattern: /全家便利|全家超商|FAMILY\s*MART|FAMILYMART|^全家$/i, normalized: '全家便利商店' },
    { pattern: /萊爾富|HI[\-\s]*LIFE/i, normalized: '萊爾富' },
    { pattern: /OK超商|OK\s*MART|來來超商/i, normalized: 'OK超商' },
    { pattern: /台灣中油|中國石油|中油/i, normalized: '台灣中油' },
    { pattern: /全國加油/i, normalized: '全國加油站' },
    { pattern: /MCDONALD|麥當勞/i, normalized: '麥當勞' },
    { pattern: /STARBUCKS|星巴克|悠旅生活/i, normalized: '星巴克' },
    { pattern: /SHOPEE|蝦皮/i, normalized: '蝦皮購物' },
    { pattern: /STEAM\s*GAMES|STEAMPOWERED|STEAM/i, normalized: 'STEAM' },
    { pattern: /APPLE\.COM\/BILL|APP\s*STORE|ITUNES/i, normalized: 'APPLE' },
    { pattern: /NETFLIX/i, normalized: 'NETFLIX' },
    { pattern: /玉山\s*ATM\s*無卡存款|無卡存款/i, normalized: '玉山 ATM 無卡存款' },
    { pattern: /玉山\s*ATM\s*現金存款|玉山\s*ATM\s*存款|ATM\s*現金存款|ATM\s*存款|ATM\s*存入|自動化設備存款|跨行存款/i, normalized: '玉山 ATM 存款' },
    { pattern: /玉山帳戶轉帳入帳|轉帳入帳|轉帳存入|匯款入帳/i, normalized: '玉山帳戶轉帳入帳' }
  ],

  // 3. 自動聯動實體水庫之內部互轉規則 (觸發時歸為 INTERNAL_TRANSFER，資產轉移至對應水庫)
  TANK_TRANSFER_RULES: [
    {
      pattern: /自動加值|悠遊卡加值|悠遊卡自動加值|EASYCARD|一卡通MONEY|IPASS\s*MONEY|全支付儲值|街口儲值/i,
      tankType: 'EASYCARD',
      category: '自動加值/儲值'
    },
    {
      pattern: /ATM\s*提款|ATM\s*提領|現金提領|跨行提款|無卡提款/i,
      tankType: 'CASH',
      category: 'ATM提款領現'
    }
  ],

  // 4. 一般消費自動分類規則
  CATEGORY_RULES: [
    { category: '超商小額', pattern: /7-ELEVEN|全家便利商店|萊爾富|OK超商|便利商店/i },
    { category: '手搖飲品', pattern: /50嵐|五十嵐|清心|迷客夏|可不可|麻古|茶湯會|得正|一沐日|星巴克|路易莎|鶴茶樓|五桐號|八曜|飲料|咖啡|麥香/i },
    { category: '餐飲外食', pattern: /優食|UBEREATS|FOODPANDA|富胖達|餐廳|美食|小吃|便當|火鍋|燒肉|麥當勞|肯德基|摩斯|壽司|拉麵|早午餐|早餐|晚餐|午餐/i },
    { category: '加油交通', pattern: /台灣中油|全國加油站|加油站|台亞|速邁樂|台塑石油|高鐵|台鐵|UBER|計程車|捷運|公車/i },
    { category: '數位娛樂', pattern: /STEAM|NETFLIX|SPOTIFY|APPLE|YOUTUBE|PLAYSTATION|NINTENDO|遊戲|影城|電影/i },
    { category: '網購剁手', pattern: /蝦皮購物|MOMO|PCHOME|淘寶|COUPANG|酷澎|網購/i },
    { category: '生活日用', pattern: /全聯|家樂福|大潤發|好市多|COSTCO|屈臣氏|康是美|寶雅|無印良品|UNIQLO|IKEA/i }
  ],

  // 5. 常用台灣銀行 3 碼代號清單 (用於轉帳截圖 OCR 過濾雜訊，避免誤將 808、822 等代號當成金額)
  TW_BANK_CODES: [
    '004', '005', '006', '007', '008', '009', '011', '012', '013', '016', '017',
    '021', '048', '050', '052', '053', '081', '102', '103', '108', '118', '147',
    '700', '803', '805', '806', '807', '808', '809', '810', '812', '815', '816',
    '822', '823', '824', '826', '388', '392', '396', '397', '398'
  ]
};
