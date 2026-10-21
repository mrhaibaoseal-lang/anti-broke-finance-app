'use strict';

let tls = null;
try {
  tls = require('node:tls');
} catch (_) {}
const { processBankNotification } = require('./reconciliationEngine');

const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatImapDate(dt) {
  const d = String(dt.getDate()).padStart(2, '0');
  const m = IMAP_MONTHS[dt.getMonth()];
  const y = dt.getFullYear();
  return `${d}-${m}-${y}`;
}

function base64ToUtf8(b64) {
  const clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return '';
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(clean, 'base64').toString('utf8');
    }
    if (typeof atob === 'function' && typeof TextDecoder !== 'undefined') {
      const bin = atob(clean);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }
  } catch (_) {}
  return '';
}

function decodeQuotedPrintableUtf8(qp) {
  const softJoined = String(qp || '').replace(/=\r?\n/g, '');
  try {
    const bytes = [];
    for (let i = 0; i < softJoined.length; i++) {
      if (softJoined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(softJoined.slice(i + 1, i + 3))) {
        bytes.push(parseInt(softJoined.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(softJoined.charCodeAt(i));
      }
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes).toString('utf8');
    }
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    }
  } catch (_) {}
  return softJoined;
}

function decodeRfc2047Word(str) {
  return String(str || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _charset, enc, payload) => {
    if (String(enc).toUpperCase() === 'B') {
      return base64ToUtf8(payload);
    }
    return decodeQuotedPrintableUtf8(String(payload).replace(/_/g, ' '));
  });
}

function stripHtmlTags(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 將原始 MIME 信件內容解碼為乾淨純文字（支援 Base64、Quoted-Printable、Multipart 與 HTML 表格）
 */
function decodeEmailMimeToText(rawMime) {
  const raw = String(rawMime || '');
  if (!raw.trim()) return '';

  const decodedHeaders = decodeRfc2047Word(raw);
  const subjectMatch = decodedHeaders.match(/^Subject:\s*(.+)$/im);
  const subject = subjectMatch ? subjectMatch[1].trim() : '';

  const decodedParts = [];
  if (subject) decodedParts.push(subject);

  const b64Blocks = raw.match(/(?:^[A-Za-z0-9+/]{40,76}\r?\n)+(?:[A-Za-z0-9+/=]{4,76})?/gm) || [];
  for (const blk of b64Blocks) {
    const txt = base64ToUtf8(blk);
    if (txt && /[\u4e00-\u9fa5]|NT\$|TWD|消費|刷卡|扣款|玉山/.test(txt)) {
      decodedParts.push(stripHtmlTags(txt));
    }
  }

  if (/=[0-9A-F]{2}=[0-9A-F]{2}=[0-9A-F]{2}/i.test(raw)) {
    const qpTxt = decodeQuotedPrintableUtf8(raw);
    decodedParts.push(stripHtmlTags(qpTxt));
  }

  if (decodedParts.length <= 1) {
    decodedParts.push(stripHtmlTags(decodedHeaders));
  }

  return decodedParts.join('\n').trim();
}

function isBankTransactionEmailText(text) {
  const t = String(text || '');
  const hasBankOrCard = /玉山|E\.?SUN|信用卡|簽帳金融卡|簽帳卡|消費通知|刷卡|帳戶扣款|請款|薪資入帳|薪資轉帳/i.test(t);
  const hasAmount = /(?:NT\$|TWD|新[台臺]幣|\$)\s*[0-9,]+|[0-9,]+\s*元/i.test(t);
  return hasBankOrCard && hasAmount;
}

function buildGoogleAppsScriptCode(webhookUrl) {
  const targetUrl = webhookUrl || 'https://anti-broke-finance-app.mr-haibaoseal.workers.dev/api/notifications/webhook';
  return `// ============================================================================
// 🛡️ 防破產記帳系統 — Gmail 刷卡通知 24 小時雲端全自動偵測腳本 (Google Apps Script)
// 設定步驟（只需設定一次，終身全自動，不需開電腦、不需手動貼上）：
// 1. 前往 https://script.google.com 新增專案，貼上此程式碼並按 Ctrl+S 儲存
// 2. 點選左側「觸發條件 (鬧鐘圖示)」➔「+ 新增觸發條件」
//    - 執行函式：autoSyncCreditCardNotifications
//    - 時間驅動 ➔ 分鐘計時器 ➔ 每分鐘 (或每 5 分鐘) ➔ 儲存
// ============================================================================

const WEBHOOK_URL = "${targetUrl}";

function autoSyncCreditCardNotifications() {
  const props = PropertiesService.getScriptProperties();
  const syncedIds = JSON.parse(props.getProperty("SYNCED_MSG_IDS") || "[]");
  const syncedSet = new Set(syncedIds);
  const query = 'newer_than:3d (玉山 OR esunbank OR 信用卡消費 OR 簽帳金融卡 OR 刷卡消費 OR 帳戶扣款 OR 薪資入帳)';
  const threads = GmailApp.search(query, 0, 15);
  let newSynced = false;

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const msgId = msg.getId();
      if (syncedSet.has(msgId)) continue;
      const subject = msg.getSubject() || "";
      const plainBody = msg.getPlainBody() || msg.getBody().replace(/<[^>]+>/g, " ");
      const fullText = "【" + subject + "】\\n" + plainBody;
      try {
        UrlFetchApp.fetch(WEBHOOK_URL, {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify({
            source: "gmail_gas_cloud_auto",
            emailUid: msgId,
            timestamp: msg.getDate().toISOString(),
            text: fullText
          }),
          muteHttpExceptions: true
        });
        syncedSet.add(msgId);
        newSynced = true;
      } catch (err) {}
    }
  }
  if (newSynced) {
    props.setProperty("SYNCED_MSG_IDS", JSON.stringify(Array.from(syncedSet).slice(-200)));
  }
}`;
}

function createUnifiedImapTransport(host, port, callbacks) {
  if (tls && typeof tls.connect === 'function') {
    const socket = tls.connect({ host, port, rejectUnauthorized: true });
    socket.on('data', chunk => callbacks.onData(chunk.toString('utf8')));
    socket.on('error', err => callbacks.onError(err));
    return {
      write(str) {
        try { socket.write(str); } catch (_) {}
      },
      close() {
        try { socket.end(); socket.destroy(); } catch (_) {}
      }
    };
  }

  if (typeof globalThis.__cfSocketConnect === 'function') {
    const sock = globalThis.__cfSocketConnect({ hostname: host, port }, { secureTransport: 'on' });
    const writer = sock.writable.getWriter();
    const reader = sock.readable.getReader();
    const decoder = new TextDecoder('utf-8');
    const encoder = new TextEncoder();

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) callbacks.onData(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        callbacks.onError(err);
      }
    })();

    return {
      write(str) {
        writer.write(encoder.encode(str)).catch(() => {});
      },
      close() {
        try { writer.close(); } catch (_) {}
        try { sock.close(); } catch (_) {}
      }
    };
  }

  return null;
}

