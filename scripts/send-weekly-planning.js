/**
 * Script d'automatisation WhatsApp : send-weekly-planning.js
 * ==============================================================================
 * 1. Ouvre le site en mode capture (?mode=capture) avec Playwright
 * 2. Configure le fuseau horaire 'Africa/Libreville' (UTC+1)
 * 3. Attend le chargement complet des données Supabase (#planning-screenshot-zone)
 * 4. Prend une capture haute résolution de l'image combinée des deux équipes
 * 5. Diffuse l'image sur le groupe WhatsApp via l'API Green API (sendFileByUpload)
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');

async function main() {
  console.log('==================================================================');
  console.log('🤖 BOT WHATSAPP : CAPTURE & DIFFUSION HEBDOMADAIRE DU PLANNING');
  console.log('==================================================================');

  // 1. Récupération des variables d'environnement
  const instanceId = process.env.GREEN_API_INSTANCE_ID;
  const apiToken = process.env.GREEN_API_TOKEN;
  const chatId = process.env.WHATSAPP_CHAT_ID;
  const host = process.env.GREEN_API_HOST || 'https://7107.api.greenapi.com';
  const siteUrl = process.env.SITE_URL || 'https://stg-welle.github.io/rotation-urgences/';

  // Vérification de la configuration
  if (!instanceId || !apiToken || !chatId) {
    console.error('❌ ERREUR : Identifiants Green API ou ChatId manquants dans les variables d\'environnement !');
    console.error('Assurez-vous de configurer les variables suivantes :');
    console.error('  - GREEN_API_INSTANCE_ID (ex: 7107123456)');
    console.error('  - GREEN_API_TOKEN       (ex: d79e672...)');
    console.error('  - WHATSAPP_CHAT_ID      (ex: 120363023456789012@g.us)');
    console.error('  - GREEN_API_HOST        (optionnel, par défaut : https://7107.api.greenapi.com)');
    console.error('  - SITE_URL              (optionnel, par défaut : https://stg-welle.github.io/rotation-urgences/)');
    process.exit(1);
  }

  // Chargement de Playwright
  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch {
    console.error('❌ ERREUR : Le module "playwright" est introuvable.');
    console.error('Installez-le avec : npm install && npx playwright install --with-deps chromium');
    process.exit(1);
  }

  const cleanHost = host.replace(/\/+$/, '');
  const targetUrl = siteUrl.includes('?') ? `${siteUrl}&mode=capture` : `${siteUrl}?mode=capture`;

  console.log(`📍 Site cible       : ${targetUrl}`);
  console.log(`📍 Instance Green API: ${instanceId}`);
  console.log(`📍 Groupe WhatsApp   : ${chatId}`);
  console.log(`📍 Fuseau horaire    : Africa/Libreville (UTC+1)\n`);

  // 2. Lancement du navigateur Chromium en mode headless avec Playwright
  console.log('🚀 [1/4] Démarrage du navigateur headless (Chromium)...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1300, height: 1600 },
    deviceScaleFactor: 2, // Haute résolution Retina (image nette pour zoom sur smartphone)
    timezoneId: 'Africa/Libreville',
    locale: 'fr-FR'
  });

  const page = await context.newPage();

  // 3. Navigation et attente des données Supabase
  console.log(`🌐 [2/4] Chargement de la page de capture...`);
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });

  console.log('⏳ [2/4] Attente de la validation du conteneur #planning-screenshot-zone[data-loaded="true"]...');
  await page.waitForSelector('#planning-screenshot-zone[data-loaded="true"]', { timeout: 35000 });

  // Pause de stabilisation pour les polices Google Fonts et les rendus CSS
  await page.waitForTimeout(1200);

  // 4. Prise de la capture d'écran
  const screenshotZone = await page.$('#planning-screenshot-zone');
  if (!screenshotZone) {
    await browser.close();
    throw new Error('Élément #planning-screenshot-zone introuvable après chargement !');
  }

  const outputPath = path.resolve(__dirname, '../planning-semaine.png');
  console.log(`📸 [3/4] Capture de la zone de planning (Équipe 1 + Équipe 2)...`);
  await screenshotZone.screenshot({ path: outputPath });
  console.log(`✅ [3/4] Image haute résolution générée avec succès : ${outputPath}`);

  await browser.close();

  // 5. Contrôle pré-vol du statut de l'instance Green API
  try {
    const stateUrl = `${cleanHost}/waInstance${instanceId}/getStateInstance/${apiToken}`;
    const stateRes = await fetch(stateUrl);
    const stateData = await stateRes.json();
    console.log(`📡 Contrôle Green API : Statut = ${stateData.stateInstance || 'inconnu'}`);
    if (stateData.stateInstance && stateData.stateInstance !== 'authorized') {
      console.warn(`⚠️ Avertissement : L'instance WhatsApp n'est pas "authorized" (${stateData.stateInstance}).`);
    }
  } catch (stateErr) {
    console.warn(`⚠️ Contrôle pré-vol ignoré : ${stateErr.message}`);
  }

  // 6. Envoi de l'image sur WhatsApp via Green API (sendFileByUpload)
  console.log(`📤 [4/4] Envoi de l'image dans le groupe WhatsApp via Green API (sendFileByUpload)...`);
  const fileBuffer = fs.readFileSync(outputPath);
  const fileBlob = new Blob([fileBuffer], { type: 'image/png' });

  const captionText = "📅 Bonjour à tous ! Voici le planning complet de rotation des salles (Équipe 1 & Équipe 2) pour cette semaine. Bon stage à tous !";

  const formData = new FormData();
  formData.append('chatId', chatId);
  formData.append('caption', captionText);
  formData.append('file', fileBlob, 'planning-semaine.png');

  const sendFileUrl = `${cleanHost}/waInstance${instanceId}/sendFileByUpload/${apiToken}`;
  const response = await fetch(sendFileUrl, {
    method: 'POST',
    body: formData
  });

  const responseData = await response.json().catch(() => ({}));

  if (!response.ok || responseData.error) {
    console.error('❌ Échec de l\'envoi Green API :', responseData);
    throw new Error(`Green API sendFileByUpload error (HTTP ${response.status}) : ${JSON.stringify(responseData)}`);
  }

  console.log('🎉 SUCCÈS : Image du planning transmise au groupe WhatsApp !');
  console.log(`   Message ID : ${responseData.idMessage || 'OK'}`);
  console.log('==================================================================');
}

main().catch((err) => {
  console.error('\n💥 ERREUR FATALE LORS DE L\'EXÉCUTION DU BOT :', err.message);
  process.exit(1);
});
