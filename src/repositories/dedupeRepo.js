'use strict';

/**
 * 防重複入帳指紋與 Webhook 記錄 Repository (`ingestion_logs` & `ledger_entries`)
 */
async function getRecentLedgerCandidates(db, limit = 50) {
  return await db.queryAll(`
    SELECT * FROM ledger_entries
    ORDER BY id DESC
    LIMIT ?
  `, [Number(limit)]);
}

async function insertIngestionLog(db, log) {
  const nowIso = log.receivedAt || new Date().toISOString();
  await db.execute(`
    INSERT INTO ingestion_logs (
      source_channel, dedupe_fingerprint, amount, normalized_merchant,
      action_taken, linked_entry_id, raw_text, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    log.sourceChannel || 'manual',
    log.dedupeFingerprint || '',
    Math.round(Number(log.amount) || 0),
    log.normalizedMerchant || '',
    log.actionTaken || 'ACCEPTED',
    log.linkedEntryId || null,
    String(log.rawText || ''),
    nowIso
  ]);
}

async function listRecentIngestionLogs(db, limit = 30) {
  return await db.queryAll(`
    SELECT * FROM ingestion_logs
    ORDER BY id DESC
    LIMIT ?
  `, [Number(limit)]);
}

module.exports = {
  getRecentLedgerCandidates,
  insertIngestionLog,
  listRecentIngestionLogs
};
