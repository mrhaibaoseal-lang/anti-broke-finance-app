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
  if (/玉山\s*ATM\s*無卡存款|無卡存款/.test(s)) {
    return '玉山 ATM 無卡存款';
  }
  if (/玉山\s*ATM\s*現金存款|玉山\s*ATM\s*存款|ATM\s*現金存款|ATM\s*存款|ATM\s*存入|自動化設備存款|跨行存款/.test(s)) {
    return '玉山 ATM 存款';
  }
  if (/玉山帳戶轉帳入帳|轉帳入帳|轉帳存入|匯款入帳/.test(s)) {
    return '玉山帳戶轉帳入帳';
  }
  if (/玉山金融卡存款/.test(s)) {
    return '玉山金融卡存款';
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
 * 1.1 銀行刷卡／簽帳卡消費／授權圈存／商店請款攔截規則
 * 只要銀行通知內含「簽帳、消費、授權、卡號、刷卡、圈存、請款、預授權、信用卡」等字眼，一律攔截忽略，
 * 避免與 iOS 捷徑「Apple Pay 交易」重複記帳。
 */
const BANK_CARD_BLOCK_REGEX = /簽帳|消費|授權|卡號|刷卡|圈存|請款|預授權|信用卡|特店名稱|特約商店|刷退|取消授權|解圈/i;

function isBankCardNotification(rawText) {
  const clean = toHalfWidth(String(rawText || '')).trim();
  if (!clean) return false;
  return BANK_CARD_BLOCK_REGEX.test(clean);
}

/**
 * 自動推斷消費分類與特殊標記（已移除銀行試刷驗證與加油站預授權狀態機）
 */
function classifyTransaction(rawMerchant, normalizedMerchant, amount, rawText, channelType = null, manualCategoryTag = null) {
  const combined = `${rawMerchant} ${normalizedMerchant} ${rawText || ''}`.toUpperCase();
  const tag = String(manualCategoryTag || '').trim().toUpperCase();

  const isDeposit = channelType === 'DEPOSIT_IN' || channelType === 'SALARY_IN' || channelType === 'TRANSFER_IN';

  let walletTankType = null;
  if (!isDeposit) {
    if (/自動加值|悠遊卡|EASYCARD|全支付|IPASS\s*MONEY|一卡通MONEY|街口儲值/.test(combined)) {
      walletTankType = 'EASYCARD';
    } else if (/ATM\s*提款|ATM\s*提領|提款|現金提領|跨行提款|無卡提款/.test(combined)) {
      walletTankType = 'CASH';
    }
  }

  const isApplePay = !isDeposit && /APPLE\s*PAY|APPLE\s*錢包|APPLE\s*WALLET|感應刷卡|錢包交易/.test(combined);
  const isForeignTx = !isDeposit && /STEAM|NETFLIX|APPLE\.COM|APP\s*STORE|ITUNES|SPOTIFY|GOOGLE|YOUTUBE|PLAYSTATION|NINTENDO|AMAZON|AGODA|BOOKING|AIRBNB|國外|海外|外幣|USD|JPY|EUR/.test(combined);

  let category = '一般消費';
  if (tag === 'ADVANCE' || manualCategoryTag === '代墊款') {
    category = '代墊款';
  } else if (tag === 'TRANSFER' || manualCategoryTag === '內部互轉') {
    category = '內部互轉';
  } else if (tag === 'EXPENSE' || manualCategoryTag === '一般支出') {
    category = '一般支出';
  } else if (channelType === 'SALARY_IN' || /薪資入帳|薪水入帳|薪資轉帳/.test(combined)) {
    category = '薪資入帳';
  } else if (isDeposit) {
    if (/轉帳|匯款|收到/.test(combined) && !/ATM|無卡存款|現金存/.test(combined)) category = '轉帳入帳';
    else category = 'ATM存款';
  } else if (walletTankType === 'EASYCARD') {
    category = '自動加值/儲值';
  } else if (walletTankType === 'CASH') {
    category = 'ATM提款';
  } else if (/中油|加油站|全國加油|台亞|速邁樂|台塑石油/.test(combined)) {
    category = '加油交通';
  } else if (/7-ELEVEN|全家|萊爾富|OK超商|便利商店/.test(combined)) {
    category = '超商小額';
  } else if (/五十嵐|50嵐|清心|迷客夏|可不可|麻古|茶湯會|得正|一沐日|星巴克|路易莎|飲料|咖啡|麥香/.test(combined)) {
    category = '手搖飲品';
  } else if (/優食|UBEREATS|FOODPANDA|富胖達|餐廳|美食|小吃|便當|火鍋|燒肉|麥當勞|肯德基|摩斯|壽司/.test(combined)) {
    category = '餐飲外食';
  } else if (/STEAM|NETFLIX|SPOTIFY|APPLE\.COM|APP\s*STORE|ITUNES|遊戲|娛樂|影城/.test(combined)) {
    category = '數位娛樂';
  } else if (/蝦皮|MOMO|PCHOME|淘寶|COUPANG|網購/.test(combined)) {
    category = '網購剁手';
  } else if (channelType === 'TRANSFER_OUT') {
    category = '一般支出';
  }

  return {
    category,
    isDeposit,
    isApplePay,
    isVerifyAuth: false,
    isGasStation: category === '加油交通',
    isGasPreAuth: false,
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
 * 解析轉帳／收帳螢幕 OCR 文字（`raw_text`）或銀行轉帳／存款／薪資通知
 * 注意：若偵測到銀行刷卡／簽帳／消費／授權／卡號等字眼，直接標記為 IGNORED_CARD_TX 攔截丟棄
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

  if (!cleanText && !options.overrideAmount) {
    throw new Error('通知文字不可為空');
  }

  const refDateStr = options.referenceDate || new Date().toISOString().slice(0, 10);
  const defaultYear = Number(refDateStr.slice(0, 4)) || new Date().getFullYear();

  // 【步驟 1：徹底攔截銀行刷卡／簽帳卡消費／授權圈存／商店請款通知】
  if (options.source !== 'apple_pay' && isBankCardNotification(cleanText)) {
    return {
      channelType: 'IGNORED_CARD_TX',
      isBlockedCardNotification: true,
      direction: 'OUT',
      rawMerchant: '銀行刷卡通知(已攔截)',
      normalizedMerchant: '銀行刷卡通知(已攔截)',
      amount: 0,
      txDate: refDateStr,
      eventDate: refDateStr,
      rawText: cleanText
    };
  }

  // 擷取通知內附帶的「可用餘額」（若有），並從金額匹配字串中移除餘額干擾
  let reportedAvailableBalance = null;
  const balMatch = cleanText.match(/(?:可用餘額|帳戶可用餘額|帳戶餘額|台幣餘額|臺幣餘額)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?/i);
  if (balMatch && balMatch[1]) {
    reportedAvailableBalance = parseInt(balMatch[1].replace(/,/g, ''), 10);
  }

  const textForAmount = cleanText
    .replace(/(?:可用餘額|帳戶可用餘額|帳戶餘額|台幣餘額|臺幣餘額|剩餘額度)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*[0-9,]+(?:\.[0-9]+)?\s*元?/gi, ' ')
    .replace(/手續費(?:優惠|減免)?[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*[0-9,]+(?:\.[0-9]+)?\s*元?/gi, ' ')
    .replace(/(?:轉出帳號|轉入帳號|入帳帳號|扣款帳號|帳號|交易序號|序號)[：:\s]*[0-9\-\*＊\s]+/gi, ' ')
    .replace(/\b\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?\b/g, ' ')
    .replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g, ' ');

  let amount = Number(options.overrideAmount) > 0 ? Math.round(Number(options.overrideAmount)) : 0;
  if (!amount) {
    const amountPatterns = [
      /(?:轉帳金額|交易金額|轉出金額|匯款金額|付款金額|扣款金額|存入金額|存款金額|轉入金額|入帳金額|收款金額|實付金額|金額)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?(?![0-9]*[\/\-年月:])/i,
      /(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?(?![0-9]*[\/\-年:])/i,
      /(?<![0-9.])([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?\s*元/,
      /(?:轉出|轉入|存入|存款|入帳|轉帳|匯款|扣款)[：:\s]*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?(?![0-9]*[\/\-年月:])/i
    ];
    for (const pat of amountPatterns) {
      const m = textForAmount.match(pat);
      if (m && m[1]) {
        amount = parseInt(m[1].replace(/,/g, ''), 10);
        break;
      }
    }
  }

  // 判定方向 (IN 收帳/存款 vs OUT 轉帳支出/代墊/互轉) 與通道類型
  const manualTag = String(options.categoryTag || options.category || '').trim().toUpperCase();
  let direction = options.direction ? String(options.direction).toUpperCase() : null;
  let channelType = 'TRANSFER_OUT';

  if (/薪資入帳|薪水入帳|薪資轉帳|薪轉入帳|發薪入帳|薪資發放/.test(cleanText)) {
    channelType = 'SALARY_IN';
    direction = 'IN';
  } else if (direction === 'IN' || direction === 'OUT') {
    channelType = direction === 'IN' ? 'DEPOSIT_IN' : 'TRANSFER_OUT';
  } else {
    const hasOutScreenSignals = /轉帳成功|交易成功|轉出成功|匯款成功|付款成功|轉出帳號|轉出金額|轉帳給|轉給|匯出|帳戶提款|ATM\s*提款|無卡提款/.test(cleanText);
    const hasInSignals = /ATM\s*存款|ATM\s*存入|自動化設備存款|無卡存款|跨行存款|現金存款|現金存入|存款通知|存入通知|帳戶入帳|臺幣帳戶入帳|台幣帳戶入帳|臺幣存匯通知|轉帳入帳|轉帳存入|匯款入帳|收到轉帳|入帳通知|存入金額|存款金額/.test(cleanText);

    if (hasOutScreenSignals && !/收到轉帳|轉帳入帳|存入通知|入帳通知/.test(cleanText)) {
      direction = 'OUT';
      channelType = 'TRANSFER_OUT';
    } else if (hasInSignals) {
      direction = 'IN';
      channelType = 'DEPOSIT_IN';
    } else {
      direction = 'OUT';
      channelType = 'TRANSFER_OUT';
    }
  }

  const allDateMatches = [...cleanText.matchAll(/(\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?|\d{1,2}[\/\-月]\d{1,2}日?)/g)];
  let eventDate = refDateStr;
  if (allDateMatches.length > 0) {
    const firstDate = normalizeDateToken(allDateMatches[0][1], defaultYear);
    if (firstDate) eventDate = firstDate;
  }

  let txTimeMinute = null;
  const timeMatch = cleanText.match(/(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?/);
  if (timeMatch) {
    const parts = timeMatch[0].split(':');
    txTimeMinute = `${String(parts[0]).padStart(2, '0')}:${String(parts[1]).padStart(2, '0')}`;
  }

  let authCode = null;
  let rawMerchant = String(options.merchant || options.debtorName || '').trim();
  let noteText = '';
  const noteMatch = cleanText.match(/(?:備註|交易備註|附言|說明|用途|留言)[：:\s]*([^\n，,。；;]+)/i);
  if (noteMatch && noteMatch[1]) {
    noteText = noteMatch[1].trim();
  }

  const headerIgnoreRegex = /玉山|銀行|轉帳|通知|存匯|臺幣|台幣|成功|交易/i;
  if (!rawMerchant) {
    const quoteMatches = [...cleanText.matchAll(/[「『]([^」』]+)[」』]/g)];
    for (const qm of quoteMatches) {
      const candidate = qm[1].trim();
      if (candidate && !headerIgnoreRegex.test(candidate)) {
        rawMerchant = candidate;
        break;
      }
    }
  }
  if (!rawMerchant && noteText) {
    rawMerchant = noteText;
  }
  if (!rawMerchant) {
    const targetMatch = cleanText.match(/(?:轉入戶名|收款人|轉帳對象|轉給|收款帳號|轉入帳號)[：:\s]*([^\n，,。；;]+)/i);
    if (targetMatch && targetMatch[1]) {
      rawMerchant = `轉帳 (${targetMatch[1].trim().slice(0, 18)})`;
    }
  }
  if (!rawMerchant || rawMerchant === '未知商店') {
    if (channelType === 'SALARY_IN') {
      rawMerchant = '玉山薪資轉帳';
    } else if (direction === 'IN') {
      if (/無卡存款/.test(cleanText)) {
        rawMerchant = '玉山 ATM 無卡存款';
      } else if (/ATM|自動化設備|現金存|跨行存款/i.test(cleanText)) {
        rawMerchant = '玉山 ATM 存款';
      } else if (/轉帳|匯款|收到/.test(cleanText)) {
        rawMerchant = '玉山帳戶轉帳入帳';
      } else {
        rawMerchant = '玉山 ATM 存款';
      }
    } else {
      if (manualTag === 'ADVANCE') rawMerchant = '轉帳代墊款';
      else if (manualTag === 'TRANSFER') rawMerchant = '帳戶內部互轉';
      else rawMerchant = '銀行轉帳支出';
    }
  }

  const normalizedMerchant = normalizeMerchant(rawMerchant);
  const classification = classifyTransaction(rawMerchant, normalizedMerchant, amount, cleanText, channelType, manualTag);

  return {
    channelType,
    direction,
    categoryTag: manualTag || (direction === 'IN' ? 'DEPOSIT' : 'EXPENSE'),
    rawMerchant,
    normalizedMerchant,
    noteText,
    amount,
    txDate: eventDate,
    originalTxDate: eventDate,
    eventDate,
    txTimeMinute,
    authCode,
    reportedAvailableBalance,
    isBlockedCardNotification: false,
    ...classification,
    rawText: cleanText
  };
}

module.exports = {
  toHalfWidth,
  normalizeMerchant,
  computeMerchantSimilarity,
  isBankCardNotification,
  classifyTransaction,
  parseEsunNotification
};

