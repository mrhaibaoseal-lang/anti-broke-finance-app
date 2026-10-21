'use strict';

const { parseEsunNotification, computeMerchantSimilarity, normalizeMerchant } = require('./esunParser');
const { ensureCurrentCycle, applyActualSalaryDeposit } = require('./survivalEngine');

const DEBOUNCE_WINDOW_MS = 3 * 60 * 1000; // 3 分鐘防抖動鎖 (180,000 ms)
const FX_TOLERANCE_RATIO = 0.06;          // 海外匯差與 1.5% 手續費 ±6% 容許誤差

function daysBetween(dateA, dateB) {
  const a = new Date(`${String(dateA).slice(0, 10)}T00:00:00`).getTime();
  const b = new Date(`${String(dateB).slice(0, 10)}T00:00:00`).getTime();
  return Math.round((b - a) / 86400000);
}

function creditWalletTankFromTx(db, tankType, amount, note, txId, nowIso) {
  const tank = db.prepare('SELECT * FROM wallet_tank WHERE id = 1').get();
  if (!tank) return;
  const col = tankType === 'CASH' ? 'cash_balance' : 'easycard_balance';
  const newBalance = (Number(tank[col]) || 0) + Number(amount);

  db.prepare(`UPDATE wallet_tank SET ${col} = ?, updated_at = ? WHERE id = 1`).run(newBalance, nowIso);
  db.prepare(`
    INSERT INTO wallet_tank_logs (tank_type, delta_amount, balance_after, note, linked_tx_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tankType, Number(amount), newBalance, note, txId, nowIso);
}

function checkDebounceDuplicate(db, dedupeHash, nowIso, parsed = null) {
  const nowMs = new Date(nowIso).getTime();
  const recentLogs = db.prepare(`
    SELECT id, received_at, linked_tx_id
    FROM notification_logs
    WHERE channel_type = 'CHANNEL_A_AUTH' AND dedupe_hash = ?
    ORDER BY id DESC LIMIT 5
  `).all(dedupeHash);

  for (const log of recentLogs) {
    const diffMs = Math.abs(nowMs - new Date(log.received_at).getTime());
    if (diffMs <= DEBOUNCE_WINDOW_MS) {
      return {
        isDuplicate: true,
        diffSeconds: Math.round(diffMs / 1000),
        originalTxId: log.linked_tx_id
      };
    }
  }

  // 進階跨管道防重（例如：手機推播先到、Gmail 通知信稍後收進來，具有相同 Email UID、相同刷卡時間 HH:mm 或相同授權碼 AuthCode）
  if (parsed && (parsed.authCode || parsed.txTimeMinute || parsed.emailUid)) {
    if (parsed.emailUid) {
      const logs = db.prepare('SELECT * FROM notification_logs ORDER BY id DESC LIMIT 100').all();
      const uidTag = `[UID:${parsed.emailUid}]`;
      const hitLog = logs.find(l => String(l.action_taken || '').includes(uidTag) || String(l.raw_text || '').includes(uidTag));
      if (hitLog) {
        return { isDuplicate: true, diffSeconds: 0, originalTxId: hitLog.linked_tx_id, reason: 'SAME_EMAIL_UID' };
      }
    }
    const candidates = db.prepare(`
      SELECT * FROM transactions
      WHERE status IN ('PENDING', 'TEMP_HOLD') AND is_reconciled_locked = 0
      ORDER BY tx_date ASC, tx_timestamp ASC, id ASC
    `).all();
    for (const tx of candidates) {
      if (tx.tx_date !== parsed.txDate || Number(tx.auth_amount) !== Number(parsed.amount)) continue;
      if (tx.normalized_merchant !== parsed.normalizedMerchant) continue;
      if (parsed.authCode && tx.auth_code && parsed.authCode === tx.auth_code) {
        return { isDuplicate: true, diffSeconds: 0, originalTxId: tx.id, reason: 'SAME_AUTH_CODE' };
      }
      if (parsed.txTimeMinute && tx.channel_a_raw && tx.channel_a_raw.includes(parsed.txTimeMinute)) {
        return { isDuplicate: true, diffSeconds: 0, originalTxId: tx.id, reason: 'SAME_TX_TIME_MINUTE' };
      }
    }
  }

  return { isDuplicate: false };
}

/**
 * 2.2 & 2.3 通道 B 核銷配對演算法 (1-to-1 Lock + 權重配對 + FIFO + ±6% 海外匯差自動修正)
 */
function findBestPendingMatch(db, parsed, referenceDateStr) {
  const refDate = (referenceDateStr || parsed.eventDate || new Date().toISOString().slice(0, 10)).slice(0, 10);

  const candidates = db.prepare(`
    SELECT * FROM transactions
    WHERE status IN ('PENDING', 'TEMP_HOLD') AND is_reconciled_locked = 0
    ORDER BY tx_date ASC, tx_timestamp ASC, id ASC
  `).all().filter(tx => {
    const ageDays = daysBetween(tx.tx_date, refDate);
    return ageDays >= -1 && ageDays <= 30;
  });

  if (candidates.length === 0) return null;

  // 第一階段：金額 100% 相符（或加油站 TEMP_HOLD 預授權轉實扣）
  // 權重：金額相符 (60%) + 原始消費日期相符 (30%) + 商店關鍵字相符 (10%)
  const exactMatches = [];
  for (const tx of candidates) {
    const merchantSim = computeMerchantSimilarity(tx.normalized_merchant, parsed.normalizedMerchant);
    const isGasTempHoldMatch = tx.status === 'TEMP_HOLD' && merchantSim >= 0.6;
    const isExactAmount = tx.auth_amount === parsed.amount;

    if (!isExactAmount && !isGasTempHoldMatch) continue;
    if (merchantSim < 0.35 && tx.auth_code !== parsed.authCode) continue;

    const amountWeight = 60;
    let dateWeight = 15;
    if (parsed.originalTxDate) {
      if (tx.tx_date === parsed.originalTxDate) dateWeight = 30;
      else if (Math.abs(daysBetween(tx.tx_date, parsed.originalTxDate)) <= 1) dateWeight = 15;
      else dateWeight = 0;
    }

    const merchantWeight = Number((merchantSim * 10).toFixed(2));
    const authCodeBonus = (parsed.authCode && tx.auth_code && parsed.authCode === tx.auth_code) ? 5 : 0;
    const totalScore = Number((amountWeight + dateWeight + merchantWeight + authCodeBonus).toFixed(2));

    exactMatches.push({
      tx,
      score: totalScore,
      merchantSim,
      matchType: isGasTempHoldMatch ? 'GAS_PREAUTH_SETTLE' : 'EXACT_FIFO_MATCH',
      fxFeeDiff: 0
    });
  }

  if (exactMatches.length > 0) {
    exactMatches.sort((a, b) => b.score - a.score);
    return exactMatches[0];
  }

  // 第二階段：跨國交易匯差與 1.5% 手續費自動修正 (±6% 容許誤差比對)
  const fxMatches = [];
  for (const tx of candidates) {
    if (tx.status !== 'PENDING' || tx.auth_amount <= 0) continue;
    const merchantSim = computeMerchantSimilarity(tx.normalized_merchant, parsed.normalizedMerchant);
    if (merchantSim < 0.5) continue;

    const diffRatio = Math.abs(parsed.amount - tx.auth_amount) / tx.auth_amount;
    if (diffRatio <= FX_TOLERANCE_RATIO) {
      let dateWeight = 15;
      if (parsed.originalTxDate) {
        if (tx.tx_date === parsed.originalTxDate) dateWeight = 30;
        else if (Math.abs(daysBetween(tx.tx_date, parsed.originalTxDate)) <= 2) dateWeight = 15;
        else continue;
      }
      const amountAccuracyScore = Number(((1 - diffRatio) * 60).toFixed(2));
      const merchantWeight = Number((merchantSim * 10).toFixed(2));
      const totalScore = Number((amountAccuracyScore + dateWeight + merchantWeight).toFixed(2));

      fxMatches.push({
        tx,
        score: totalScore,
        merchantSim,
        matchType: 'FX_TOLERANCE_MATCH',
        fxFeeDiff: parsed.amount - tx.auth_amount,
        diffPercent: Number((diffRatio * 100).toFixed(2))
      });
    }
  }

  if (fxMatches.length > 0) {
    fxMatches.sort((a, b) => b.score - a.score);
    return fxMatches[0];
  }

  return null;
}

function processBankNotification(db, rawText, options = {}) {
  const nowIso = options.timestamp || new Date().toISOString();
  const refDate = (options.referenceDate || nowIso.slice(0, 10)).slice(0, 10);
  const source = options.source || 'manual';

  const parsed = parseEsunNotification(rawText, { referenceDate: refDate });
  if (options.emailUid) {
    parsed.emailUid = String(options.emailUid);
  }
  const uidSuffix = parsed.emailUid ? ` [UID:${parsed.emailUid}]` : '';
  const cycle = ensureCurrentCycle(db, parsed.txDate || refDate);
  const dedupeHash = `${parsed.normalizedMerchant}|${parsed.amount}`;

  // 情境 1：玉山薪資入帳通知 -> 自動以真實入帳金額覆蓋當月預估值
  if (parsed.channelType === 'SALARY_IN') {
    const updatedCycle = applyActualSalaryDeposit(db, parsed.amount, refDate);
    const actionMsg = `💰 薪資入帳自動校正：以真實薪資 $${parsed.amount} 覆蓋原預估實領 ($${cycle.estimated_net_pay})`;
    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'SALARY_IN', ?, ?, ?, ?, NULL, ?, ?)
    `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, actionMsg, rawText, nowIso);

    return {
      resultType: 'SALARY_CALIBRATED',
      channelType: 'SALARY_IN',
      message: actionMsg,
      cycle: updatedCycle,
      parsed
    };
  }

  // 情境 2：收到銀行正式「刷退 / 取消授權」通知 -> 沖銷原消費並加回預算（先買後退原則）
  if (parsed.channelType === 'REFUND') {
    const targetTx = db.prepare(`
      SELECT * FROM transactions
      WHERE status IN ('PENDING', 'SETTLED')
        AND (normalized_merchant = ? OR auth_amount = ? OR effective_amount = ?)
      ORDER BY id DESC LIMIT 1
    `).get(parsed.normalizedMerchant, parsed.amount, parsed.amount);

    if (targetTx) {
      const note = `已收到銀行正式刷退通知（沖銷原消費 +$${targetTx.personal_amount} 加回安全預算）`;
      db.prepare(`
        UPDATE transactions SET status = 'CANCELED', personal_amount = 0, reconcile_note = ? WHERE id = ?
      `).run(note, targetTx.id);

      db.prepare(`
        INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
        VALUES (?, 'REFUND', ?, ?, ?, ?, ?, ?, ?)
      `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, note, targetTx.id, rawText, nowIso);

      return {
        resultType: 'REFUND_APPLIED',
        channelType: 'REFUND',
        message: note,
        transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(targetTx.id),
        parsed
      };
    }
  }

  // 情境 3：通道 A（第 1 次通知：簽帳金融卡消費 / 授權圈存 / 信用卡刷卡）
  if (parsed.channelType === 'CHANNEL_A_AUTH') {
    const debounce = checkDebounceDuplicate(db, dedupeHash, nowIso, parsed);
    if (debounce.isDuplicate) {
      const ignoreMsg = `🛡️ 防重複扣款鎖觸發：與既有「${parsed.normalizedMerchant} $${parsed.amount}」為同一筆刷卡通知，已自動忽略不重複扣款！${uidSuffix}`;
      db.prepare(`
        INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
        VALUES (?, 'IGNORED_DEBOUNCE', ?, ?, ?, ?, ?, ?, ?)
      `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, ignoreMsg, debounce.originalTxId, rawText, nowIso);

      return {
        resultType: 'DEBOUNCE_IGNORED',
        channelType: 'CHANNEL_A_AUTH',
        message: ignoreMsg,
        originalTxId: debounce.originalTxId,
        parsed
      };
    }

    let status = 'PENDING';
    let personalAmount = parsed.amount;
    const cardLabel = parsed.cardType === 'CREDIT' ? '信用卡刷卡' : '簽帳卡圈存';
    let reconcileNote = `${cardLabel}（已立即從當月可用安全預算精準扣除 $${parsed.amount}）${uidSuffix}`;

    if (parsed.isVerifyAuth) {
      status = 'AUTH_VERIFY';
      personalAmount = 0;
      reconcileNote = '卡片綁定驗證（NT$1~2 不計入消費，14天後自動歸檔）';
    } else if (parsed.isGasPreAuth) {
      status = 'TEMP_HOLD';
      personalAmount = 0;
      reconcileNote = '⛽ 加油站大額預授權（暫不扣除全額預算，請手動輸入實際加油金額或等請款通知自動扣款）';
    }

    const insertRes = db.prepare(`
      INSERT INTO transactions (
        cycle_key, status, raw_merchant, normalized_merchant, category,
        auth_amount, settled_amount, fx_fee_diff, effective_amount, personal_amount,
        tx_date, tx_timestamp, settled_at, auth_code, is_reconciled_locked,
        reconcile_score, reconcile_note, is_foreign_tx, is_ghost_alerted,
        channel_a_raw, channel_b_raw, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, NULL, ?, 0, NULL, ?, ?, 0, ?, NULL, ?)
    `).run(
      cycle.cycle_key, status, parsed.rawMerchant, parsed.normalizedMerchant, parsed.category,
      parsed.amount, parsed.amount, personalAmount,
      parsed.txDate, nowIso, parsed.authCode, reconcileNote, parsed.isForeignTx ? 1 : 0,
      rawText, nowIso
    );

    const txId = Number(insertRes.lastInsertRowid);

    if (parsed.walletTankType && status === 'PENDING') {
      creditWalletTankFromTx(
        db,
        parsed.walletTankType,
        parsed.amount,
        `銀行圈存自動轉入水庫：${parsed.normalizedMerchant} +$${parsed.amount}`,
        txId,
        nowIso
      );
    }

    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'CHANNEL_A_AUTH', ?, ?, ?, ?, ?, ?, ?)
    `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, reconcileNote, txId, rawText, nowIso);

    return {
      resultType: status === 'AUTH_VERIFY' ? 'VERIFY_FILTERED' : (status === 'TEMP_HOLD' ? 'GAS_PREAUTH_HOLD' : 'PENDING_CREATED'),
      channelType: 'CHANNEL_A_AUTH',
      message: reconcileNote,
      transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId),
      parsed
    };
  }

  // 情境 4：通道 B（第 2 次通知：商店請款實際扣款）-> 絕對不直接新增消費，啟動 1-to-1 Lock 核銷演算法
  const match = findBestPendingMatch(db, parsed, refDate);
  if (!match) {
    const warnMsg = `⚠️ 收到通道 B 請款通知（${parsed.normalizedMerchant} $${parsed.amount}），但找不到對應未鎖定之 PENDING 圈存紀錄。為防重複扣款已攔截直接新增，請使用「一鍵餘額校正」核對！`;
    db.prepare(`
      INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
      VALUES (?, 'CHANNEL_B_SETTLE', ?, ?, ?, ?, NULL, ?, ?)
    `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, warnMsg, rawText, nowIso);

    return {
      resultType: 'UNMATCHED_SETTLEMENT',
      channelType: 'CHANNEL_B_SETTLE',
      message: warnMsg,
      parsed
    };
  }

  const matchedTx = match.tx;
  const fxDiff = match.fxFeeDiff || (parsed.amount - matchedTx.auth_amount);

  const splitRecord = db.prepare('SELECT * FROM split_bills WHERE transaction_id = ? ORDER BY id DESC LIMIT 1').get(matchedTx.id);
  let newPersonalAmount = parsed.amount;
  if (splitRecord) {
    newPersonalAmount = Math.max(0, splitRecord.self_amount + fxDiff);
  }

  let reconcileNote = `✅ 通道 B 一對一核銷完成 (配對權重 ${match.score}% · FIFO 鎖定)`;
  if (match.matchType === 'FX_TOLERANCE_MATCH' || fxDiff !== 0) {
    const sign = fxDiff >= 0 ? `+${fxDiff}` : `${fxDiff}`;
    reconcileNote = `🌍 匯差與海外手續費自動修正：原圈存 $${matchedTx.auth_amount} ➔ 實扣 $${parsed.amount}（差額 ${sign} 元已同步微調預算）`;
  } else if (match.matchType === 'GAS_PREAUTH_SETTLE') {
    reconcileNote = `⛽ 加油站預授權 ($${matchedTx.auth_amount}) 正式請款核銷：實際加油扣款 $${parsed.amount} 元`;
  }

  db.prepare(`
    UPDATE transactions
    SET status = 'SETTLED',
        settled_amount = ?,
        fx_fee_diff = ?,
        effective_amount = ?,
        personal_amount = ?,
        settled_at = ?,
        is_reconciled_locked = 1,
        reconcile_score = ?,
        reconcile_note = ?,
        is_foreign_tx = CASE WHEN ? != 0 THEN 1 ELSE is_foreign_tx END,
        channel_b_raw = ?
    WHERE id = ?
  `).run(
    parsed.amount, fxDiff, parsed.amount, newPersonalAmount, nowIso,
    match.score, reconcileNote, fxDiff, rawText, matchedTx.id
  );

  db.prepare(`
    INSERT INTO notification_logs (source, channel_type, normalized_merchant, amount, dedupe_hash, action_taken, linked_tx_id, raw_text, received_at)
    VALUES (?, 'CHANNEL_B_SETTLE', ?, ?, ?, ?, ?, ?, ?)
  `).run(source, parsed.normalizedMerchant, parsed.amount, dedupeHash, reconcileNote, matchedTx.id, rawText, nowIso);

  return {
    resultType: 'RECONCILED_SETTLED',
    channelType: 'CHANNEL_B_SETTLE',
    matchType: match.matchType,
    reconcileScore: match.score,
    fxFeeDiff: fxDiff,
    message: reconcileNote,
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(matchedTx.id),
    parsed
  };
}

/**
 * 2.4.2 加油站預授權：使用者手動輸入實際加油金額
 */
function resolveGasTempHoldManually(db, txId, actualGasAmount) {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(txId));
  if (!tx) throw new Error('找不到該筆預授權交易');
  const amt = Math.max(0, Math.round(Number(actualGasAmount) || 0));
  const note = `⛽ 手動輸入實際加油金額 $${amt}（原預授權圈存 $${tx.auth_amount}，仍等待通道 B 最終請款）`;

  db.prepare(`
    UPDATE transactions
    SET status = 'PENDING',
        effective_amount = ?,
        personal_amount = ?,
        reconcile_note = ?
    WHERE id = ?
  `).run(amt, amt, note, tx.id);

  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
}

/**
 * 2.4.3 手動將某筆 PENDING 標記為 CANCELED（已退單待解圈），移入「凍結觀察區」
 */
function markTransactionCanceled(db, txId, reason = '取消訂單/待玉山解圈退回') {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(txId));
  if (!tx) throw new Error('找不到該筆交易');
  const note = `❄️ 凍結觀察區（已退單待解圈）：${reason}｜提醒：帳戶餘額 $${tx.auth_amount} 仍被玉山凍結，預計 7~30 天後退回`;

  db.prepare(`
    UPDATE transactions
    SET status = 'CANCELED',
        personal_amount = 0,
        reconcile_note = ?
    WHERE id = ?
  `).run(note, tx.id);

  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
}

/**
 * 2.4.3 14 天幽靈圈存（取消訂單/刷退）雷達
 */
function scanGhostHolds(db, referenceDateStr) {
  const refDate = (referenceDateStr || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const pendings = db.prepare(`
    SELECT * FROM transactions
    WHERE status = 'PENDING' AND is_reconciled_locked = 0
    ORDER BY tx_date ASC, id ASC
  `).all();

  const ghostAlerts = [];
  for (const tx of pendings) {
    const ageDays = daysBetween(tx.tx_date, refDate);
    if (ageDays >= 14) {
      if (!tx.is_ghost_alerted) {
        db.prepare('UPDATE transactions SET is_ghost_alerted = 1 WHERE id = ?').run(tx.id);
      }
      ghostAlerts.push({
        transactionId: tx.id,
        merchant: tx.normalized_merchant,
        amount: tx.auth_amount,
        txDate: tx.tx_date,
        ageDays,
        alertText: `🚨 幽靈圈存警報：有筆 $${tx.auth_amount}（${tx.normalized_merchant}，刷卡日 ${tx.tx_date}）已逾 ${ageDays} 天未請款，若已取消訂單請去玉山 Wallet 確認圈存是否已解凍退回！`
      });
    }
  }

  return ghostAlerts;
}

module.exports = {
  findBestPendingMatch,
  processBankNotification,
  resolveGasTempHoldManually,
  markTransactionCanceled,
  scanGhostHolds
};

