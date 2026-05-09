/**
 * db.js — Initialisation et accès à la base SQLite
 */
const { DatabaseSync: Database } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(process.cwd(), 'data', 'database.sqlite');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec(`PRAGMA journal_mode = WAL`);
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      status TEXT DEFAULT 'pending', -- pending | processing | completed | failed | no_exam_found | pending_confirm | waiting_receipt
      receipt_path TEXT,
      transaction_id TEXT,
      payment_date TEXT,
      sender_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME
    );
  `);
}

// ── Requêtes utilisateurs ──────────────────────────────────────────────────

function addUser(email, password) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO users (email, password)
    VALUES (?, ?)
  `);
  return stmt.run(email, password);
}

function getAllUsers({ search = '', status = '', dateRange = '' } = {}) {
  let query = `SELECT * FROM users WHERE 1=1`;
  const params = [];

  if (search) {
    query += ` AND email LIKE ?`;
    params.push(`%${search}%`);
  }
  if (status && status !== 'all') {
    query += ` AND status = ?`;
    params.push(status);
  }
  if (dateRange === 'today') {
    query += ` AND DATE(created_at) = DATE('now')`;
  } else if (dateRange === '7days') {
    query += ` AND created_at >= DATE('now', '-7 days')`;
  } else if (dateRange === '30days') {
    query += ` AND created_at >= DATE('now', '-30 days')`;
  }

  query += ` ORDER BY created_at ASC`;
  return getDb().prepare(query).all(...params);
}

function getPendingUsers() {
  return getDb()
     .prepare(`SELECT * FROM users WHERE status IN ('pending', 'processing', 'failed', 'no_exam_found', 'pending_confirm', 'waiting_receipt') ORDER BY created_at ASC`)
     .all();
}

function updateStatus(id, status) {
  getDb()
    .prepare(`UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(status, id);
}

function resetUser(id) {
  updateStatus(id, 'pending');
}

function resetNonCompleted() {
  getDb()
    .prepare(`
      UPDATE users
      SET status = 'pending', updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('failed', 'processing', 'no_exam_found', 'pending_confirm', 'waiting_receipt')
    `)
    .run();
}

function deleteUser(id) {
  getDb().prepare(`DELETE FROM users WHERE id = ?`).run(id);
}

function updateReceiptInfo(id, { receiptPath, transactionId, paymentDate, senderName }) {
  getDb()
    .prepare(`
      UPDATE users
      SET receipt_path = ?, transaction_id = ?, payment_date = ?, sender_name = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .run(receiptPath, transactionId, paymentDate, senderName, id);
}

function getStats() {
  const row = getDb()
    .prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)       as pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END)    as processing,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)     as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)        as failed,
        SUM(CASE WHEN status = 'no_exam_found' THEN 1 ELSE 0 END) as no_exam_found
      FROM users
    `)
    .get();
  return row;
}

function resetPendingConfirm() {
  getDb()
    .prepare(`
      UPDATE users
      SET status = 'pending', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'pending_confirm'
    `)
    .run();
}

module.exports = {
  getDb,
  addUser,
  getAllUsers,
  getPendingUsers,
  updateStatus,
  resetUser,
  resetNonCompleted,
  deleteUser,
  updateReceiptInfo,
  getStats,
  resetPendingConfirm,
};
