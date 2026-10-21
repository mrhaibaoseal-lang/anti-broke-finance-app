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
    /^拍付[\*\-\s_]*/,
    /^PI錢包[\*\-\s_]*/,
    /^一卡通[\*\-\s_]*/,
    /^IPASS[\*\-\s_]*/
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
  if (/全家便利|全家超商|FAMILY\s*MART|FAMILYMART/.test(s)) {
    return '全家便利商店';
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

  const isForeignTx = /STEAM|NETFLIX|APPLE|SPOTIFY|GOOGLE|YOUTUBE|PLAYSTATION|NINTENDO|AMAZON|AGODA|BOOKING|AIRBNB|國外|海外|外幣|USD|JPY|EUR/.test(combined);

  let category = '一般消費';
  if (isVerifyAuth) category = '綁卡驗證';
  else if (isGasStation) category = '加油交通';
  else if (walletTankType === 'EASYCARD') category = '自動加值/儲值';
  else if (walletTankType === 'CASH') category = 'ATM提款';
  else if (/7-ELEVEN|全家|萊爾富|OK超商|便利商店/.test(combined)) category = '超商小額';
  else if (/五十嵐|清心|迷客夏|可不可|麻古|茶湯會|得正|一沐日|星巴克|路易莎|飲料|咖啡|麥香/.test(combined)) category = '手搖飲品';
  else if (/優食|UBEREATS|FOODPANDA|富胖達|餐廳|美食|小吃|便當|火鍋|燒肉|麥當勞|肯德基|摩斯|壽司/.test(combined)) category = '餐飲外食';
  else if (/STEAM|NETFLIX|SPOTIFY|APPLE|遊戲|娛樂|影城/.test(combined)) category = '數位娛樂';
  else if (/蝦皮|MOMO|PCHOME|淘寶|COUPANG|網購/.test(combined)) category = '網購剁手';

  return {
    category,
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
 * 解析玉山銀行通知文字（支援 Email、Wallet 推播、簡訊、iOS 捷徑文字）
 * 區分：
 *  - CHANNEL_A_AUTH (第 1 次通知：簽帳金融卡消費 / 授權 / 圈存)
 *  - CHANNEL_B_SETTLE (第 2 次通知：帳戶扣款 / 簽帳卡消費扣款 / 請款)
 *  - SALARY_IN (薪資入帳通知)
 *  - REFUND (刷退 / 取消授權 / 解圈退回)
 */
function parseEsunNotification(rawText, options = {}) {
  const cleanText = toHalfWidth(String(rawText || '')).trim();
  if (!cleanText) {
    throw new Error('通知文字不可為空');
  }

  const refDateStr = options.referenceDate || new Date().toISOString().slice(0, 10);
  const defaultYear = Number(refDateStr.slice(0, 4)) || new Date().getFullYear();

  // 1. 判定通道類型 (優先順序：薪資入帳 > 刷退沖銷 > 通道 B 請款扣款 > 通道 A 刷卡授權圈存)
  let channelType = 'CHANNEL_A_AUTH';
  if (/薪資入帳|薪水入帳|薪資轉帳|薪轉入帳|發薪入帳/.test(cleanText)) {
    channelType = 'SALARY_IN';
  } else if (/刷退|退貨|取消授權|解圈退回|沖銷入帳|退單/.test(cleanText)) {
    channelType = 'REFUND';
  } else if (/帳戶扣款|簽帳卡消費扣款|簽帳金融卡請款|商店請款|請款扣款|實際扣款|請款/.test(cleanText)) {
    channelType = 'CHANNEL_B_SETTLE';
  } else if (/簽帳金融卡消費|授權|刷卡|圈存|一般消費|消費通知/.test(cleanText)) {
    channelType = 'CHANNEL_A_AUTH';
  }

  // 2. 擷取金額 (優先匹配 NT$ / TWD / 新台幣 / $ 與「...元」，並以負向後行斷言排除日期的年份 2026/10/20)
  let amount = 0;
  const amountPatterns = [
    /(?:NT\$|TWD|新台幣|臺幣|\$)\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?![0-9]*[\/\-年])/i,
    /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*元/,
    /(?:金額|消費|扣款|入帳|刷退)[：:\s]*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?![0-9]*[\/\-年月])/i
  ];
  for (const pat of amountPatterns) {
    const m = cleanText.match(pat);
    if (m && m[1]) {
      amount = parseInt(m[1].replace(/,/g, ''), 10);
      break;
    }
  }

  // 3. 擷取「原始消費日期（刷卡日）」與「通知/請款當日日期」
  let originalTxDate = null;
  const origDateMatch = cleanText.match(/(?:原始交易日|原交易日|原消費日|原始消費日|刷卡日|消費日期|交易日)[：:\s]*(\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?|\d{1,2}[\/\-月]\d{1,2}日?)/);
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

  // 4. 擷取授權碼 (若有)
  let authCode = null;
  const authMatch = cleanText.match(/(?:授權碼|Auth\s*Code)[：:\s]*([A-Z0-9]{4,8})/i);
  if (authMatch) authCode = authMatch[1].toUpperCase();

  // 5. 擷取原始商店名稱 (優先提取「...」引號內店名，再提取商店標籤或於/在...消費結構)
  let rawMerchant = '未知商店';
  const quoteMatches = [...cleanText.matchAll(/[「『]([^」』]+)[」』]/g)];
  for (const qm of quoteMatches) {
    const candidate = qm[1].trim();
    if (candidate && !/玉山銀行|玉山Wallet|簽帳金融卡|帳戶扣款|薪資入帳/.test(candidate)) {
      rawMerchant = candidate;
      break;
    }
  }

  if (rawMerchant === '未知商店') {
    const merchantPatterns = [
      /(?:商店名稱|特約商店|消費商店|請款商店|請款扣款|商店)[：:\s]*([^」】\n，,。；;（(]+?)(?:\s*(?:消費|刷卡|請款|扣款|授權|刷退|金額|NT\$|TWD|新台幣|\$|\d+元|$))/i,
      /(?:於|在)\s*(?:\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?\s*(?:於|在)?\s*)?([^」】\n，,。；;（(]+?)\s*(?:刷卡|消費|請款|扣款|授權|刷退|金額|NT\$|TWD|新台幣)/i,
      /【([^】]+)】/
    ];
    for (const pat of merchantPatterns) {
      const m = cleanText.match(pat);
      if (m && m[1]) {
        const candidate = m[1].trim();
        if (candidate && !/玉山銀行|玉山Wallet|簽帳金融卡|帳戶扣款|薪資入帳|^\d{4}/.test(candidate)) {
          rawMerchant = candidate;
          break;
        }
      }
    }
  }
  if (rawMerchant === '未知商店' && channelType === 'SALARY_IN') {
    rawMerchant = '玉山薪資轉帳';
  }

  const normalizedMerchant = normalizeMerchant(rawMerchant);
  const classification = classifyTransaction(rawMerchant, normalizedMerchant, amount, cleanText);

  return {
    channelType,
    rawMerchant,
    normalizedMerchant,
    amount,
    txDate: originalTxDate || eventDate,
    originalTxDate, // null 代表通道 B 通知中未明確附帶原始刷卡日
    eventDate,
    authCode,
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