/**
 * 原生 TLS / Cloudflare Sockets IMAP 玉山與信用卡通知信全自動掃描與對帳引擎
 */
async function pollEsunEmailsViaImap(db) {
  const settings = db.prepare('SELECT gmail_user, gmail_app_password FROM user_settings WHERE id = 1').get();
  if (!settings || !settings.gmail_user || !settings.gmail_app_password) {
    return {
      ok: false,
      mode: 'NOT_CONFIGURED',
      processedCount: 0,
      newTransactions: [],
      message: '請先輸入您的 Gmail 信箱與 16 碼 Google 應用程式密碼，系統即可每分鐘全自動抓取所有刷卡通知（含 Apple Pay、LINE Pay 與實體卡）！'
    };
  }

  const hasTransport = (tls && typeof tls.connect === 'function') || (typeof globalThis.__cfSocketConnect === 'function');
  if (!hasTransport) {
    return {
      ok: true,
      mode: 'CLOUD_WEBHOOK_READY',
      processedCount: 0,
      newTransactions: [],
      message: '已儲存您的 Gmail 設定！'
    };
  }

  const cleanPass = String(settings.gmail_app_password).replace(/\s+/g, '');

  return new Promise(resolve => {
    try {
      let buffer = '';
      let step = 0;
      const processedResults = [];
      let transport = null;

      const timeout = setTimeout(() => {
        if (transport) transport.close();
        resolve({
          ok: false,
          mode: 'TIMEOUT',
          processedCount: processedResults.length,
          newTransactions: processedResults,
          message: 'Gmail IMAP 連線逾時，請確認網路與 16 碼應用程式密碼是否正確。'
        });
      }, 12000);

      transport = createUnifiedImapTransport('imap.gmail.com', 993, {
        onData(chunkStr) {
          buffer += chunkStr;

          if (step === 0 && /^\* OK/m.test(buffer)) {
            step = 1;
            buffer = '';
            transport.write(`A1 LOGIN "${settings.gmail_user}" "${cleanPass}"\r\n`);
          } else if (step === 1 && /^A1 (OK|NO|BAD)/m.test(buffer)) {
            if (!/^A1 OK/m.test(buffer)) {
              clearTimeout(timeout);
              transport.write('A9 LOGOUT\r\n');
              transport.close();
              return resolve({
                ok: false,
                mode: 'AUTH_FAILED',
                processedCount: 0,
                newTransactions: [],
                message: '❌ Gmail 登入失敗：請確認填寫的是 Google「16 碼應用程式密碼」（而非一般 Gmail 登入密碼）。'
              });
            }
            step = 2;
            buffer = '';
            transport.write('A2 SELECT INBOX\r\n');
          } else if (step === 2 && /^A2 (OK|NO|BAD)/m.test(buffer)) {
            step = 3;
            buffer = '';
            const sinceDt = new Date(Date.now() - 7 * 86400000);
            transport.write(`A3 SEARCH SINCE ${formatImapDate(sinceDt)}\r\n`);
          } else if (step === 3 && /^A3 (OK|NO|BAD)/m.test(buffer)) {
            const searchMatch = buffer.match(/^\* SEARCH(?: (.+))?\r?$/m);
            const seqNums = searchMatch && searchMatch[1]
              ? searchMatch[1].trim().split(/\s+/).filter(Boolean).slice(-12)
              : [];

            buffer = '';
            if (seqNums.length === 0) {
              clearTimeout(timeout);
              transport.write('A5 LOGOUT\r\n');
              transport.close();
              return resolve({
                ok: true,
                mode: 'IMAP_SYNCED',
                processedCount: 0,
                newTransactions: [],
                message: '✅ Gmail 全自動連線成功！最近 7 天信箱內尚無新的刷卡通知信，之後每分鐘將自動在背景幫您抓信入帳！'
              });
            }

            step = 4;
            const fetchSet = seqNums.join(',');
            transport.write(`A4 FETCH ${fetchSet} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT])\r\n`);
          } else if (step === 4 && /^A4 (OK|NO|BAD)/m.test(buffer)) {
            clearTimeout(timeout);
            const rawResponse = buffer;
            buffer = '';
            transport.write('A5 LOGOUT\r\n');
            transport.close();

            const msgBlocks = rawResponse.split(/^\* \d+ FETCH /m).slice(1);
            for (const block of msgBlocks) {
              const uidMatch = block.match(/UID\s+(\d+)/i);
              const uid = uidMatch ? uidMatch[1] : null;
              const decodedText = decodeEmailMimeToText(block);
              if (!isBankTransactionEmailText(decodedText)) continue;

              try {
                const res = processBankNotification(db, decodedText, {
                  source: 'gmail_imap_auto',
                  emailUid: uid || undefined
                });
                if (res && res.resultType !== 'DEBOUNCE_IGNORED') {
                  processedResults.push(res);
                }
              } catch (_) {}
            }

            resolve({
              ok: true,
              mode: 'IMAP_SYNCED',
              processedCount: processedResults.length,
              newTransactions: processedResults,
              message: processedResults.length > 0
                ? `⚡ 全自動偵測成功！已從 Gmail 自動抓取並寫入 ${processedResults.length} 筆最新刷卡/入帳紀錄！`
                : '✅ Gmail 全自動連線成功！目前已同步所有刷卡通知，系統將在背景每分鐘自動抓信！'
            });
          }
        },
        onError(err) {
          clearTimeout(timeout);
          resolve({
            ok: false,
            mode: 'SOCKET_ERROR',
            processedCount: 0,
            newTransactions: [],
            message: `連線異常 (${err?.message || 'Socket Error'})，請確認 Gmail 與 16 碼密碼。`
          });
        }
      });
    } catch (err) {
      resolve({
        ok: false,
        mode: 'ERROR',
        processedCount: 0,
        newTransactions: [],
        message: `連線錯誤：${err?.message || '未知錯誤'}`
      });
    }
  });
}

module.exports = {
  pollEsunEmailsViaImap,
  decodeEmailMimeToText,
  isBankTransactionEmailText,
  buildGoogleAppsScriptCode
};
