/**
 * app.js — Frontend TCF Bot
 * Gère : SSE logs, API calls, rendu tableau, filtres
 */

// ── État local ─────────────────────────────────────────────────────────────

let allUsers = [];
let sseSource = null;
let statusPollInterval = null;

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  connectSSE();
  loadUsers();
  pollStatus();
  statusPollInterval = setInterval(pollStatus, 3000);
  setInterval(loadUsers, 5000); // Refresh tableau toutes les 5s
});

// ── SSE — Logs temps réel ──────────────────────────────────────────────────

function connectSSE() {
  if (sseSource) sseSource.close();

  sseSource = new EventSource('/api/logs/stream');

  sseSource.onmessage = (event) => {
    try {
      const entry = JSON.parse(event.data);
      appendLog(entry);
    } catch (_) {}
  };

  sseSource.onerror = () => {
    // Reconnexion automatique gérée par le navigateur
  };
}

function appendLog(entry) {
  const container = document.getElementById('logsContainer');

  // Supprimer message initial si présent
  const initial = container.querySelector('.log-info:first-child');
  if (initial && initial.querySelector('.log-ts').textContent === '--:--:--') {
    initial.remove();
  }

  const el = document.createElement('div');
  el.className = `log-entry log-${entry.level}`;

  const ts = new Date(entry.ts).toLocaleTimeString('fr-FR');
  el.innerHTML = `
    <span class="log-ts">${ts}</span>
    <span>${escapeHtml(entry.message)}</span>
  `;

  container.appendChild(el);

  // Limite à 500 entrées
  while (container.children.length > 500) {
    container.removeChild(container.firstChild);
  }

  // Auto-scroll vers le bas
  container.scrollTop = container.scrollHeight;
}

function clearLogs() {
  document.getElementById('logsContainer').innerHTML = '';
}

// ── Statut robot ───────────────────────────────────────────────────────────

async function pollStatus() {
  try {
    const data = await api('GET', '/api/bot/status');
    updateBotUI(data);
  } catch (_) {}
}

function updateBotUI(data) {
  const running = data.running;
  const badge = document.getElementById('botStatusBadge');
  const dot = badge.querySelector('.status-dot');
  const text = document.getElementById('botStatusText');
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');

  dot.className = 'status-dot' + (running ? ' active' : '');
  text.textContent = running
    ? `Actif — ${data.activeWorkers} worker(s) | File: ${data.queueSize}`
    : 'Inactif';

  btnStart.disabled = running;
  btnStop.disabled = !running;

  // Stats header
  if (data.stats) {
    const s = data.stats;
    document.getElementById('statTotal').textContent      = s.total       || 0;
    document.getElementById('statPending').textContent    = s.pending     || 0;
    document.getElementById('statProcessing').textContent = s.processing  || 0;
    document.getElementById('statCompleted').textContent  = s.completed   || 0;
    document.getElementById('statFailed').textContent     = s.failed      || 0;
    document.getElementById('statNoExam').textContent     = s.no_exam_found || 0;
  }
}

// ── Actions robot ──────────────────────────────────────────────────────────

async function startBot() {
  try {
    await api('POST', '/api/bot/start');
    appendLog({ ts: new Date().toISOString(), level: 'success', message: 'Robot démarré' });
    pollStatus();
  } catch (err) {
    appendLog({ ts: new Date().toISOString(), level: 'error', message: `Erreur démarrage : ${err.message}` });
  }
}

async function stopBot() {
  try {
    await api('POST', '/api/bot/stop');
    appendLog({ ts: new Date().toISOString(), level: 'warn', message: 'Arrêt demandé' });
    pollStatus();
  } catch (err) {
    appendLog({ ts: new Date().toISOString(), level: 'error', message: `Erreur arrêt : ${err.message}` });
  }
}

// ── Comptes ────────────────────────────────────────────────────────────────

async function loadUsers() {
  const search = document.getElementById('searchInput').value;
  const status = document.getElementById('filterStatus').value;
  const dateRange = document.getElementById('filterDate').value;

  try {
    const params = new URLSearchParams();
    if (search)    params.set('search',    search);
    if (status)    params.set('status',    status);
    if (dateRange) params.set('dateRange', dateRange);

    allUsers = await api('GET', `/api/users?${params.toString()}`);
    renderTable(allUsers);
  } catch (_) {}
}

function applyFilters() {
  loadUsers();
}

async function addAccount() {
  const email    = document.getElementById('inputEmail').value.trim();
  const password = document.getElementById('inputPassword').value;
  const msgEl    = document.getElementById('addMsg');

  if (!email || !password) {
    showMsg(msgEl, 'error', 'Email et mot de passe requis');
    return;
  }

  try {
    await api('POST', '/api/users', { email, password });
    showMsg(msgEl, 'success', `✓ Compte ajouté : ${email}`);
    document.getElementById('inputEmail').value    = '';
    document.getElementById('inputPassword').value = '';
    loadUsers();
  } catch (err) {
    showMsg(msgEl, 'error', err.message);
  }
}

async function deleteAccount(id, email) {
  if (!confirm(`Supprimer ${email} ?`)) return;
  await api('DELETE', `/api/users/${id}`);
  loadUsers();
}

async function resetAccount(id) {
  await api('POST', `/api/users/${id}/reset`);
  loadUsers();
}

async function resetAll() {
  if (!confirm('Remettre tous les comptes non-completed en pending ?')) return;
  await api('POST', '/api/users/reset-all');
  loadUsers();
}

// ── Rendu tableau ──────────────────────────────────────────────────────────

function renderTable(users) {
  const tbody = document.getElementById('usersBody');
  document.getElementById('accountCount').textContent = users.length;

  if (users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">Aucun compte trouvé</td></tr>`;
    return;
  }

  tbody.innerHTML = users.map((u, i) => `
    <tr>
      <td class="date-cell">${i + 1}</td>
      <td class="email-cell" title="${escapeHtml(u.email)}">${escapeHtml(u.email)}</td>
      <td><span class="status-tag st-${u.status}">${u.status}</span></td>
      <td class="date-cell">${formatDate(u.created_at)}</td>
      <td class="date-cell">${u.updated_at ? formatDate(u.updated_at) : '—'}</td>
      <td>
        <div class="actions-cell">
          <button class="btn btn-sm btn-reset" onclick="resetAccount(${u.id})" title="Remettre en pending">↺</button>
          <button class="btn btn-sm btn-danger" onclick="deleteAccount(${u.id}, '${escapeHtml(u.email)}')" title="Supprimer">✕</button>
        </div>
      </td>
    </tr>
  `).join('');
}

// ── Utilitaires ────────────────────────────────────────────────────────────

async function api(method, url, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const data = await res.json();

  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function formatDate(dtStr) {
  if (!dtStr) return '—';
  const d = new Date(dtStr);
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showMsg(el, type, text) {
  el.className = `form-msg ${type}`;
  el.textContent = text;
  setTimeout(() => (el.textContent = ''), 4000);
}
