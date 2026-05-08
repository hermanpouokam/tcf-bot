/**
 * index.js — Point d'entrée du serveur Express
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const routes = require('./routes');
const { getDb } = require('./db');

const PORT = process.env.PORT || 3000;

// Créer dossiers nécessaires
['logs', 'screenshots'].forEach((dir) => {
  const p = path.join(__dirname, '..', dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// Initialiser la BDD
getDb();

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes API
app.use('/', routes);

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🤖 TCF Bot démarré sur http://localhost:${PORT}\n`);
});
