# TCF Bot — Documentation

## Architecture

```
tcf-bot/
  server/
    index.js      → Serveur Express (point d'entrée)
    db.js         → Base SQLite (better-sqlite3)
    queue.js      → Planificateur FIFO / 3 workers parallèles
    worker.js     → Logique Playwright par compte ⚠️ À ADAPTER
    routes.js     → API REST + SSE
    logger.js     → Logs temps réel via SSE
  public/
    index.html    → Dashboard admin
    style.css     → Thème industriel sombre
    app.js        → Frontend JS (fetch API, SSE, tableau)
  logs/           → Logs (futur)
  screenshots/    → Captures erreurs Playwright
  database.sqlite → Créé automatiquement au premier lancement
  package.json
```

## Installation

```bash
cd tcf-bot
npm install
npx playwright install chromium
```

## Lancement

```bash
npm start
# ou en dev avec rechargement auto :
npm run dev
```

Accéder à : **http://localhost:3000**

---

## ⚠️ Adaptation obligatoire — worker.js

Le fichier `server/worker.js` contient les étapes Playwright.
**Les sélecteurs sont des placeholders** qui doivent être adaptés
au site TCF réel.

### Comment adapter :

1. Fournir le PDF du workflow TCF
2. Pour chaque étape, identifier :
   - L'URL de la page
   - Les sélecteurs des champs (priorité : data-testid → id → name → texte)
   - Les boutons à cliquer
3. Modifier les fonctions :
   - `stepLogin()` → URL + champs email/password + bouton
   - `stepNavigateToReservation()` → URL ou menu de navigation
   - `stepFillForm()` → Champs du formulaire candidat
   - `stepSaveAndContinue()` → Déjà implémenté, vérifier texte bouton
   - `stepSelectExamDate()` → Sélecteurs du calendrier/select
   - `stepConfirm()` → Texte du bouton de confirmation final

### Tester un compte manuellement :

```js
// Dans un script test.js temporaire :
const { chromium } = require('playwright');
const { processAccount } = require('./server/worker');

(async () => {
  const browser = await chromium.launch({ headless: false }); // visible
  const ctx = await browser.newContext();
  await processAccount(ctx, { id: 999, email: 'test@email.com', password: 'motdepasse' });
  await browser.close();
})();
```

---

## Flux de traitement

```
[DB: comptes non-completed]
         ↓
  [File FIFO (ORDER BY created_at)]
         ↓
  ┌──────────────────────────┐
  │  Scheduler (queue.js)    │
  │  Max 3 workers parallèles │
  │  Remplacement automatique │
  └──────────────────────────┘
         ↓
  [worker.js par compte]
  login → nav → form → save&continue → exam date?
         ↓ oui              ↓ non
   [select date]      [no_exam_found]
         ↓                  ↓
   [confirm]         [3 consécutifs?]
         ↓                  ↓ oui
   [completed]       [arrêt auto robot]
```

---

## Statuts

| Statut         | Description                              |
|----------------|------------------------------------------|
| `pending`      | En attente de traitement                 |
| `processing`   | En cours (worker actif)                  |
| `completed`    | Réservation réussie                      |
| `failed`       | Erreur Playwright (screenshot sauvegardé)|
| `no_exam_found`| Aucune date disponible                   |

---

## API Endpoints

| Méthode | Route                      | Description                        |
|---------|----------------------------|------------------------------------|
| GET     | /api/users                 | Liste comptes (+ filtres query)    |
| POST    | /api/users                 | Ajouter compte {email, password}   |
| DELETE  | /api/users/:id             | Supprimer compte                   |
| POST    | /api/users/:id/reset       | Remettre en pending                |
| POST    | /api/users/reset-all       | Reset tous non-completed           |
| POST    | /api/bot/start             | Démarrer robot                     |
| POST    | /api/bot/stop              | Stopper robot                      |
| GET     | /api/bot/status            | Statut + stats                     |
| GET     | /api/logs/stream           | SSE logs temps réel                |

---

## Screenshots d'erreurs

Les captures sont sauvegardées dans `screenshots/` au format :
```
email_at_domaine_com-1234567890.png
```
