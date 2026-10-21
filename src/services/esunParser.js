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
 * 自動推斷消費分類與特殊標記
 */
function classifyTransaction(rawMerchant, normalizedMerchant, amount, rawText, channelType = null) {
  const combined = `${rawMerchant} ${normalizedMerchant} ${rawText || ''}`.toUpperCase();

  const isVerifyAuth = amount === 1 || amount === 2;
  const isGasStation = /中油|加油站|全國加油|台亞|速邁樂|台塑石油/.test(combined);
  const isGasPreAuth = isGasStation && (amount === 1500 || amount === 2250);

  const isDeposit = channelType === 'DEPOSIT_IN' || channelType === 'SALARY_IN' || (
    /ATM\s*存款|ATM\s*存入|ATM\s*現金存款|ATM\s*現金存入|自動化設備存款|無卡存款|跨行存款|現金存款|現金存入|存款通知|存入通知|帳戶入帳|臺幣帳戶入帳|台幣帳戶入帳|臺幣存匯|轉帳入帳|轉帳存入|匯款入帳|收到轉帳/.test(combined) &&
    !/提款|提領|刷退|取消授權|請款入帳|帳單請款/.test(combined)
  );

  let walletTankType = null;
  if (!isDeposit) {
    if (/自動加值|悠遊卡|EASYCARD|全支付|IPASS\s*MONEY|一卡通MONEY|街口儲值/.test(combined)) {
      walletTankType = 'EASYCARD';
    } else if (/ATM\s*提款|ATM\s*提領|提款|現金提領|跨行提款|無卡提款/.test(combined) || (/ATM/.test(combined) && !/存款|存入|入帳/.test(combined))) {
      walletTankType = 'CASH';
    }
  }

  const isApplePay = !isDeposit && /APPLE\s*PAY|APPLE\s*錢包|APPLE\s*WALLET|感應刷卡|錢包交易/.test(combined);
  const isForeignTx = !isDeposit && /STEAM|NETFLIX|APPLE\.COM|APP\s*STORE|ITUNES|SPOTIFY|GOOGLE|YOUTUBE|PLAYSTATION|NINTENDO|AMAZON|AGODA|BOOKING|AIRBNB|國外|海外|外幣|USD|JPY|EUR/.test(combined);

  let category = '一般消費';
  if (channelType === 'SALARY_IN' || /薪資入帳|薪水入帳|薪資轉帳/.test(combined)) category = '薪資入帳';
  else if (isDeposit) {
    if (/轉帳|匯款/.test(combined) && !/ATM|無卡存款|現金存/.test(combined)) category = '轉帳入帳';
    else category = 'ATM存款';
  }
  else if (isVerifyAuth) category = '綁卡驗證';
  else if (isGasStation) category = '加油交通';
  else if (walletTankType === 'EASYCARD') category = '自動加值/儲值';
  else if (walletTankType === 'CASH') category = 'ATM提款';
  else if (/7-ELEVEN|全家|萊爾富|OK超商|便利商店/.test(combined)) category = '超商小額';
  else if (/五十嵐|清心|迷客夏|可不可|麻古|茶湯會|得正|一沐日|星巴克|路易莎|飲料|咖啡|麥香/.test(combined)) category = '手搖飲品';
  else if (/優食|UBEREATS|FOODPANDA|富胖達|餐廳|美食|小吃|便當|火鍋|燒肉|麥當勞|肯德基|摩斯|壽司/.test(combined)) category = '餐飲外食';
  else if (/STEAM|NETFLIX|SPOTIFY|APPLE\.COM|APP\s*STORE|ITUNES|遊戲|娛樂|影城/.test(combined)) category = '數位娛樂';
  else if (/蝦皮|MOMO|PCHOME|淘寶|COUPANG|網購/.test(combined)) category = '網購剁手';

  return {
    category,
    isDeposit,
    isApplePay,
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
 * 解析玉山銀行與台灣常見信用卡/簽帳金融卡通知文字（支援 Email、Wallet 推播、LINE 通知、簡訊、iOS/Android 捷徑文字）
 * 區分：
 *  - CHANNEL_A_AUTH (第 1 次通知：信用卡刷卡 / 簽帳金融卡消費 / 授權 / 圈存)
 *  - CHANNEL_B_SETTLE (第 2 次通知：帳戶扣款 / 簽帳卡消費扣款 / 商店請款 / 帳單請款)
 *  - SALARY_IN (薪資入帳通知)
 *  - REFUND (刷退 / 取消授權 / 解圈退回)
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

  if (!cleanText) {
    throw new Error('通知文字不可為空');
  }

  // 排除雲端服務預算警示、廣告預算上限等非扣款通知
  if (/支出上限警告|預算上限|支出金額上限|達到支出金額上限|Google Cloud.*帳戶/i.test(cleanText)) {
    throw new Error('非銀行扣款或帳戶通知（已自動過濾雲端預算警示）');
  }

  const refDateStr = options.referenceDate || new Date().toISOString().slice(0, 10);
  const defaultYear = Number(refDateStr.slice(0, 4)) || new Date().getFullYear();

  // 剔除銀行推播/信件末尾常見的「實際請款金額以帳單/商店請款為準」免責聲明，避免將通道 A 刷卡誤判為通道 B 請款
  const textWithoutDisclaimer = cleanText
    .replace(/(?:實際|最終)?(?:請款|扣款|入帳)金額以(?:帳單|特約商店|商店請款|實際請款|銀行帳單)[^。；\n]*/g, '')
    .replace(/本筆交易為(?:授權|圈存)[^。；\n]*待(?:特約)?商店請款[^。；\n]*/g, '')
    .replace(/待(?:特約)?商店請款後(?:始進行)?扣款/g, '')
    .replace(/尚未請款|未請款/g, '');

  // 1. 判定通道類型 (優先順序：薪資入帳 > 刷退沖銷 > ATM存款/帳戶入帳 > 通道 B 請款扣款 > 通道 A 刷卡授權圈存)
  let channelType = 'CHANNEL_A_AUTH';
  if (/薪資入帳|薪水入帳|薪資轉帳|薪轉入帳|發薪入帳|薪資發放/.test(textWithoutDisclaimer)) {
    channelType = 'SALARY_IN';
  } else if (/刷退|退貨|取消授權|解圈退回|沖銷入帳|退單|取消交易|退款/.test(textWithoutDisclaimer)) {
    channelType = 'REFUND';
  } else if (
    /ATM\s*存款|ATM\s*存入|ATM\s*現金存款|ATM\s*現金存入|自動化設備存款|無卡存款|跨行存款|現金存款|現金存入|存款通知|存入通知|帳戶入帳|臺幣帳戶入帳|台幣帳戶入帳|臺幣存匯通知|轉帳入帳|轉帳存入|匯款入帳|收到轉帳|存入金額|存款金額|存入\s*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$|\d)/i.test(textWithoutDisclaimer) &&
    !/帳戶扣款|簽帳卡消費扣款|簽帳金融卡請款|商店請款|請款扣款|實際請款扣款|實際扣款|請款入帳|帳單請款|一般消費|刷卡消費|感應刷卡|提款|提領/.test(textWithoutDisclaimer)
  ) {
    channelType = 'DEPOSIT_IN';
  } else if (/帳戶扣款|簽帳卡消費扣款|簽帳金融卡請款|商店請款|請款扣款|實際請款扣款|實際扣款|請款入帳|帳單請款/.test(textWithoutDisclaimer)) {
    channelType = 'CHANNEL_B_SETTLE';
  } else if (/信用卡|簽帳金融卡|簽帳卡|玉山卡|授權|刷卡|圈存|一般消費|消費通知|消費金額|特店名稱|新增消費/.test(textWithoutDisclaimer)) {
    channelType = 'CHANNEL_A_AUTH';
  } else if (/請款/.test(textWithoutDisclaimer)) {
    channelType = 'CHANNEL_B_SETTLE';
  }

  // 1.5 辨識卡別 (CREDIT 信用卡 vs DEBIT 簽帳金融卡) 與卡號末四碼
  const cardType = /簽帳金融卡|簽帳卡|DEBIT|圈存|帳戶扣款/.test(cleanText) ? 'DEBIT' : 'CREDIT';
  let cardLast4 = null;
  const last4Match = cleanText.match(/(?:末四碼|末4碼|卡號末四碼|卡號|\*)\s*([0-9]{4})(?!\d)/);
  if (last4Match) cardLast4 = last4Match[1];

  // 1.6 擷取通知內附帶的「可用餘額」（若有），並從金額匹配字串中移除餘額與卡號干擾
  let reportedAvailableBalance = null;
  const balMatch = cleanText.match(/(?:可用餘額|帳戶可用餘額|帳戶餘額)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?/i);
  if (balMatch && balMatch[1]) {
    reportedAvailableBalance = parseInt(balMatch[1].replace(/,/g, ''), 10);
  }

  const textForAmount = cleanText
    .replace(/(?:可用餘額|帳戶可用餘額|帳戶餘額|剩餘額度|信用額度)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*[0-9,]+(?:\.[0-9]+)?\s*元?/gi, ' ')
    .replace(/(?:卡號)?(?:末四碼|末4碼)[：:\s(（]*[0-9]{4}[)）]?/g, ' ');

  // 2. 擷取金額 (支援整數與 .00 小數格式，優先匹配消費/扣款/存款/金額標籤與 NT$/TWD/新臺幣，並排除日期年份)
  let amount = 0;
  const amountPatterns = [
    /(?:消費金額|刷卡金額|交易金額|實際請款扣款|請款扣款|實際扣款|扣款金額|請款金額|授權金額|存入金額|存款金額|轉入金額|入帳金額|刷退金額|金額)[：:\s]*(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?(?![0-9]*[\/\-年月:])/i,
    /(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?(?![0-9]*[\/\-年:])/i,
    /(?<![0-9.])([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?\s*元/,
    /(?:消費|扣款|存入|存款|入帳|刷退|刷卡|授權)[：:\s]*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?(?![0-9]*[\/\-年月:])/i
  ];
  for (const pat of amountPatterns) {
    const m = textForAmount.match(pat);
    if (m && m[1]) {
      amount = parseInt(m[1].replace(/,/g, ''), 10);
      break;
    }
  }

  // 3. 擷取「原始消費日期（刷卡日）」、「通知/請款當日日期」與「精確刷卡時間 (HH:mm)」
  let originalTxDate = null;
  const origDateMatch = cleanText.match(/(?:原始交易日|原交易日|原消費日|原始消費日|刷卡日|消費日期|交易日期|交易日)[：:\s]*(\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?|\d{1,2}[\/\-月]\d{1,2}日?)/);
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

  let txTimeMinute = null;
  const timeMatch = cleanText.match(/(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?/);
  if (timeMatch) {
    const parts = timeMatch[0].split(':');
    txTimeMinute = `${String(parts[0]).padStart(2, '0')}:${String(parts[1]).padStart(2, '0')}`;
  }

  // 4. 擷取授權碼 (若有)
  let authCode = null;
  const authMatch = cleanText.match(/(?:授權碼|Auth\s*Code)[：:\s]*([A-Z0-9]{4,8})/i);
  if (authMatch) authCode = authMatch[1].toUpperCase();

  // 5. 擷取原始商店名稱 (優先提取「...」引號內店名，再提取結構化欄位或於/在...消費結構)
  const headerIgnoreRegex = /玉山|銀行|信用卡|簽帳|消費通知|刷卡通知|授權通知|扣款通知|請款通知|帳戶扣款|薪資入帳|交易通知|入帳通知|^一般消費$|^Apple\s*Pay(?:\s*感應刷卡)?$|^Apple\s*錢包$/i;
  let rawMerchant = '未知商店';
  const quoteMatches = [...cleanText.matchAll(/[「『]([^」』]+)[」』]/g)];
  for (const qm of quoteMatches) {
    const candidate = qm[1].trim();
    if (candidate && !headerIgnoreRegex.test(candidate)) {
      rawMerchant = candidate;
      break;
    }
  }

  if (rawMerchant === '未知商店') {
    const merchantPatterns = [
      /(?:特店名稱|商店名稱|特約商店|消費商店|請款商店|交易地點|消費地點|商家名稱|商家|請款扣款|商店)\s*[：:]\s*([^」】\n，,。；;（(]+?)(?:\s*(?:消費金額|刷卡金額|交易金額|實際請款|一般消費|消費|刷卡|請款|扣款|授權|刷退|金額|NT\$|TWD|新[台臺]幣|\$|\d+元|$))/i,
      /(?:於|在)\s*(?:\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s*(?:於|在)?\s*)?([^」】\n，,。；;（(]+?)\s*(?:使用\s*Apple\s*Pay\s*)?(?:一般消費|刷卡消費|感應刷卡|刷卡|消費|請款|扣款|授權|刷退|金額|NT\$|TWD|新[台臺]幣)/i,
      /【([^】]+)】/
    ];
    for (const pat of merchantPatterns) {
      const m = cleanText.match(pat);
      if (m && m[1]) {
        const candidate = m[1].trim();
        if (candidate && !headerIgnoreRegex.test(candidate) && !/^\d{4}/.test(candidate)) {
          rawMerchant = candidate;
          break;
        }
      }
    }
  }
  if (rawMerchant === '未知商店' && channelType === 'SALARY_IN') {
    rawMerchant = '玉山薪資轉帳';
  }
  if (channelType === 'DEPOSIT_IN') {
    if (/無卡存款/.test(cleanText)) {
      rawMerchant = '玉山 ATM 無卡存款';
    } else if (/ATM|自動化設備|現金存|跨行存款/i.test(cleanText)) {
      rawMerchant = '玉山 ATM 存款';
    } else if (/轉帳|匯款/.test(cleanText)) {
      rawMerchant = '玉山帳戶轉帳入帳';
    } else if (rawMerchant === '未知商店' || /存款通知|入帳通知|存入通知|臺幣帳戶|台幣帳戶/.test(rawMerchant)) {
      rawMerchant = '玉山 ATM 存款';
    }
  }

  // 5.5 針對新版 iOS AI 捷徑或極簡 Apple Pay 交易文字（如「星巴克 NT$155」或「NT$155 麥當勞」）的智慧店名擷取兜底
  if (rawMerchant === '未知商店' && channelType === 'CHANNEL_A_AUTH') {
    const residual = cleanText
      .replace(/【[^】]*】/g, ' ')
      .replace(/\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?/g, ' ')
      .replace(/\d{1,2}[\/\-月]\d{1,2}日?/g, ' ')
      .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
      .replace(/(?:NT\$|TWD|新[台臺]幣|[台臺]幣|\$)\s*[0-9,]+(?:\.[0-9]+)?\s*元?/gi, ' ')
      .replace(/[0-9,]+(?:\.[0-9]+)?\s*元/g, ' ')
      .replace(/(?:Apple\s*Pay|感應刷卡|一般消費|刷卡消費|消費通知|刷卡通知|交易通知|使用|您的|玉山銀行卡|玉山銀行|玉山信用卡|玉山簽帳金融卡|玉山簽帳卡|玉山Wallet|玉山\s*U\s*Bear|信用卡|簽帳金融卡|簽帳卡|綁定卡|末四碼\s*\d{4}|末4碼\s*\d{4})/gi, ' ')
      .replace(/[，,。；;：:（）()「」『』\[\]\-]+/g, ' ')
      .trim();
    const tokens = residual.split(/\s+/).filter(t => t && !/^\d+$/.test(t) && !headerIgnoreRegex.test(t));
    if (tokens.length > 0) {
      rawMerchant = tokens.slice(0, 2).join(' ');
    }
  }

  const normalizedMerchant = normalizeMerchant(rawMerchant);
  const classification = classifyTransaction(rawMerchant, normalizedMerchant, amount, cleanText, channelType);

  return {
    channelType,
    cardType,
    cardLast4,
    rawMerchant,
    normalizedMerchant,
    amount,
    txDate: originalTxDate || eventDate,
    originalTxDate, // null 代表通道 B 通知中未明確附帶原始刷卡日
    eventDate,
    txTimeMinute,
    authCode,
    reportedAvailableBalance,
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

