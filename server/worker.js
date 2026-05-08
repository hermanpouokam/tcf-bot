const path = require('path');
const fs = require('fs');
const { updateStatus } = require('./db');
const { logger } = require('./logger');

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');
const RECEIPTS_DIR = path.join(__dirname, '..', 'receipts');
const LOGIN_URL = 'https://testslanguesub.com/fr?auth=true&type=login';
const TIMEOUT = 30000;

// ── Utilitaires ────────────────────────────────────────────────────────────

async function screenshot(page, name) {
  try {
    const safe = name.replace(/[^a-z0-9_\-]/gi, '_');
    const file = path.join(SCREENSHOTS_DIR, `${safe}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    logger.warn(`Screenshot : ${path.basename(file)}`);
  } catch (_) { }
}

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

  if (currentUrl.includes('step=upload-receipt')) {
    throw new Error('GOTO_UPLOAD');
  }

  if (currentUrl.includes('exam-registration') && currentUrl.includes('step=exam-details')) {
    logger.success(`[${email}] Déjà sur la page examen ✓`);
    return;
  }

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

  logger.warn(`[${email}] Page inattendue (${currentUrl}) — redirection`);
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
    has: page.locator('td', { hasText: 'TCF-Quebec' })
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

    if (currentValue !== 'TCF-Quebec') {
      logger.info(`[${email}] Sélection de TCF-Quebec`);
      await examDropdown.click();

      const option = page.locator('li', { hasText: 'TCF-Quebec' }).first();
      await option.waitFor({ state: 'visible', timeout: TIMEOUT });
      await option.click();

      await page.waitForFunction(() => {
        return [...document.querySelectorAll('p')]
          .some(p => p.textContent?.trim() === 'TCF-Quebec');
      }, { timeout: TIMEOUT });

      logger.success(`[${email}] TCF-Quebec sélectionné`);
    } else {
      logger.success(`[${email}] TCF-Quebec déjà sélectionné`);
    }


    // ── continuer ────────────────────────────────────
    const continueBtn = page.locator('button:has-text("Continuer")').first();

    await continueBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
    await continueBtn.click();

    // Détecter ce qui apparaît après la sélection
    const nextStep = await waitForOneOf(page, [
      "text=Détails de l'examen",
      'text=Télécharger le reçu',
    ]);

    if (nextStep === 'text=Télécharger le reçu') {
      logger.success(`[${email}] Déjà inscrit → upload-receipt`);
      throw new Error('GOTO_UPLOAD');
    }

    if (nextStep === "text=Détails de l'examen") {
      logger.success(`[${email}] Page examen chargée directement`);
      return;
    }


    const destination = await waitForOneOf(page, [
      "text=Détails de l'examen",
      'text=Télécharger le reçu',
    ]);

    if (destination === 'text=Télécharger le reçu') {
      logger.success(`[${email}] Redirigé vers upload-receipt après continuer`);
      throw new Error('GOTO_UPLOAD');
    }

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

  const noExam = await page.locator('text=Aucun examen programmé').isVisible().catch(() => false);
  if (noExam) {
    logger.warn(`[${email}] Aucun examen programmé`);
    return false;
  }

  await waitVisible(page, "text=Détails de l'examen");

  // Sélectionner la première date
  logger.info(`[${email}] Sélection de la première date`);

  const dropdownTrigger = page.locator('div.relative.border.cursor-pointer.rounded').first();
  await dropdownTrigger.waitFor({ state: 'visible', timeout: TIMEOUT });
  await dropdownTrigger.click({ force: true });

  await waitVisible(page, 'div.relative.border.cursor-pointer.rounded ul li');

  const dateOptions = dropdownTrigger.locator('ul li');
  const dateCount = await dateOptions.count();

  if (dateCount === 0) {
    logger.warn(`[${email}] Aucune date dans le dropdown`);
    return false;
  }

  const firstDate = await dateOptions.first().innerText();
  await dateOptions.first().click({ force: true });

  await page.waitForSelector('div.relative.border.cursor-pointer.rounded ul', {
    state: 'hidden',
    timeout: 5000
  }).catch(() => { });

  const urlAfter = page.url();
  logger.info(`[${email}] URL après stabilisation : ${urlAfter}`);

  // CAS 1 : déjà inscrit → upload-receipt
  if (urlAfter.includes('step=upload-receipt')) {
    logger.success(`[${email}] Déjà inscrit → upload-receipt`);
    throw new Error('GOTO_UPLOAD');
  }

  logger.success(`[${email}] Date choisie : ${firstDate.trim()}`);

  // Sélectionner les 4 modules
  logger.info(`[${email}] Sélection des 4 modules`);

  await waitVisible(page, 'article');

  const moduleCards = page.locator('article');
  const moduleCount = await moduleCards.count();

  if (moduleCount < 4) throw new Error(`Modules insuffisants (${moduleCount})`);

  for (let i = 0; i < 4; i++) {
    const card = moduleCards.nth(i);
    const title = await card.locator('h2').innerText().catch(() => `Module ${i + 1}`);
    const selectBtn = card.locator('div.cursor-pointer').filter({ hasText: 'Select' }).first();
    await selectBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
    await selectBtn.click({ force: true });

    await page.waitForFunction(
      (idx) => {
        const cards = document.querySelectorAll('article');
        const card = cards[idx];
        if (!card) return false;
        const btn = card.querySelector('div[class*="cursor-pointer"]');
        return btn && !btn.textContent.includes('Select');
      },
      i,
      { timeout: 100 }
    ).catch(() => { });

    logger.success(`[${email}] Module : ${title}`);
  }



  // Vérifier le prix total
  await page.waitForFunction(() => {
    const allP = Array.from(document.querySelectorAll('p'));
    const priceEl = allP.find(p => p.textContent.includes('Prix:'));
    if (!priceEl) return false;
    const text = priceEl.textContent.trim();
    return text.includes('XAF') && text !== 'Prix:  XAF';
  }, { timeout: TIMEOUT });

  const priceText = await page.locator('p:has-text("Prix:")').first().innerText().catch(() => '');
  logger.success(`[${email}] Prix : ${priceText}`);

  // Cliquer Continuer
  logger.info(`[${email}] Clic sur Continuer`);
  const continuerBtn = page.locator('button:has-text("Continuer")').first();
  await continuerBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
  await continuerBtn.click({ force: true });

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
  logger.info(`[${email}] URL après stabilisation : ${urlAfter}`);

  // CAS 1 : déjà inscrit → upload-receipt
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
    logger.success(`[${email}] Réservation validée`);
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

  // Attendre la page upload
  await waitVisible(page, 'input#upload');

  // Upload le fichier
  await page.locator('input#upload').setInputFiles(receiptFile);
  logger.success(`[${email}] Fichier uploadé`);

  // Attendre que les champs soient disponibles
  await waitVisible(page, 'input[name="transactionID"]');

  await page.locator('input[name="transactionID"]').fill(user.transaction_id);
  await page.locator('input[name="paymentDate"]').fill(user.payment_date);
  await page.locator('input[name="senderName"]').fill(user.sender_name);

  // ── Cibler le bouton S'inscrire DANS le formulaire uniquement ──
  // (évite le conflit avec le bouton S'inscrire du header)
  const submitBtn = page.locator('form button:has-text("S\'inscrire")').first();
  await submitBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
  await submitBtn.click({ force: true });

  logger.info(`[${email}] Soumission en cours...`);

  // Attendre que le bouton Annuler disparaisse (soumission en cours)
  await page.waitForSelector('button:has-text("Annuler")', {
    state: 'hidden',
    timeout: 10000
  }).catch(() => { });


  // Puis attendre soit sa réapparition soit un changement de page
  await waitForOneOf(page, [
    'text=Inscription terminée !',
  ]).catch(() => { });

  logger.success(`[${email}] ✅ Reçu soumis — en attente confirmation`);
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
        updateStatus(id, 'pending');
        logger.warn(`[${email}] Inscription non trouvée → remis en pending`);
        return 'pending';
      }
    }

    // Flux normal
    await stepGoDirectToExam(page, email);

    const dateFound = await stepSelectDate(page, email, password);
    if (!dateFound) {
      updateStatus(id, 'no_exam_found');
      logger.warn(`[${email}] Aucun examen → no_exam_found`);
      return 'no_exam_found';
    }

    await stepSaveDetailsAndContinue(page, email);
    await confirmReservation(page, email);
    await stepUploadReceipt(page, email, user);  // ← appelé UNE SEULE FOIS

    updateStatus(id, 'pending_confirm');
    logger.success(`[${email}] 📋 pending_confirm — vérification au prochain passage`);
    return 'pending_confirm';

  } catch (err) {

    // Compte déjà réservé → aller directement upload
    if (err.message === 'GOTO_UPLOAD') {
      try {
        await stepUploadReceipt(page, email, user);  // ← appelé UNE SEULE FOIS
        updateStatus(id, 'pending_confirm');
        logger.success(`[${email}] 📋 Reçu uploadé → pending_confirm`);
        return 'pending_confirm';
      } catch (uploadErr) {
        logger.error(`[${email}] Erreur upload : ${uploadErr.message}`);
        await screenshot(page, email.replace(/[@.]/g, '_'));
        updateStatus(id, 'failed');
        return 'failed';
      }
    }

    if (err.message === 'INVALID_CREDENTIALS') {
      logger.error(`[${email}] ❌ Identifiants incorrects`);
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