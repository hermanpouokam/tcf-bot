/**
 * routes.js — Routes Express (API REST + SSE)
 */

const express = require('express');
const router = express.Router();

const db = require('./db');
const { startBot, stopBot, isBotRunning, getQueueSize, getActiveWorkerCount } = require('./queue');
const { logger, addClient } = require('./logger');

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
  db.deleteUser(parseInt(req.params.id));
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

module.exports = router;
