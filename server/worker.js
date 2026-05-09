const path = require('path');
const fs = require('fs');
const { updateStatus } = require('./db');
const { logger } = require('./logger');

const RECEIPTS_DIR = path.join(__dirname, '..', 'receipts');
const LOGIN_URL = 'https://testslanguesub.com/fr?auth=true&type=login';
const TIMEOUT = 30000;

// ── Utilitaires ────────────────────────────────────────────────────────────

async function waitVisible(page, selector, timeout = TIMEOUT) {
  await page.waitForSelector(selector, { state: 'visible', timeout });
}

async function waitPageReady(page) {
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
}

async function waitAndClick(page, selector, label, timeout = TIMEOUT) {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout });
    await page.click(selector);
  } catch (err) {
    throw new Error(`Impossible de cliquer "${label}" [${selector}] : ${err.message}`);
  }
}

async function waitForOneOf(page, selectors, timeout = TIMEOUT) {
  return Promise.race(
    selectors.map(sel =>
      page.waitForSelector(sel, { state: 'visible', timeout })
        .then(() => sel)
    )
  );
}

// ── Vérification et restauration de la bonne page ─────────────────────────

async function ensureOnExamPage(page, email, password) {
  const currentUrl = page.url();
  logger.info(`[${email}] URL actuelle : ${currentUrl}`);

  // Cas 0 : déjà inscrit → upload-receipt
  if (currentUrl.includes('step=upload-receipt')) {
    logger.success(`[${email}] Déjà inscrit → upload-receipt`);
    throw new Error('GOTO_UPLOAD');
  }

  // Cas 1 : déjà sur la bonne page
  if (currentUrl.includes('exam-registration') && currentUrl.includes('step=exam-details')) {
    logger.success(`[${email}] Déjà sur la page examen ✓`);
    return;
  }

  // Cas 2 : redirigé vers la page de connexion
  const isLoginPage =
    currentUrl.includes('auth=true') ||
    currentUrl.includes('type=login') ||
    (await page.locator('input[type="email"]').isVisible().catch(() => false));

  if (isLoginPage) {
    logger.warn(`[${email}] Session expirée — reconnexion`);
    await stepLogin(page, email, password);
    await stepGoDirectToExam(page, email);
    return;
  }

  // Cas 3 : page inattendue → forcer navigation
  logger.warn(`[${email}] Page inattendue (${currentUrl}) — redirection forcée`);
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });
  const hasLoginForm = await page.locator('input[type="email"]').isVisible().catch(() => false);
  if (hasLoginForm) await stepLogin(page, email, password);
  await stepGoDirectToExam(page, email);
}

// ── VÉRIFICATION INSCRIPTION (pending_confirm) ─────────────────────────────

async function stepVerifyEnrollment(page, email) {
  logger.info(`[${email}] Vérification inscription sur exam-management`);

  await page.goto(
    'https://testslanguesub.com/fr/dashboard/exam-management',
    { waitUntil: 'domcontentloaded', timeout: TIMEOUT }
  );

  await waitVisible(page, 'text=Historique des inscriptions');
  await waitPageReady(page);

  const row = page.locator('tbody tr').filter({
    has: page.locator('td', { hasText: 'TCF-Canada' })
  }).first();

  const hasEnrollment = await row.isVisible().catch(() => false);

  if (hasEnrollment) {
    const status = await row.locator('td:nth-child(5)').innerText().catch(() => '');
    logger.success(`[${email}] Inscription trouvée — statut TLUB : ${status.trim()}`);
    return true;
  }

  logger.warn(`[${email}] Aucune inscription trouvée → remise en pending`);
  return false;
}

// ── ÉTAPE 1 : Connexion ────────────────────────────────────────────────────

async function stepLogin(page, email, password) {
  logger.info(`[${email}] Étape 1 : Connexion`);

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

  await waitVisible(page, 'input[type="email"]');
  await page.locator('input[type="email"]').first().fill(email);

  await waitVisible(page, 'input[type="password"]');
  await page.locator('input[type="password"]').first().fill(password);

  const loginBtn = page
    .locator('form button[type="submit"], form button:has-text("Se connecter")')
    .first();
  await loginBtn.click();

  try {
    await page.waitForURL(
      'https://testslanguesub.com/fr/welcome-onboard',
      { timeout: TIMEOUT }
    );
    logger.success(`[${email}] Connexion réussie`);
  } catch (_) {
    const invalid = await page
      .locator('text=Détails de connexion invalides')
      .isVisible()
      .catch(() => false);

    if (invalid) throw new Error('INVALID_CREDENTIALS');
    throw new Error(`LOGIN_REDIRECT_FAILED (${page.url()})`);
  }
}

