'use strict';

/**
 * 朋友聚餐拆帳與應收代墊款池 Repository (`split_bills`)
 */
async function getSplitById(db, id) {
  return await db.queryOne('SELECT * FROM split_bills WHERE id = ?', [Number(id)]);
}

async function getSplitByLedgerEntryId(db, ledgerEntryId) {
  return await db.queryOne('SELECT * FROM split_bills WHERE ledger_entry_id = ?', [Number(ledgerEntryId)]);
}

async function upsertSplitBill(db, { ledgerEntryId, debtorName, totalAmount, selfAmount, receivableAmount }) {
  const nowIso = new Date().toISOString();
  const existing = await getSplitByLedgerEntryId(db, ledgerEntryId);
  if (existing) {
    await db.execute(`
      UPDATE split_bills
      SET debtor_name = ?, total_amount = ?, self_amount = ?, receivable_amount = ?,
          is_repaid = 0, repaid_entry_id = NULL, repaid_at = NULL
      WHERE id = ?
    `, [debtorName, totalAmount, selfAmount, receivableAmount, existing.id]);
    return await getSplitById(db, existing.id);
  }
  const res = await db.execute(`
    INSERT INTO split_bills (
      ledger_entry_id, debtor_name, total_amount, self_amount,
      receivable_amount, is_repaid, repaid_entry_id, created_at
    ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?)
  `, [ledgerEntryId, debtorName, totalAmount, selfAmount, receivableAmount, nowIso]);
  return await getSplitById(db, res.lastInsertRowid);
}

async function markSplitBillRepaid(db, splitId, repaidEntryId = null) {
  const nowIso = new Date().toISOString();
  await db.execute(`
    UPDATE split_bills
    SET is_repaid = 1, repaid_entry_id = ?, repaid_at = ?
    WHERE id = ?
  `, [repaidEntryId, nowIso, Number(splitId)]);
  return await getSplitById(db, splitId);
}

async function unmarkSplitsByRepaidEntryId(db, repaidEntryId) {
  await db.execute(`
    UPDATE split_bills
    SET is_repaid = 0, repaid_entry_id = NULL, repaid_at = NULL
    WHERE repaid_entry_id = ?
  `, [Number(repaidEntryId)]);
}

async function deleteSplitByLedgerEntryId(db, ledgerEntryId) {
  await db.execute('DELETE FROM split_bills WHERE ledger_entry_id = ?', [Number(ledgerEntryId)]);
}

async function listAllSplitBills(db) {
  return await db.queryAll(`
    SELECT s.*, l.normalized_merchant, l.tx_date, l.flow_type
    FROM split_bills s
    LEFT JOIN ledger_entries l ON l.id = s.ledger_entry_id
    ORDER BY s.is_repaid ASC, s.id DESC
  `);
}

module.exports = {
  getSplitById,
  getSplitByLedgerEntryId,
  upsertSplitBill,
  markSplitBillRepaid,
  unmarkSplitsByRepaidEntryId,
  deleteSplitByLedgerEntryId,
  listAllSplitBills
};
