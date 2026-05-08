/**
 * routes.js — Routes Express (API REST + SSE)
 */

const express = require('express');
const router = express.Router();

const path = require('path');
const fs = require('fs');
const db = require('./db');
const { startBot, stopBot, isBotRunning, getQueueSize, getActiveWorkerCount } = require('./queue');
const { logger, addClient } = require('./logger');

// Multer pour upload fichiers
let multer;
try { multer = require('multer'); } catch(_) {}

const RECEIPTS_DIR = path.join(__dirname, '..', 'receipts');
if (!fs.existsSync(RECEIPTS_DIR)) fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

const storage = multer ? multer.diskStorage({
  destination: (req, file, cb) => cb(null, RECEIPTS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `receipt_${req.params.id}_${Date.now()}${ext}`);
  }
}) : null;

const upload = multer ? multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }) : null;

// ── SSE — Logs temps réel ──────────────────────────────────────────────────

router.get('/api/logs/stream', (req, res) => {
  addClient(res);
});

// ── Statut robot ───────────────────────────────────────────────────────────

router.get('/api/bot/status', (req, res) => {
  res.json({
    running: isBotRunning(),
    queueSize: getQueueSize(),
    activeWorkers: getActiveWorkerCount(),
    stats: db.getStats(),
  });
});

// ── Démarrer / Stopper ─────────────────────────────────────────────────────

router.post('/api/bot/start', async (req, res) => {
  if (isBotRunning()) {
    return res.status(409).json({ error: 'Robot déjà en cours' });
  }
  startBot().catch((err) => logger.error(`Erreur démarrage robot : ${err.message}`));
  res.json({ ok: true, message: 'Robot démarré' });
});

router.post('/api/bot/stop', async (req, res) => {
  await stopBot();
  res.json({ ok: true, message: 'Robot arrêté' });
});

// ── Comptes utilisateurs ───────────────────────────────────────────────────

router.get('/api/users', (req, res) => {
  const { search, status, dateRange } = req.query;
  const users = db.getAllUsers({ search, status, dateRange });
  res.json(users);
});

router.post('/api/users', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  const result = db.addUser(email.trim().toLowerCase(), password);

  if (result.changes === 0) {
    return res.status(409).json({ error: 'Ce compte existe déjà' });
  }

  logger.info(`Compte ajouté : ${email}`);
  res.status(201).json({ ok: true, id: result.lastInsertRowid });
});

router.delete('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id);

  // Récupérer le reçu associé avant suppression
  const users = db.getAllUsers();
  const user = users.find(u => u.id === id);

  if (user && user.receipt_path) {
    const filePath = path.join(RECEIPTS_DIR, user.receipt_path);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info(`Reçu supprimé : ${user.receipt_path}`);
      }
    } catch (err) {
      logger.warn(`Impossible de supprimer le reçu : ${err.message}`);
    }
  }

  db.deleteUser(id);
  res.json({ ok: true });
});

router.post('/api/users/:id/reset', (req, res) => {
  db.resetUser(parseInt(req.params.id));
  res.json({ ok: true });
});

// ── Actions globales ───────────────────────────────────────────────────────

router.post('/api/users/reset-all', (req, res) => {
  db.resetNonCompleted();
  logger.info('Réinitialisation globale : tous les comptes non-completed remis en pending');
  res.json({ ok: true });
});

// ── Upload reçu de paiement ────────────────────────────────────────────────
router.post('/api/users/:id/receipt', (req, res, next) => {
  if (!upload) return res.status(500).json({ error: 'multer non installé' });
  upload.single('receipt')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const { transactionId, paymentDate, senderName } = req.body;
    const id = parseInt(req.params.id);

    if (!req.file) return res.status(400).json({ error: 'Fichier requis' });
    if (!transactionId || !paymentDate || !senderName) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }

    db.updateReceiptInfo(id, {
      receiptPath: req.file.filename,
      transactionId,
      paymentDate,
      senderName,
    });

    logger.info(`Reçu enregistré pour user ${id} : ${req.file.filename}`);
    res.json({ ok: true, filename: req.file.filename });
  });
});

// ── Télécharger un reçu ────────────────────────────────────────────────────
router.get('/api/users/:id/receipt', (req, res) => {
  const users = db.getAllUsers();
  const user = users.find(u => u.id === parseInt(req.params.id));
  if (!user || !user.receipt_path) return res.status(404).json({ error: 'Reçu introuvable' });
  const filePath = path.join(RECEIPTS_DIR, user.receipt_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Fichier introuvable' });
  res.sendFile(filePath);
});

module.exports = router;
