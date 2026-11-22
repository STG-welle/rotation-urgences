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
  console.log('PLANNING WHATSAPP : CAPTURE & DIFFUSION HEBDOMADAIRE');
  console.log('==================================================================');

  // Neutralisation immédiate du déclencheur cron natif de GitHub Actions ('schedule').
  // En raison de la saturation des runners GitHub le dimanche soir, l'événement 'schedule'
  // accuse 2 à 4 heures de retard (exécuté vers 22h-23h) et crée un doublon indésirable.
  // L'envoi officiel et ponctuel à 19h00 pile est pris en charge par Supabase pg_cron (workflow_dispatch).
  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    console.log('[DÉCLENCHEUR SCHEDULE BLOQUÉ] Le déclencheur cron natif de GitHub Actions est ignoré pour éviter l\'envoi tardif en doublon.');
    console.log('   L\'envoi du planning est géré exclusivement à 19h00 pile par Supabase pg_cron.');
    console.log('==================================================================');
    return;
  }

  // 1. Récupération des variables d'environnement
  const instanceId = process.env.GREEN_API_INSTANCE_ID;
  const apiToken = process.env.GREEN_API_TOKEN;
  let chatId = process.env.WHATSAPP_CHAT_ID || '120363428929551454@g.us';
  const host = process.env.GREEN_API_HOST || 'https://7107.api.greenapi.com';
  const siteUrl = process.env.SITE_URL || 'https://stg-welle.github.io/rotation-urgences/';
  const supabaseUrl = process.env.SUPABASE_URL || 'https://ezpbmutbkuoudmyyozlr.supabase.co';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_U7-ao4uwjTorXXLeCyClBA_ZkytQqmE';

  let customCaption = null;
  let activeRequestId = null;

  // Vérifier s'il y a une demande interactive ciblée (ex: commande 'pln' envoyée en privé par l'Admin)
  try {
    const queueRes = await fetch(`${supabaseUrl}/rest/v1/bot_capture_requests?status=eq.pending&order=created_at.desc&limit=1`, {
      headers: {
        'apikey': supabaseAnonKey,
        'Authorization': `Bearer ${supabaseAnonKey}`
      }
    });
    const queueData = await queueRes.json().catch(() => []);
    if (Array.isArray(queueData) && queueData.length > 0) {
      const item = queueData[0];
      const ageMinutes = (Date.now() - new Date(item.created_at).getTime()) / (1000 * 60);
      if (ageMinutes <= 10 && item.chat_id) {
        chatId = item.chat_id;
        activeRequestId = item.id;
        if (item.caption) customCaption = item.caption;
        console.log(`[DEMANDE CIBLÉE] Commande 'pln' de ${item.sender || 'utilisateur'} -> Expédition exclusive vers : ${chatId}`);
      }
    }
  } catch (qErr) {
    console.warn('Vérification file de capture ignorée:', qErr.message);
  }

  // Vérification de la configuration
  if (!instanceId || !apiToken || !chatId) {
    console.error('ERREUR : Identifiants Green API ou ChatId manquants dans les variables d\'environnement.');
    console.error('Assurez-vous de configurer les variables suivantes :');
    console.error('  - GREEN_API_INSTANCE_ID (ex: 7107123456)');
    console.error('  - GREEN_API_TOKEN       (ex: d79e672...)');
    console.error('  - WHATSAPP_CHAT_ID      (ex: 120363023456789012@g.us)');
    console.error('  - GREEN_API_HOST        (optionnel, par défaut : https://7107.api.greenapi.com)');
    console.error('  - SITE_URL              (optionnel, par défaut : https://stg-welle.github.io/rotation-urgences/)');
    process.exit(1);
  }

  // Calcul de la date du jour au fuseau horaire de Libreville (UTC+1)
  const librevilleDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Libreville',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  const weeklyDispatchKey = `weekly_${librevilleDate}`;

  const isMainGroup = chatId === (process.env.WHATSAPP_CHAT_ID || '120363428929551454@g.us');
  const isForce = process.env.FORCE_SEND === 'true' || process.env.FORCE_SEND === true;

  // Contrôle anti-doublon strict (Idempotence pour l'envoi hebdomadaire au groupe principal)
  if (isMainGroup && !activeRequestId && !isForce) {
    try {
      const checkRes = await fetch(`${supabaseUrl}/rest/v1/whatsapp_dispatch_history?dispatch_date=eq.${weeklyDispatchKey}&status=eq.sent&limit=1`, {
        headers: {
          'apikey': supabaseAnonKey,
          'Authorization': `Bearer ${supabaseAnonKey}`
        }
      });
      const checkData = await checkRes.json().catch(() => []);
      if (Array.isArray(checkData) && checkData.length > 0) {
        console.log(`[ANTI-DOUBLON STRICT] Le planning hebdomadaire pour le ${librevilleDate} a DÉJÀ été envoyé aujourd'hui.`);
        console.log(`   Destinataire principal (${chatId}) déjà notifié (Message ID: ${checkData[0].whatsapp_message_id || 'OK'}).`);
        console.log(`   Envoi annulé avec succès pour éviter tout doublon dans le groupe WhatsApp.`);
        console.log('==================================================================');
        return;
      }
    } catch (checkErr) {
      console.warn('Vérification anti-doublon ignorée :', checkErr.message);
    }
  }

  // Chargement de Playwright
  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch {
    console.error('ERREUR : Le module "playwright" est introuvable.');
    console.error('Installez-le avec : npm install && npx playwright install --with-deps chromium');
    process.exit(1);
  }

  const cleanHost = host.replace(/\/+$/, '');
  const targetUrl = siteUrl.includes('?') ? `${siteUrl}&mode=capture` : `${siteUrl}?mode=capture`;

  console.log(`Site cible       : ${targetUrl}`);
  console.log(`Instance Green API: ${instanceId}`);
  console.log(`Groupe WhatsApp   : ${chatId}`);
  console.log(`Fuseau horaire    : Africa/Libreville (UTC+1)\n`);

  // 2. Lancement du navigateur Chromium en mode headless avec Playwright
  console.log('[1/4] Démarrage du navigateur headless (Chromium)...');
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
  console.log(`[2/4] Chargement de la page de capture...`);
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });

  console.log('[2/4] Attente de la validation du conteneur #planning-screenshot-zone[data-loaded="true"]...');
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
  console.log(`[3/4] Capture de la zone de planning (Équipe 1 + Équipe 2)...`);
  await screenshotZone.screenshot({ path: outputPath });
  console.log(`[3/4] Image haute résolution générée avec succès : ${outputPath}`);

  await browser.close();

  // 5. Contrôle pré-vol du statut de l'instance Green API
  try {
    const stateUrl = `${cleanHost}/waInstance${instanceId}/getStateInstance/${apiToken}`;
    const stateRes = await fetch(stateUrl);
    const stateData = await stateRes.json();
    console.log(`Contrôle Green API : Statut = ${stateData.stateInstance || 'inconnu'}`);
    if (stateData.stateInstance && stateData.stateInstance !== 'authorized') {
      console.warn(`Avertissement : L'instance WhatsApp n'est pas "authorized" (${stateData.stateInstance}).`);
    }
  } catch (stateErr) {
    console.warn(`Contrôle pré-vol ignoré : ${stateErr.message}`);
  }

  // 6. Envoi de l'image sur WhatsApp via Green API (sendFileByUpload)
  console.log(`[4/4] Envoi de l'image dans le groupe WhatsApp via Green API (sendFileByUpload)...`);
  const fileBuffer = fs.readFileSync(outputPath);
  const fileBlob = new Blob([fileBuffer], { type: 'image/png' });

  const defaultCaption = '*CHUL • URGENCES PÉDIATRIQUES*\n*Planning hebdomadaire*';
  const captionText = customCaption || process.env.WHATSAPP_CAPTION || defaultCaption;

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
    console.error('Échec de l\'envoi Green API :', responseData);
    throw new Error(`Green API sendFileByUpload error (HTTP ${response.status}) : ${JSON.stringify(responseData)}`);
  }

  console.log('Succès : Image du planning transmise au chat cible.');
  console.log(`   Destinataire : ${chatId}`);
  console.log(`   Message ID : ${responseData.idMessage || 'OK'}`);

  // Enregistrement du verrou anti-doublon dans Supabase si diffusion au groupe principal
  if (isMainGroup && !activeRequestId) {
    try {
      await fetch(`${supabaseUrl}/rest/v1/whatsapp_dispatch_history`, {
        method: 'POST',
        headers: {
          'apikey': supabaseAnonKey,
          'Authorization': `Bearer ${supabaseAnonKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          dispatch_date: weeklyDispatchKey,
          message_text: `Planning hebdomadaire (image capture) - Semaine du ${librevilleDate}`,
          whatsapp_message_id: responseData.idMessage || 'OK',
          gateway: 'Green API',
          source: 'github_actions_weekly',
          status: 'sent'
        })
      });
      console.log(`Verrou anti-doublon enregistré dans Supabase (${weeklyDispatchKey}).`);
    } catch (historyErr) {
      console.warn('Enregistrement historique ignoré :', historyErr.message);
    }
  }

  if (activeRequestId) {
    try {
      await fetch(`${supabaseUrl}/rest/v1/bot_capture_requests?id=eq.${activeRequestId}`, {
        method: 'PATCH',
        headers: {
          'apikey': supabaseAnonKey,
          'Authorization': `Bearer ${supabaseAnonKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'completed' })
      });
      console.log(`Demande ciblée #${activeRequestId} clôturée avec succès dans Supabase.`);
    } catch (_) {}
  }

  // 7. Sauvegarde automatique de la nouvelle capture sur GitHub main
  const githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  if (githubToken) {
    try {
      console.log('Sauvegarde automatique de la capture sur GitHub main...');
      const getFileRes = await fetch('https://api.github.com/repos/STG-welle/rotation-urgences/contents/planning-semaine.png', {
        headers: { 'Authorization': `Bearer ${githubToken}`, 'User-Agent': 'node', 'Accept': 'application/vnd.github.v3+json' }
      });
      const fileData = await getFileRes.json();
      const currentSha = fileData.sha;

      const fileBase64 = fileBuffer.toString('base64');
      const putRes = await fetch('https://api.github.com/repos/STG-welle/rotation-urgences/contents/planning-semaine.png', {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${githubToken}`, 'User-Agent': 'node', 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'chore: actualisation automatique de planning-semaine.png [skip ci]',
          content: fileBase64,
          sha: currentSha,
          branch: 'main'
        })
      });
      const putData = await putRes.json();
      if (putRes.ok) {
        console.log('planning-semaine.png mis à jour avec succès sur GitHub.');
      } else {
        console.warn('Échec mise à jour GitHub API :', putData.message || putData);
      }
    } catch (ghErr) {
      console.warn('Erreur mise à jour GitHub API :', ghErr.message);
    }
  }

  console.log('==================================================================');
}

main().catch((err) => {
  console.error('\nERREUR FATALE LORS DE L\'EXÉCUTION :', err.message);
  process.exit(1);
});
