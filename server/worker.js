const path = require('path');
const { updateStatus } = require('./db');
const { logger } = require('./logger');

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');
const LOGIN_URL = 'https://testslanguesub.com/fr?auth=true&type=login';
const EXAM_URL = 'https://testslanguesub.com/fr/dashboard/exam-registration?step=exam-details&type=TCF-Quebec';
const TIMEOUT = 30_000;
const SHORT_TIMEOUT = 8_000;

// ── Utilitaires ────────────────────────────────────────────────────────────

async function screenshot(page, name) {
  try {
    const safe = name.replace(/[^a-z0-9_\-]/gi, '_');
    const file = path.join(SCREENSHOTS_DIR, `${safe}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    logger.warn(`Screenshot : ${path.basename(file)}`);
  } catch (_) { }
}

async function waitAndClick(page, selector, label, timeout = TIMEOUT) {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout });
    await page.click(selector);
  } catch (err) {
    throw new Error(`Impossible de cliquer "${label}" [${selector}] : ${err.message}`);
  }
}

// ── Vérification et restauration de la bonne page ─────────────────────────

async function ensureOnExamPage(page, email, password) {
  const currentUrl = page.url();
  logger.info(`[${email}] URL actuelle : ${currentUrl}`);

  // Cas 0 : Inscription déjà complète (upload-receipt)
  if (currentUrl.includes('step=upload-receipt')) {
    logger.success(`[${email}] Inscription déjà complète (upload-receipt) → completed`);
    throw new Error('ALREADY_COMPLETED');
  }


  // Cas 1 : Déjà sur la bonne page
  if (currentUrl.includes('exam-registration') && currentUrl.includes('step=exam-details')) {
    logger.success(`[${email}] Déjà sur la page examen ✓`);
    return;
  }

  // Cas 2 : Redirigé vers la page de connexion
  const isLoginPage =
    currentUrl.includes('auth=true') ||
    currentUrl.includes('type=login') ||
    (await page.locator('input[type="email"]').isVisible().catch(() => false));

  if (isLoginPage) {
    logger.warn(`[${email}] Session expirée — reconnexion en cours`);
    await stepLogin(page, email, password);
    await stepGoDirectToExam(page, email);
    return;
  }

  // Cas 3 : Autre page inconnue → forcer navigation vers login puis exam
  logger.warn(`[${email}] Page inattendue (${currentUrl}) — redirection forcée`);
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });

  const alreadyLogged = !(await page.locator('input[type="email"]').isVisible().catch(() => false));

  if (alreadyLogged) {
    logger.info(`[${email}] Session toujours active, navigation directe vers examen`);
  } else {
    logger.info(`[${email}] Page login détectée, authentification`);
    await stepLogin(page, email, password);
  }

  await stepGoDirectToExam(page, email);
}

// ── ÉTAPE 1 : Connexion ────────────────────────────────────────────────────

async function stepLogin(page, email, password) {
  logger.info(`[${email}] Étape 1 : Ouverture page de connexion`);

  await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });

  await page.waitForSelector('input[type="email"]', { state: 'visible', timeout: TIMEOUT });

  const emailInput = page.locator('input[type="email"]').first();
  await emailInput.fill(email);

  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: TIMEOUT });
  await passwordInput.fill(password);

  const loginBtn = page.locator('form button[type="submit"], form button:has-text("Se connecter")').first();
  await loginBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
  await loginBtn.dispatchEvent('click');

  await page.waitForTimeout(2500);

  const errorVisible = await page
    .locator('text=Détails de connexion invalides')
    .isVisible()
    .catch(() => false);

  if (errorVisible) {
    throw new Error('INVALID_CREDENTIALS');
  }

  logger.success(`[${email}] Connexion réussie`);
}

// ── ÉTAPE 2 : Navigation vers la page examen ──────────────────────────────

async function stepGoDirectToExam(page, email) {
  logger.info(`[${email}] Navigation directe vers sélection date`);

  await page.goto(EXAM_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });

  await page.waitForSelector('text=Détails de l\'examen', { timeout: TIMEOUT });

  logger.success(`[${email}] Page examen chargée`);
}

// ── ÉTAPE 3 : Sélection date d'examen ─────────────────────────────────────

async function stepSelectDate(page, email, password) {
  logger.info(`[${email}] Étape 3 : Sélection date + modules`);

  await page.waitForTimeout(1500);

  // ─────────────────────────────────────────────
  // 0. Vérifier qu'on est sur la bonne page
  //    et récupérer la session si besoin
  // ─────────────────────────────────────────────
  await ensureOnExamPage(page, email, password);

  await page.waitForTimeout(1000);

  // ─────────────────────────────────────────────
  // 1. Vérifier si aucun examen dispo
  // ─────────────────────────────────────────────
  const noExam = await page
    .locator('text=Aucun examen programmé')
    .isVisible()
    .catch(() => false);

  if (noExam) {
    logger.warn(`[${email}] Aucun examen programmé`);
    return false;
  }

  // ─────────────────────────────────────────────
  // 2. Attendre page détails examen
  // ─────────────────────────────────────────────
  await page.waitForSelector('text=Détails de l\'examen', { timeout: TIMEOUT });

  // ─────────────────────────────────────────────
  // 3. Sélectionner la PREMIÈRE date disponible
  // ─────────────────────────────────────────────
  logger.info(`[${email}] Sélection de la première date`);

  const dropdownTrigger = page
    .locator('div.relative.border.cursor-pointer.rounded')
    .first();

  await dropdownTrigger.waitFor({ state: 'visible', timeout: TIMEOUT });

  await dropdownTrigger.click({ force: true });

  await page.waitForTimeout(700);

  const dateOptions = dropdownTrigger.locator('ul li');

  const dateCount = await dateOptions.count();

  if (dateCount === 0) {
    logger.warn(`[${email}] Aucune date disponible`);
    return false;
  }

  const firstDate = await dateOptions.first().innerText();

  await dateOptions.first().click({ force: true });

  logger.success(`[${email}] Date choisie : ${firstDate.trim()}`);

  // ─────────────────────────────────────────────
  // 4. Sélectionner les 4 modules
  // ─────────────────────────────────────────────
  logger.info(`[${email}] Sélection des 4 modules`);

  const moduleCards = page.locator('article');

  const moduleCount = await moduleCards.count();

  if (moduleCount < 4) {
    throw new Error(`Modules insuffisants détectés (${moduleCount})`);
  }

  for (let i = 0; i < 4; i++) {
    const card = moduleCards.nth(i);

    const title = await card.locator('h2').innerText().catch(() => `Module ${i + 1}`);

    const selectBtn = card.locator('div.cursor-pointer').filter({ hasText: 'Select' }).first();

    await selectBtn.click({ force: true });

    logger.success(`[${email}] Module sélectionné : ${title}`);

    await page.waitForTimeout(500);
  }

  // ─────────────────────────────────────────────
  // 5. Vérifier qu'un prix total existe
  // ─────────────────────────────────────────────
  await page.waitForTimeout(1000);

  const priceText = await page
    .locator('p:has-text("Prix:")')
    .first()
    .innerText()
    .catch(() => '');

  if (!priceText.includes('XAF') || priceText.trim() === 'Prix:  XAF') {
    throw new Error('Prix total non calculé');
  }

  logger.success(`[${email}] Prix calculé : ${priceText}`);

  // ─────────────────────────────────────────────
  // 6. Continuer
  // ─────────────────────────────────────────────
  logger.info(`[${email}] Validation étape`);

  await page
    .locator('button:has-text("Continuer")')
    .first()
    .click({ force: true });

  await page.waitForTimeout(2500);

  logger.success(`[${email}] Étape examen terminée`);

  return true;
}

// ── ÉTAPE 3b : Enregistrer et continuer après date ────────────────────────

async function stepSaveDetailsAndContinue(page, email) {
  logger.info(`[${email}] Étape 3b : Enregistrer et continuer`);

  await waitAndClick(
    page,
    'button:has-text("Reserver ma place")',
    'Enregistrer et continuer (étape 3b)'
  );

  await page.waitForSelector('text=Vérifier et confirmer', { timeout: TIMEOUT });
  logger.info(`[${email}] Page "Vérifier et confirmer" chargée`);
}

// ── ÉTAPE 3c : Confirmation réservation ────────────────────────

async function confirmReservation(page, email) {
  logger.info(`[${email}] Confirmation réservation`);

  const modal = page.locator('div.fixed.z-\\[9999\\]');

  await modal.waitFor({ state: 'visible', timeout: 10000 });

  const confirmBtn = modal.locator('button:has-text("Reserver ma place")');
  await confirmBtn.waitFor({ state: 'visible', timeout: 10000 });
  await confirmBtn.click({ force: true });

  logger.success(`[${email}] Popup confirmation détecté`);

  await page.waitForTimeout(2000);

  await page.locator('text=Confirmation d\'inscription')
    .waitFor({ state: 'hidden', timeout: 10000 })
    .catch(() => { });

  logger.success(`[${email}] Réservation validée`);
  logger.success(`[${email}] Place réservée`);
}

// ── Entrée principale ──────────────────────────────────────────────────────

async function processAccount(context, user) {
  const { id, email, password } = user;
  const page = await context.newPage();

  try {
    updateStatus(id, 'processing');
    logger.info(`[${email}] ▶️  Démarrage du traitement`);

    await stepLogin(page, email, password);
    await stepGoDirectToExam(page, email);

    // password transmis pour permettre la récupération de session
    const dateFound = await stepSelectDate(page, email, password);

    if (!dateFound) {
      updateStatus(id, 'no_exam_found');
      logger.warn(`[${email}] Aucun examen disponible → no_exam_found`);
      return 'no_exam_found';
    }

    await stepSaveDetailsAndContinue(page, email);
    await confirmReservation(page, email);

    updateStatus(id, 'completed');
    logger.success(`[${email}] 🎉 completed — paiement à effectuer manuellement`);
    return 'completed';

  } catch (err) {
    if (err.message === 'ALREADY_COMPLETED') {
      updateStatus(id, 'completed');
      logger.success(`[${email}] ✅ Déjà inscrit → completed`);
      return 'completed';
    }

    if (err.message === 'INVALID_CREDENTIALS') {
      logger.error(`[${email}] ❌ Identifiants incorrects → failed`);
      await screenshot(page, `${email.replace(/[@.]/g, '_')}_invalid_creds`);
      updateStatus(id, 'failed');
      return 'invalid_credentials';
    }

    logger.error(`[${email}] ❌ Erreur : ${err.message}`);
    await screenshot(page, email.replace(/[@.]/g, '_'));
    updateStatus(id, 'failed');
    return 'failed';

  } finally {
    await page.close().catch(() => { });
    logger.info(`[${email}] Page fermée`);
  }
}

module.exports = { processAccount };