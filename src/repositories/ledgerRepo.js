'use strict';

/**
 * 核心帳務分流明細 Repository (`ledger_entries`)
 */
async function getEntryById(db, id) {
  return await db.queryOne('SELECT * FROM ledger_entries WHERE id = ?', [Number(id)]);
}

async function listEntriesWithSplits(db, { cycleKey = null, limit = 120 } = {}) {
  if (cycleKey) {
    return await db.queryAll(`
      SELECT l.*,
             s.id AS split_id, s.debtor_name AS split_debtor_name,
             s.self_amount AS split_self_amount, s.receivable_amount AS split_receivable_amount,
             s.is_repaid AS split_is_repaid
      FROM ledger_entries l
      LEFT JOIN split_bills s ON s.ledger_entry_id = l.id
      WHERE l.cycle_key = ?
      ORDER BY l.tx_date DESC, l.id DESC
      LIMIT ?
    `, [cycleKey, Number(limit)]);
  }
  return await db.queryAll(`
    SELECT l.*,
           s.id AS split_id, s.debtor_name AS split_debtor_name,
           s.self_amount AS split_self_amount, s.receivable_amount AS split_receivable_amount,
           s.is_repaid AS split_is_repaid
    FROM ledger_entries l
    LEFT JOIN split_bills s ON s.ledger_entry_id = l.id
    ORDER BY l.tx_date DESC, l.id DESC
    LIMIT ?
  `, [Number(limit)]);
}

async function insertEntry(db, entry) {
  const nowIso = entry.createdAt || new Date().toISOString();
  const res = await db.execute(`
    INSERT INTO ledger_entries (
      cycle_key, flow_type, payment_medium, dedupe_status, dedupe_fingerprint,
      raw_merchant, normalized_merchant, category, card_last4,
      amount, budget_impact_amount, cash_delta, easycard_delta,
      tx_date, tx_timestamp, source_channel, note, raw_payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    entry.cycleKey,
    entry.flowType || 'EXPENSE',
    entry.paymentMedium || 'DIGITAL_BANK',
    entry.dedupeStatus || 'CONFIRMED',
    entry.dedupeFingerprint || null,
    entry.rawMerchant || '未知項目',
    entry.normalizedMerchant || '未知項目',
    entry.category || '一般消費',
    entry.cardLast4 || null,
    Math.max(0, Math.round(Number(entry.amount) || 0)),
    Math.round(Number(entry.budgetImpactAmount) || 0),
    Math.round(Number(entry.cashDelta) || 0),
    Math.round(Number(entry.easycardDelta) || 0),
    entry.txDate,
    entry.txTimestamp || nowIso,
    entry.sourceChannel || 'manual',
    entry.note || '',
    entry.rawPayload || null,
    nowIso
  ]);
  return await getEntryById(db, res.lastInsertRowid);
}

async function updateEntryFields(db, id, patch) {
  await db.execute(`
    UPDATE ledger_entries
    SET flow_type = ?,
        payment_medium = ?,
        dedupe_status = ?,
        raw_merchant = ?,
        normalized_merchant = ?,
        category = ?,
        amount = ?,
        budget_impact_amount = ?,
        cash_delta = ?,
        easycard_delta = ?,
        tx_date = ?,
        note = ?
    WHERE id = ?
  `, [
    patch.flowType,
    patch.paymentMedium,
    patch.dedupeStatus,
    patch.rawMerchant,
    patch.normalizedMerchant,
    patch.category,
    Math.max(0, Math.round(Number(patch.amount) || 0)),
    Math.round(Number(patch.budgetImpactAmount) || 0),
    Math.round(Number(patch.cashDelta) || 0),
    Math.round(Number(patch.easycardDelta) || 0),
    patch.txDate,
    patch.note || '',
    Number(id)
  ]);
  return await getEntryById(db, id);
}

async function deleteEntryById(db, id) {
  return await db.execute('DELETE FROM ledger_entries WHERE id = ?', [Number(id)]);
}

async function getCycleAggregates(db, cycleKey, todayYMD) {
  const row = await db.queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN dedupe_status = 'CONFIRMED' THEN budget_impact_amount ELSE 0 END), 0) AS net_digital_budget_used,
      COALESCE(SUM(CASE WHEN dedupe_status = 'CONFIRMED' AND flow_type = 'EXPENSE' AND payment_medium = 'DIGITAL_BANK' THEN budget_impact_amount ELSE 0 END), 0) AS digital_expense_total,
      COALESCE(SUM(CASE WHEN dedupe_status = 'CONFIRMED' AND flow_type = 'EXPENSE' AND payment_medium = 'CASH' THEN amount ELSE 0 END), 0) AS cash_expense_total,
      COALESCE(SUM(CASE WHEN dedupe_status = 'CONFIRMED' AND flow_type = 'UNKNOWN_GAP' THEN budget_impact_amount ELSE 0 END), 0) AS gap_expense_total,
      COALESCE(SUM(CASE WHEN dedupe_status = 'CONFIRMED' AND budget_impact_amount < 0 THEN -budget_impact_amount ELSE 0 END), 0) AS atm_cash_deposited_to_card,
      COALESCE(SUM(CASE WHEN dedupe_status = 'CONFIRMED' AND flow_type = 'INCOME_DEPOSIT' THEN amount ELSE 0 END), 0) AS external_deposit_recorded,
      COALESCE(SUM(CASE WHEN dedupe_status = 'CONFIRMED' AND flow_type IN ('EXPENSE', 'UNKNOWN_GAP') AND payment_medium = 'DIGITAL_BANK' AND tx_date = ? THEN budget_impact_amount ELSE 0 END), 0) AS today_digital_spent,
      COALESCE(SUM(CASE WHEN dedupe_status = 'CONFIRMED' AND flow_type = 'EXPENSE' AND payment_medium = 'CASH' AND tx_date = ? THEN amount ELSE 0 END), 0) AS today_cash_spent,
      COALESCE(SUM(CASE WHEN dedupe_status = 'SUSPECTED_DUPLICATE' THEN 1 ELSE 0 END), 0) AS suspected_duplicate_count
    FROM ledger_entries
    WHERE cycle_key = ?
  `, [todayYMD, todayYMD, cycleKey]);
  return row || {};
}

async function getSmallExpensesInRange(db, startDateStr, endDateStr, maxAmount = 200) {
  return await db.queryAll(`
    SELECT * FROM ledger_entries
    WHERE dedupe_status = 'CONFIRMED'
      AND flow_type = 'EXPENSE'
      AND amount > 0 AND amount < ?
      AND tx_date >= ? AND tx_date <= ?
    ORDER BY tx_date DESC, id DESC
  `, [Number(maxAmount), startDateStr, endDateStr]);
}

module.exports = {
  getEntryById,
  listEntriesWithSplits,
  insertEntry,
  updateEntryFields,
  deleteEntryById,
  getCycleAggregates,
  getSmallExpensesInRange
};
