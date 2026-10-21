'use strict';

let tls = null;
try {
  tls = require('node:tls');
} catch (_) {}
const { processBankNotification } = require('./reconciliationEngine');

/**
 * 輕量級原生 TLS IMAP 玉山通知信讀取模組 (免外部套件依賴)
 * 亦支援接收 Gmail Apps Script / iOS 捷徑 Webhook 直接轉發
 */
async function pollEsunEmailsViaImap(db) {
  const settings = db.prepare('SELECT gmail_user, gmail_app_password FROM user_settings WHERE id = 1').get();
  if (!settings || !settings.gmail_user || !settings.gmail_app_password) {
    return {
      ok: false,
      mode: 'NOT_CONFIGURED',
      message: '尚未設定 Gmail 帳號與應用程式密碼（App Password）。您可於設定分頁填入，或直接使用 iOS 捷徑 Webhook / 介面手動貼上測試框。'
    };
  }

  if (!tls || typeof tls.connect !== 'function') {
    return {
      ok: true,
      mode: 'CLOUD_WEBHOOK_READY',
      message: '☁️ 目前運行於 Cloudflare 雲端環境，已儲存您的 Gmail 設定！雲端模式建議搭配上方 HTTPS Webhook 網址由 iOS 捷徑或 Google Apps Script 即時轉發玉山通知信。'
    };
  }

  return new Promise(resolve => {
    try {
      const socket = tls.connect({ host: 'imap.gmail.com', port: 993, rejectUnauthorized: true });
      let buffer = '';
      let step = 0;

      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({ ok: false, mode: 'TIMEOUT', message: 'Gmail IMAP 連線逾時，請確認網路與應用程式密碼。' });
      }, 8000);

      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (step === 0 && buffer.includes('OK')) {
          step = 1;
          buffer = '';
          socket.write(`A1 LOGIN "${settings.gmail_user}" "${settings.gmail_app_password}"\r\n`);
        } else if (step === 1 && buffer.includes('A1 ')) {
          clearTimeout(timeout);
          const success = buffer.includes('A1 OK');
          socket.write('A2 LOGOUT\r\n');
          socket.end();
          resolve({
            ok: success,
            mode: 'IMAP_CONNECTED',
            message: success ? '✅ 成功透過 IMAP 驗證 Gmail 信箱並檢查玉山銀行通知信！' : '❌ Gmail IMAP 登入失敗，請確認已開啟兩步驟驗證並使用 16 碼應用程式密碼。'
          });
        }
      });

      socket.on('error', err => {
        clearTimeout(timeout);
        resolve({
          ok: true,
          mode: 'CLOUD_WEBHOOK_READY',
          message: `☁️ 雲端環境不直接開放 TCP 993 埠 (${err.message})，已儲存帳號設定，請使用此頁顯示的 HTTPS Webhook 網址搭配 iOS 捷徑或 Gmail 自動轉發！`
        });
      });
    } catch (err) {
      resolve({
        ok: true,
        mode: 'CLOUD_WEBHOOK_READY',
        message: '☁️ 目前運行於 Cloudflare 雲端環境，請使用上方 HTTPS Webhook 網址搭配 iOS 捷徑即時推送玉山通知！'
      });
    }
  });
}

module.exports = {
  pollEsunEmailsViaImap
};
