/**
 * queue.js — Planificateur FIFO avec 3 workers parallèles maximum
 *
 * Gère :
 *  - file d'attente FIFO (order by created_at)
 *  - max 3 pages simultanées
 *  - remplacement automatique quand un worker se libère
 *  - arrêt automatique si 3 no_exam_found consécutifs
 *  - arrêt propre sur demande
 */

const { chromium } = require('playwright');
const { getPendingUsers } = require('./db');
const { processAccount } = require('./worker');
const { logger } = require('./logger');

const MAX_WORKERS = 1;
const AUTO_STOP_THRESHOLD = 8; // no_exam_found consécutifs

let browser = null;
let browserContext = null;
let isRunning = false;

// File d'attente (tableau d'objets user)
let queue = [];
// Workers actifs : Set de Promises
let activeWorkers = new Set();
// Compteur de no_exam_found consécutifs
let consecutiveNoExam = 0;

// Référence à la fonction d'arrêt (pour arrêt automatique)
let stopCallback = null;

// ── Contrôle du robot ──────────────────────────────────────────────────────

/**
 * Démarre le robot.
 * Charge tous les comptes non-completed, les met en file FIFO.
 */
async function startBot() {
  if (isRunning) {
    logger.warn('Robot déjà en cours d\'exécution');
    return;
  }

  const users = getPendingUsers();
  if (users.length === 0) {
    logger.info('Aucun compte en attente de traitement');
    return;
  }

  logger.info(`🚀 Démarrage du robot — ${users.length} comptes à traiter`);
  isRunning = true;
  consecutiveNoExam = 0;
  queue = [...users];

  // Lancer navigateur
  browser = await chromium.launch({ headless: true });
  browserContext = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
  });

  // Lancer jusqu'à MAX_WORKERS initiaux
  await fillWorkers();
}

/**
 * Remplit les slots libres avec les prochains comptes de la file.
 */
async function fillWorkers() {
  while (isRunning && activeWorkers.size < MAX_WORKERS && queue.length > 0) {
    const user = queue.shift();
    logger.info(`▶️  Lancement worker pour : ${user.email}`);

    const workerPromise = processAccount(browserContext, user)
      .then((result) => handleWorkerResult(result, user))
      .catch((err) => {
        logger.error(`Worker ${user.email} - erreur inattendue : ${err.message}`);
      })
      .finally(() => {
        activeWorkers.delete(workerPromise);
        fillWorkers(); // Remplir les slots libérés
      });

    activeWorkers.add(workerPromise);
  }

  // Si plus rien à traiter et workers terminés → arrêt automatique
  if (queue.length === 0 && activeWorkers.size === 0 && isRunning) {
    logger.success('Tous les comptes ont été traités. Robot arrêté automatiquement.');
    await stopBot();
  }
}

/**
 * Gère le résultat d'un worker et la logique d'arrêt automatique.
 */
async function handleWorkerResult(result, user) {
  if (result === 'no_exam_found') {
    consecutiveNoExam++;
    logger.warn(
      `[${user.email}] no_exam_found — ${consecutiveNoExam}/${AUTO_STOP_THRESHOLD} consécutifs`
    );

    if (consecutiveNoExam >= AUTO_STOP_THRESHOLD) {
      logger.error(
        `Aucun examen trouvé sur ${AUTO_STOP_THRESHOLD} comptes consécutifs. Robot arrêté automatiquement.`
      );
      // Vider la file et stopper
      queue = [];
      await stopBot();
    }
  } else {
    // Réinitialiser le compteur si un compte n'est pas no_exam_found
    consecutiveNoExam = 0;
  }
}

/**
 * Arrêt propre du robot.
 */
async function stopBot() {
  if (!isRunning) return;

  logger.warn('⏹️  Arrêt du robot en cours…');
  isRunning = false;
  queue = [];

  // Attendre que les workers en cours se terminent (max 60s)
  if (activeWorkers.size > 0) {
    logger.info(`Attente de ${activeWorkers.size} worker(s) en cours…`);
    await Promise.allSettled([...activeWorkers]);
  }

  // Fermer le navigateur
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    browserContext = null;
  }

  logger.success('Robot arrêté proprement.');
}

function isBotRunning() {
  return isRunning;
}

function getQueueSize() {
  return queue.length;
}

function getActiveWorkerCount() {
  return activeWorkers.size;
}

module.exports = {
  startBot,
  stopBot,
  isBotRunning,
  getQueueSize,
  getActiveWorkerCount,
};