// ── ÉTAPE 2 : Navigation vers page type d'examen ──────────────────────────

async function stepGoDirectToExam(page, email) {
  logger.info(`[${email}] Étape 2 : Type d'examen`);

  const PERSONAL_URL = 'https://testslanguesub.com/fr/dashboard/exam-registration?step=personal-information';

  await page.goto(PERSONAL_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

  // Laisser React hydrater et les redirections internes se faire
  await page.waitForTimeout(2500);

  const urlAfter = page.url();
  logger.info(`[${email}] URL après stabilisation : ${urlAfter}`);

  // CAS 1 : déjà inscrit → upload-receipt
  if (urlAfter.includes('step=upload-receipt')) {
    logger.success(`[${email}] Déjà inscrit → upload-receipt`);
    throw new Error('GOTO_UPLOAD');
  }

  // CAS 2 : sur personal-information → sélectionner type examen
  if (urlAfter.includes('personal-information')) {
    await waitVisible(page, "text=Type d'examen");

    const examDropdown = page
      .locator('div.relative.border.cursor-pointer.rounded')
      .filter({ has: page.locator('p') })
      .last();

    await examDropdown.waitFor({ state: 'visible', timeout: TIMEOUT });

    const currentValue = (await examDropdown.locator('p').innerText().catch(() => '')).trim();
    logger.info(`[${email}] Type actuel : ${currentValue}`);

    if (currentValue !== 'TCF-Canada') {
      logger.info(`[${email}] Sélection de TCF-Canada`);
      await examDropdown.click();

      const option = page.locator('li', { hasText: 'TCF-Canada' }).first();
      await option.waitFor({ state: 'visible', timeout: TIMEOUT });
      await option.click();

      await page.waitForFunction(() => {
        return [...document.querySelectorAll('p')]
          .some(p => p.textContent?.trim() === 'TCF-Canada');
      }, { timeout: TIMEOUT });

      logger.success(`[${email}] TCF-Canada sélectionné`);
    } else {
      logger.success(`[${email}] TCF-Canada déjà sélectionné`);
    }

    const continueBtn = page.locator('button:has-text("Continuer")').first();
    await continueBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
    await continueBtn.click();

    // Attendre stabilisation et vérifier via URL (plus fiable que du texte)
    await page.waitForTimeout(1500);

    if (page.url().includes('step=upload-receipt')) {
      logger.success(`[${email}] Déjà inscrit après continuer → upload-receipt`);
      throw new Error('GOTO_UPLOAD');
    }

    await waitVisible(page, "text=Détails de l'examen");
    logger.success(`[${email}] Page examen chargée`);
    return;
  }

  // CAS 3 : page inattendue
  throw new Error(`WRONG_STEP: ${urlAfter}`);
}

// ── ÉTAPE 3 : Sélection date + modules ────────────────────────────────────

async function stepSelectDate(page, email, password) {
  logger.info(`[${email}] Étape 3 : Sélection date + modules`);

  await ensureOnExamPage(page, email, password);
  await waitPageReady(page);

  // Check upload-receipt après restauration de page
  if (page.url().includes('step=upload-receipt')) {
    throw new Error('GOTO_UPLOAD');
  }

  // Indicateur fiable de rendu React : inputs disabled (dates dispo) ou message sans dates
  const pageState = await waitForOneOf(page, [
    'input[placeholder="Date limite d\'inscription"]',
    'p:has-text("Aucun examen programmé")',
  ]);

  if (pageState === 'p:has-text("Aucun examen programmé")') {
    logger.warn(`[${email}] Aucun examen programmé`);
    return false;
  }

  logger.info(`[${email}] Dates disponibles détectées`);

  // Ouvrir le dropdown de date
  const dropdownTrigger = page
    .locator('div.relative.border.cursor-pointer.rounded')
    .first();

  await dropdownTrigger.waitFor({ state: 'visible', timeout: TIMEOUT });
  await dropdownTrigger.click({ force: true });

  // Attendre que les options chargent
  await page.waitForTimeout(1500);

  const dateOptions = dropdownTrigger.locator('ul li');
  const dateCount = await dateOptions.count().catch(() => 0);

  if (dateCount === 0) {
    logger.warn(`[${email}] Dropdown ouvert mais aucune date`);
    await page.keyboard.press('Escape').catch(() => { });
    return false;
  }

  const firstDate = await dateOptions.first().innerText().catch(() => '?');
  await dateOptions.first().click({ force: true });
  logger.success(`[${email}] Date choisie : ${firstDate.trim()}`);

  // Attendre fermeture dropdown
  await page.waitForSelector('div.relative.border.cursor-pointer.rounded ul', {
    state: 'hidden',
    timeout: 5000
  }).catch(() => { });

  // Vérifier redirection après sélection de date
  await page.waitForTimeout(1000);
  if (page.url().includes('step=upload-receipt')) {
    logger.success(`[${email}] Redirigé vers upload-receipt après sélection date`);
    throw new Error('GOTO_UPLOAD');
  }

  // ── Sélectionner les modules ─────────────────────────────────────────────
  logger.info(`[${email}] Sélection des modules`);
  await waitVisible(page, 'article');

  const moduleCards = page.locator('article');
  const moduleCount = await moduleCards.count();

  if (moduleCount === 0) throw new Error('Aucun module trouvé');

  for (let i = 0; i < moduleCount; i++) {
    const card = moduleCards.nth(i);
    const title = await card.locator('h2').innerText().catch(() => `Module ${i + 1}`);
    const selectBtn = card.locator('div.cursor-pointer').filter({ hasText: 'Select' }).first();

    const btnVisible = await selectBtn.isVisible().catch(() => false);
    if (!btnVisible) {
      logger.info(`[${email}] Module ${title} déjà sélectionné`);
      continue;
    }

    await selectBtn.click({ force: true });

    await page.waitForFunction(
      (idx) => {
        const cards = document.querySelectorAll('article');
        const card = cards[idx];
        if (!card) return true;
        const btn = card.querySelector('div[class*="cursor-pointer"]');
        return !btn || !btn.textContent.includes('Select');
      },
      i,
      { timeout: 500 }
    ).catch(() => { });

    logger.success(`[${email}] Module : ${title}`);
  }

  // ── Vérifier le prix ─────────────────────────────────────────────────────
  await page.waitForTimeout(1000);
  const priceText = await page.locator('p:has-text("Prix:")').first().innerText().catch(() => '');
  if (priceText.includes('XAF') && priceText.trim() !== 'Prix:  XAF') {
    logger.success(`[${email}] Prix : ${priceText}`);
  } else {
    logger.warn(`[${email}] Prix non calculé`);
  }

  // ── Continuer ────────────────────────────────────────────────────────────
  const continuerBtn = page.locator('button:has-text("Continuer")').first();
  await continuerBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
  await continuerBtn.click({ force: true });

  // Vérifier redirection après clic Continuer
  await page.waitForTimeout(1500);
  if (page.url().includes('step=upload-receipt')) {
    logger.success(`[${email}] Redirigé vers upload-receipt après Continuer`);
    throw new Error('GOTO_UPLOAD');
  }

  await waitForOneOf(page, [
    'button:has-text("Reserver ma place")',
    'text=Vérifier et confirmer',
  ]);

  logger.success(`[${email}] Étape 3 terminée`);
  return true;
}

// ── ÉTAPE 4 : Réserver ma place ───────────────────────────────────────────

async function stepSaveDetailsAndContinue(page, email) {
  logger.info(`[${email}] Étape 4 : Réserver ma place`);

  const urlAfter = page.url();
  logger.info(`[${email}] URL : ${urlAfter}`);

  if (urlAfter.includes('step=upload-receipt')) {
    logger.success(`[${email}] Déjà inscrit → upload-receipt`);
    throw new Error('GOTO_UPLOAD');
  }

  const reserveBtn = page.locator('button:has-text("Reserver ma place")').first();
  await reserveBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
  await reserveBtn.click({ force: true });

  await waitVisible(page, 'text=Vérifier et confirmer');
  logger.info(`[${email}] Page "Vérifier et confirmer" chargée`);
}

// ── ÉTAPE 5 : Confirmation popup ──────────────────────────────────────────

async function confirmReservation(page, email) {
  logger.info(`[${email}] Étape 5 : Confirmation`);

  const modal = page.locator('div.fixed.z-\\[9999\\]');
  await modal.waitFor({ state: 'visible', timeout: TIMEOUT });

  const confirmBtn = modal.locator('button:has-text("Reserver ma place")');
  await confirmBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
  await confirmBtn.click();

  logger.info(`[${email}] Confirmation envoyée`);

  try {
    await page.waitForURL(
      url => url.href.includes('step=upload-receipt'),
      { timeout: TIMEOUT }
    );
    logger.success(`[${email}] Réservation validée → upload-receipt`);
  } catch (_) {
    throw new Error(`RESERVATION_CONFIRMATION_FAILED (${page.url()})`);
  }
}

// ── ÉTAPE 6 : Upload reçu ─────────────────────────────────────────────────

async function stepUploadReceipt(page, email, user) {
  logger.info(`[${email}] Étape 6 : Upload reçu`);

  if (!user.receipt_path) {
    logger.warn(`[${email}] Aucun reçu configuré → skip`);
    return;
  }

  const receiptFile = path.join(RECEIPTS_DIR, user.receipt_path);
  if (!fs.existsSync(receiptFile)) {
    logger.warn(`[${email}] Fichier reçu introuvable → skip`);
    return;
  }

  if (!user.transaction_id || !user.payment_date || !user.sender_name) {
    logger.warn(`[${email}] Infos transaction incomplètes → skip`);
    return;
  }

  // Tenter la soumission avec 1 retry
  for (let attempt = 1; attempt <= 2; attempt++) {
    logger.info(`[${email}] Tentative ${attempt}/2`);

    try {
      const success = await trySubmitReceipt(page, email, user, receiptFile);

      if (success) {
        logger.success(`[${email}] ✅ Inscription terminée !`);
        return;
      }

      if (attempt === 1) {
        logger.warn(`[${email}] Soumission échouée — retry dans 1s`);
        await page.waitForTimeout(1000);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await waitVisible(page, 'input#upload');
      } else {
        logger.error(`[${email}] 2 tentatives échouées → remis en waiting_receipt`);
        throw new Error('UPLOAD_FAILED_RETRY');
      }

    } catch (err) {
      if (err.message === 'UPLOAD_FAILED_RETRY') throw err;
      if (attempt === 1) {
        logger.warn(`[${email}] Erreur tentative 1 : ${err.message} — retry`);
        await page.waitForTimeout(3000);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await waitVisible(page, 'input#upload');
      } else {
        logger.error(`[${email}] Erreur tentative 2 : ${err.message} → pending`);
        throw new Error('UPLOAD_FAILED_RETRY');
      }
    }
  }
}

// ── Sous-fonction : une tentative de soumission ────────────────────────────

async function trySubmitReceipt(page, email, user, receiptFile) {

  // Remplir les champs AVANT l'upload (après upload ils deviennent disabled)
  await waitVisible(page, 'input[name="transactionID"]');
  await page.locator('input[name="transactionID"]').fill(user.transaction_id);
  await page.locator('input[name="paymentDate"]').fill(user.payment_date);
  await page.locator('input[name="senderName"]').fill(user.sender_name);
  logger.info(`[email] Champs remplis`);

  // Uploader le fichier
  await page.locator('input#upload').setInputFiles(receiptFile);
  logger.success(`[${email}] Fichier uploadé`);

  // Attendre le preview du fichier (confirmation upload OK)
  await waitVisible(page, 'div.p-\\[24px\\].rounded-\\[8px\\].bg-neutral-shade-12');
  logger.info(`[${email}] Preview fichier confirmé`);

  // Cliquer S'inscrire
  const submitBtn = page.locator('form button:has-text("S\'inscrire")').first();
  await submitBtn.waitFor({ state: 'visible', timeout: TIMEOUT });

  await Promise.all([
    page.waitForURL('**/*', { timeout: TIMEOUT }).catch(() => { }),
    submitBtn.click({ force: true }),
  ]);

  // Attendre fin du chargement (spinner disparu)
  await page.waitForFunction(() => {
    const spinner = document.querySelector('.zloader_rotation__ZhZG4');
    return !spinner;
  }, { timeout: TIMEOUT }).catch(() => { });

  logger.info(`[${email}] Chargement terminé — URL : ${page.url()}`);

  // Vérifier le résultat
  const success = await page
    .locator('text=Inscription terminée !')
    .isVisible()
    .catch(() => false);

  if (success) return true;

  // Vérifier si on est toujours sur upload-receipt (échec silencieux)
  if (page.url().includes('step=upload-receipt')) {
    logger.warn(`[${email}] Toujours sur la page upload → échec`);
    return false;
  }

  // Autre page → considérer comme succès (redirection inattendue)
  logger.warn(`[${email}] Page inattendue après soumission : ${page.url()}`);
  return true;
}

// ── Entrée principale ──────────────────────────────────────────────────────

async function processAccount(context, user) {
  const { id, email, password } = user;
  const page = await context.newPage();

  page.on('requestfailed', req => {
    const url = req.url();
    if (!url.includes('analytics') && !url.includes('tracking')) {
      logger.warn(`[${email}] Requête échouée : ${url}`);
    }
  });

  try {
    updateStatus(id, 'processing');
    logger.info(`[${email}] ▶️  Démarrage`);

    await stepLogin(page, email, password);

    // Compte en pending_confirm → vérifier uniquement
    if (user.status === 'pending_confirm') {
      logger.info(`[${email}] Vérification inscription (pending_confirm)`);
      const confirmed = await stepVerifyEnrollment(page, email);
      if (confirmed) {
        updateStatus(id, 'completed');
        logger.success(`[${email}] ✅ Inscription confirmée → completed`);
        return 'completed';
      } else {
        updateStatus(id, 'waiting_receipt');
        logger.warn(`[${email}] Inscription non trouvée → remis en waiting_receipt`);
        return 'waiting_receipt';
      }
    }

    // Flux normal
    await stepGoDirectToExam(page, email);

    // Vérifier si déjà redirigé vers upload-receipt après navigation
    if (page.url().includes('step=upload-receipt')) {
      logger.success(`[${email}] ✅ Déjà inscrit après navigation → upload reçu`);
      await stepUploadReceipt(page, email, user);
      updateStatus(id, 'pending_confirm');
      return 'pending_confirm';
    }

    const dateFound = await stepSelectDate(page, email, password);
    if (!dateFound) {
      updateStatus(id, 'no_exam_found');
      logger.warn(`[${email}] Aucun examen → no_exam_found`);
      return 'no_exam_found';
    }

    await stepSaveDetailsAndContinue(page, email);
    await confirmReservation(page, email);
    await stepUploadReceipt(page, email, user);

    updateStatus(id, 'pending_confirm');
    logger.success(`[${email}] 📋 pending_confirm — vérification au prochain passage`);
    return 'pending_confirm';

  } catch (err) {

    // Compte déjà réservé → aller directement upload
    if (err.message === 'GOTO_UPLOAD') {
      logger.info(`[${email}] GOTO_UPLOAD intercepté → upload reçu`);
      try {
        await stepUploadReceipt(page, email, user);
        updateStatus(id, 'pending_confirm');
        logger.success(`[${email}] 📋 Reçu uploadé → pending_confirm`);
        return 'pending_confirm';
      } catch (uploadErr) {
        if (uploadErr.message === 'UPLOAD_FAILED_RETRY') {
          logger.warn(`[${email}] Upload échoué 2 fois → remis en waiting_receipt`);
          updateStatus(id, 'waiting_receipt');
          return 'waiting_receipt';
        }
        logger.error(`[${email}] Erreur upload : ${uploadErr.message}`);
        updateStatus(id, 'failed');
        return 'failed';
      }
    }

    if (err.message === 'UPLOAD_FAILED_RETRY') {
      logger.warn(`[${email}] Upload échoué 2 fois → remis en waiting_receipt`);
      updateStatus(id, 'waiting_receipt');
      return 'waiting_receipt';
    }

    if (err.message === 'INVALID_CREDENTIALS') {
      logger.error(`[${email}] ❌ Identifiants incorrects`);
      updateStatus(id, 'failed');
      return 'invalid_credentials';
    }

    logger.error(`[${email}] ❌ Erreur : ${err.message}`);
    updateStatus(id, 'failed');
    return 'failed';

  } finally {
    await page.close().catch(() => { });
    logger.info(`[${email}] Page fermée`);
  }
}

module.exports = { processAccount };