/**
 * logger.js — Système de logs avec diffusion SSE temps réel
 */

const clients = new Set();

/**
 * Enregistre un nouveau client SSE
 */
function addClient(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);

  res.on('close', () => clients.delete(res));
}

/**
 * Diffuse un message à tous les clients connectés
 * @param {string} level  'info' | 'success' | 'error' | 'warn'
 * @param {string} message
 */
function log(level, message) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
  };

  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (_) {
      clients.delete(res);
    }
  }

  // Log console aussi
  const prefix = { info: '📋', success: '✅', error: '❌', warn: '⚠️' }[level] || '•';
  console.log(`${prefix} [${entry.ts}] ${message}`);
}

const logger = {
  info: (msg) => log('info', msg),
  success: (msg) => log('success', msg),
  error: (msg) => log('error', msg),
  warn: (msg) => log('warn', msg),
};

module.exports = { logger, addClient };
