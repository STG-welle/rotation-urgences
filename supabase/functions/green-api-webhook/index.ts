/**
 * Supabase Edge Function : green-api-webhook
 * ==============================================================================
 * Système de Monitoring, Détection de Déconnexion & Alerte Immédiate pour Green API
 *
 * Écoute les webhooks de Green API, notamment l'événement "stateInstanceChanged".
 * Détecte les statuts critiques ("notAuthorized", "blocked", "sleepMode"),
 * récupère automatiquement le QR Code de reconnexion, met à jour la base Supabase
 * et déclenche une alerte immédiate vers l'administrateur.
 * ==============================================================================
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

// Cooldown anti-spam par chat (20 secondes)
const lastBotReplyByChat = new Map<string, number>();
const BOT_COOLDOWN_MS = 20000;

// Contacts autorisés par défaut (signatures des numéros : derniers chiffres)
// Modifiable aussi via variable d'environnement Supabase AUTHORIZED_WHATSAPP_NUMBERS
const DEFAULT_AUTHORIZED_SIGNATURES = [
  "7666132",   // Admin (07666132 / 24107666132)
  "76353912",  // Praise (24176353912)
  "7927294",   // Zeus (24107927294)
  "7235223",   // Esther Georda (24107235223)
];

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // Configuration Supabase & Green API
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const greenInstanceId = Deno.env.get("GREEN_API_INSTANCE_ID") || "";
  const greenApiToken = Deno.env.get("GREEN_API_TOKEN") || "";
  const greenHost = (Deno.env.get("GREEN_API_HOST") || "https://7107.api.greenapi.com").replace(/\/+$/, "");
  const adminEmail = Deno.env.get("ADMIN_ALERT_EMAIL") || "chrystopenai@gmail.com";
  const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
  const brevoApiKey = Deno.env.get("BREVO_API_KEY") || "";
  const alertWebhookUrl = Deno.env.get("ALERT_WEBHOOK_URL") || "";
  const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  const telegramChatId = Deno.env.get("TELEGRAM_CHAT_ID") || "";
  const ntfyTopic = Deno.env.get("NTFY_TOPIC") || "rotation-urgences-chryst";

  const supabase = createClient(supabaseUrl, supabaseKey);

  // ============================================================================
  // 1. ENDPOINT GET : Visualisation Live du QR Code ou Statut
  // ============================================================================
  if (req.method === "GET") {
    // A. Endpoint JSON pour la page web qr.html
    if (action === "qr_json") {
      let qrImageSrc: string | null = null;
      let qrStatusText = "Récupération du statut...";
      let isAlreadyLogged = false;

      if (greenInstanceId && greenApiToken) {
        try {
          const qrResp = await fetch(`${greenHost}/waInstance${greenInstanceId}/qr/${greenApiToken}`);
          const qrData = await qrResp.json();
          if (qrData.type === "alreadyLogged") {
            isAlreadyLogged = true;
            qrStatusText = "Instance WhatsApp déjà connectée et autorisée !";
          } else if (qrData.type === "qrCode" && qrData.message) {
            qrImageSrc = qrData.message.startsWith("data:") 
              ? qrData.message 
              : `data:image/png;base64,${qrData.message}`;
            qrStatusText = "Scannez ce QR Code avec WhatsApp (Appareils connectés) :";
          } else {
            qrStatusText = `Statut : ${qrData.message || JSON.stringify(qrData)}`;
          }
        } catch (e) {
          qrStatusText = `Erreur de connexion Green API : ${(e as Error).message}`;
        }
      } else {
        qrStatusText = "Identifiants Green API non configurés.";
      }

      return new Response(JSON.stringify({
        success: true,
        instanceId: greenInstanceId,
        isAlreadyLogged,
        qrImage: qrImageSrc,
        qrStatusText
      }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    // B. Redirection automatique vers la page de visualisation hébergée
    if (action === "qr") {
      return Response.redirect("https://stg-welle.github.io/rotation-urgences/qr.html", 302);
    }

    // Test de notification Telegram
    if (action === "test_telegram") {
      try {
        const testRes = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: telegramChatId,
            text: "🟢 *Surveillance WhatsApp Active*\n\nLe Bot Telegram est parfaitement opérationnel. En cas de déconnexion de l'instance Green API, vous recevrez ici une alerte immédiate avec le QR Code de reconnexion.",
            parse_mode: "Markdown"
          })
        });
        const testData = await testRes.json();
        return new Response(JSON.stringify(testData, null, 2), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
    }

    // Endpoint GET / POST pour déclencher la diffusion immédiate depuis le panel Admin
    if (action === "trigger_dispatch") {
      const githubPat = Deno.env.get("GITHUB_PAT") || "";
      const repo = "STG-welle/rotation-urgences";
      const workflow = "weekly-planning-screenshot.yml";

      if (!githubPat) {
        return new Response(JSON.stringify({ error: "GITHUB_PAT non configuré dans Supabase." }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }

      try {
        const ghRes = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${githubPat}`,
            "User-Agent": "rotation-urgences-supabase",
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ ref: "main" })
        });

        if (ghRes.status === 204 || ghRes.ok) {
          return new Response(JSON.stringify({ success: true, message: "Workflow GitHub Actions déclenché avec succès !" }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
          });
        } else {
          const errText = await ghRes.text();
          return new Response(JSON.stringify({ error: `Erreur GitHub API (${ghRes.status}): ${errText}` }), {
            status: ghRes.status,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
          });
        }
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
    }

    // B. Endpoint GET pour vérifier les réglages enregistrés sur Green API
    if (action === "settings") {
      try {
        const settingsResp = await fetch(`${greenHost}/waInstance${greenInstanceId}/getSettings/${greenApiToken}`);
        const settingsData = await settingsResp.json();
        return new Response(JSON.stringify(settingsData, null, 2), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
    }

    // C. Endpoints GET pour activer / désactiver l'écoute des messages
    if (action === "enable_bot") {
      try {
        const setResp = await fetch(`${greenHost}/waInstance${greenInstanceId}/setSettings/${greenApiToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            incomingWebhook: "yes",
            outgoingMessageWebhook: "yes",
            stateWebhook: "yes"
          })
        });
        const setData = await setResp.json();
        return new Response(JSON.stringify({ success: true, message: "Bot activé sur Green API (entrant + sortant) !", result: setData }, null, 2), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
    }

    if (action === "disable_bot" || action === "disable_incoming") {
      try {
        const setResp = await fetch(`${greenHost}/waInstance${greenInstanceId}/setSettings/${greenApiToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            incomingWebhook: "no",
            outgoingMessageWebhook: "no",
            stateWebhook: "yes"
          })
        });
        const setData = await setResp.json();
        return new Response(JSON.stringify({ success: true, message: "Écoute des messages désactivée sur Green API !", result: setData }, null, 2), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
    }

    // D. Endpoint GET pour vérifier les informations du groupe WhatsApp
    if (action === "check_group") {
      const groupId = url.searchParams.get("groupId") || "120363426696951541@g.us";
      try {
        const groupRes = await fetch(`${greenHost}/waInstance${greenInstanceId}/getGroupData/${greenApiToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groupId })
        });
        const groupData = await groupRes.json();
        return new Response(JSON.stringify(groupData, null, 2), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
    }

    // E. Endpoint GET pour envoyer un message de test direct dans le nouveau groupe
    if (action === "send_test") {
      const targetGroup = url.searchParams.get("groupId") || "120363426696951541@g.us";
      try {
        const sendFileUrl = `${greenHost}/waInstance${greenInstanceId}/sendFileByUrl/${greenApiToken}`;
        const sendResp = await fetch(sendFileUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: targetGroup,
            urlFile: "https://raw.githubusercontent.com/STG-welle/rotation-urgences/main/planning-semaine.png",
            fileName: "planning-semaine.png",
            caption: "Bonsoir l'équipe ! Le planning des urgences pédiatriques pour la semaine prochaine est dispo ci-dessous.\n\nBonne semaine à tous !"
          })
        });
        const sendData = await sendResp.json();
        return new Response(JSON.stringify(sendData, null, 2), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
    }

    // F. Endpoint GET pour vérifier le statut d'un message
    if (action === "check_msg") {
      const idMessage = url.searchParams.get("id") || "3EB081F434FBF919770E32";
      const chatId = url.searchParams.get("chatId") || "120363426696951541@g.us";
      try {
        const msgRes = await fetch(`${greenHost}/waInstance${greenInstanceId}/getMessage/${greenApiToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId, idMessage })
        });
        const msgData = await msgRes.json();
        return new Response(JSON.stringify(msgData, null, 2), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
    }
    try {
      const stateResp = await fetch(`${greenHost}/waInstance${greenInstanceId}/getStateInstance/${greenApiToken}`);
      const stateData = await stateResp.json();
      const stateInstance = stateData.stateInstance || "unknown";
      const isAuthorized = stateInstance === "authorized";
      const isCritical = ["notAuthorized", "blocked", "sleepMode"].includes(stateInstance);
      const nowIso = new Date().toISOString();

      // Synchronisation en base de données Supabase
      await supabase
        .from("whatsapp_instance_status")
        .upsert({
          id: 1,
          instance_id: String(greenInstanceId),
          state_instance: stateInstance,
          is_connected: isAuthorized,
          last_connected_at: isAuthorized ? nowIso : undefined,
          alert_active: isCritical,
          updated_at: nowIso
        });

      return new Response(JSON.stringify({ ...stateData, database_synced: true }, null, 2), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }
  }

  // ============================================================================
  // 2. RÉCEPTION DU WEBHOOK GREEN API (POST)
  // ============================================================================
  if (req.method === "POST") {
    try {
      const payload = await req.json();
      console.log("Webhook Green API reçu :", JSON.stringify(payload));

      const typeWebhook = payload.typeWebhook;
      const stateInstance = payload.stateInstance;
      const instanceId = payload.instanceData?.idInstance || greenInstanceId;

      // 1. Filtrage strict de l'événement stateInstanceChanged
      if (typeWebhook === "stateInstanceChanged") {
        const isCritical = ["notAuthorized", "blocked", "sleepMode"].includes(stateInstance);
        const isAuthorized = stateInstance === "authorized";
        const nowIso = new Date().toISOString();

        let qrCodeData: string | null = null;

        // Si déconnexion critique, tenter de récupérer immédiatement le QR Code
        if (isCritical) {
          try {
            const qrRes = await fetch(`${greenHost}/waInstance${greenInstanceId}/qr/${greenApiToken}`);
            const qrJson = await qrRes.json();
            if (qrJson.type === "qrCode" && qrJson.message) {
              qrCodeData = qrJson.message;
            }
          } catch (qrErr) {
            console.warn("Impossible de récupérer le QR Code immédiatement :", qrErr);
          }
        }

        // 2. Mise à jour de la table d'état dans Supabase
        await supabase
          .from("whatsapp_instance_status")
          .upsert({
            id: 1,
            instance_id: String(instanceId),
            state_instance: stateInstance,
            is_connected: isAuthorized,
            last_qr_code: qrCodeData,
            last_disconnected_at: isCritical ? nowIso : undefined,
            last_connected_at: isAuthorized ? nowIso : undefined,
            alert_active: isCritical,
            updated_at: nowIso
          });

        // 3. Enregistrement dans l'historique des alertes
        await supabase.from("whatsapp_alerts").insert({
          event_type: isCritical ? "disconnected" : (isAuthorized ? "reconnected" : "status_changed"),
          state_instance: stateInstance,
          message: isCritical 
            ? `Alerte déconnexion WhatsApp : instance passée en ${stateInstance}`
            : `Notification WhatsApp : instance passée en ${stateInstance}`,
          qr_code_available: !!qrCodeData
        });

        // 4. Déclenchement de l'alerte immédiate vers l'administrateur
        if (isCritical) {
          await triggerAdminAlert({
            stateInstance,
            instanceId: String(instanceId),
            timeIso: nowIso,
            qrCodeData,
            adminEmail,
            resendApiKey,
            brevoApiKey,
            alertWebhookUrl,
            telegramBotToken,
            telegramChatId,
            ntfyTopic,
            supabaseUrl
          });
        }

        return new Response(
          JSON.stringify({
            success: true,
            processed: true,
            stateInstance,
            alertTriggered: isCritical
          }),
          { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }

      // 2. Traitement des messages : Bot Répondeur Interactif (mot-clé court "pln" ou "planning")
      // Gère les messages des participants (incomingMessageReceived) ET du numéro du bot (outgoingMessageReceived)
      if (typeWebhook === "incomingMessageReceived" || typeWebhook === "outgoingMessageReceived") {
        const messageData = payload.messageData || {};
        const textMessage = (
          messageData.textMessageData?.textMessage ||
          messageData.extendedTextMessageData?.text ||
          messageData.caption ||
          ""
        ).trim().toLowerCase();

        const chatId = payload.senderData?.chatId;
        const senderId = payload.senderData?.sender || payload.senderData?.chatId || "";
        const senderName = payload.senderData?.senderName || payload.senderData?.senderContactName || "Stagiaire";
        const quotedMessageId = payload.idMessage;

        console.log(`📩 Message WhatsApp (${typeWebhook}) reçu de ${senderName} (${senderId} / ${chatId}) : "${textMessage}"`);

        // Protection anti-boucle : Ignorer les images et les messages du bot
        if (payload.messageData?.typeMessage === "imageMessage") {
          return new Response(JSON.stringify({ success: true, ignored: "imageMessage" }), { headers: CORS_HEADERS });
        }
        const isBotMessage = textMessage.includes("planning des urgences pédiatriques") || textMessage.includes("bonsoir l'équipe") || textMessage.includes("voici de nouveau");

        // Détection du mot-clé court "pln" (ou "planning")
        const isPlnTrigger = /(?:^|\s|\/|!)(pln|planning)(?:\s|$|[!?.,])/i.test(textMessage);

        if (chatId && !isBotMessage && isPlnTrigger) {
          // Filtrage des contacts autorisés
          const envSignatures = (Deno.env.get("AUTHORIZED_WHATSAPP_NUMBERS") || "")
            .split(",")
            .map(s => s.trim().replace(/[^0-9]/g, ""))
            .filter(Boolean);

          const authorizedSignatures = envSignatures.length > 0
            ? envSignatures
            : DEFAULT_AUTHORIZED_SIGNATURES;

          const senderDigits = senderId.replace(/[^0-9]/g, "");
          const isAuthorized = authorizedSignatures.some(sig => senderDigits.endsWith(sig));

          if (!isAuthorized) {
            console.log(`⛔ Demande 'pln' ignorée : ${senderName} (${senderId}) n'est pas dans la liste des contacts autorisés.`);
            return new Response(
              JSON.stringify({ success: true, ignored: "unauthorized_sender", sender: senderId }),
              { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
          }

          // Protection anti-spam par cooldown (20 secondes)
          const now = Date.now();
          const lastSent = lastBotReplyByChat.get(chatId) || 0;
          if (now - lastSent < BOT_COOLDOWN_MS) {
            console.log(`⏳ [COOLDOWN] Demande 'pln' ignorée dans ${chatId} (${Math.round((now - lastSent) / 1000)}s écoulées sur 20s requises).`);
            return new Response(
              JSON.stringify({ success: true, ignored: "cooldown", chatId }),
              { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
          }
          lastBotReplyByChat.set(chatId, now);

          console.log(`🤖 [BOT AUTORISÉ] Commande 'pln' validée pour ${senderName} ! Envoi du planning au chat ${chatId}...`);

          const publicImageUrl = "https://raw.githubusercontent.com/STG-welle/rotation-urgences/main/planning-semaine.png";
          const captionText = "Salut ! Voici de nouveau le planning des urgences pédiatriques de la semaine.\n\nBonne semaine !";

          try {
            const sendFileUrl = `${greenHost}/waInstance${greenInstanceId}/sendFileByUrl/${greenApiToken}`;

            // Tentative 1 : avec citation du message demandeur
            let sendResp = await fetch(sendFileUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chatId,
                urlFile: publicImageUrl,
                fileName: "planning-semaine.png",
                caption: captionText,
                quotedMessageId
              })
            });

            let sendResult = await sendResp.json().catch(() => ({}));

            // Si échec avec quotedMessageId, repli sans citation
            if (!sendResp.ok || sendResult.error) {
              console.warn("Retentative d'envoi sendFileByUrl sans quote...", sendResult);
              sendResp = await fetch(sendFileUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chatId,
                  urlFile: publicImageUrl,
                  fileName: "planning-semaine.png",
                  caption: captionText
                })
              });
              sendResult = await sendResp.json().catch(() => ({}));
            }

            console.log("✅ Résultat final Green API sendFileByUrl :", JSON.stringify(sendResult));

            return new Response(
              JSON.stringify({
                success: true,
                botReplied: true,
                chatId,
                idMessage: sendResult.idMessage
              }),
              { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
          } catch (sendErr) {
            console.error("❌ Erreur expédition image via sendFileByUrl :", sendErr);
          }
        }

        return new Response(
          JSON.stringify({ success: true, processed: true }),
          { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }

      // Autres webhooks Green API acquittés avec 200 OK
      return new Response(
        JSON.stringify({ success: true, message: "Webhook reçu sans action requise" }),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.error("Erreur traitement webhook Green API :", err);
      return new Response(
        JSON.stringify({ success: false, error: (err as Error).message }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }
  }

  return new Response("Méthode non autorisée", { status: 405 });
});

// ==============================================================================
// 3. ENVOI DE L'ALERTE IMMÉDIATE (Push Téléphone ntfy.sh, Telegram, Email Brevo/Resend, Webhooks)
// ==============================================================================
async function triggerAdminAlert(opts: {
  stateInstance: string;
  instanceId: string;
  timeIso: string;
  qrCodeData: string | null;
  adminEmail: string;
  resendApiKey: string;
  brevoApiKey: string;
  alertWebhookUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  ntfyTopic: string;
  supabaseUrl: string;
}) {
  const dateFormatted = new Date(opts.timeIso).toLocaleString("fr-FR", { timeZone: "Africa/Libreville" });
  const qrViewUrl = "https://stg-welle.github.io/rotation-urgences/qr.html";

  console.warn(`🚨 [ALERTE CRITIQUE] WhatsApp déconnecté ! Statut : ${opts.stateInstance} à ${dateFormatted}`);

  // Canal 1 : Notification Push immédiate sur téléphone via ntfy.sh (100% Gratuit, Zéro Inscription requise)
  if (opts.ntfyTopic) {
    try {
      await fetch(`https://ntfy.sh/${opts.ntfyTopic}`, {
        method: "POST",
        headers: {
          "Title": "Alerte Deconnexion WhatsApp",
          "Priority": "high",
          "Tags": "warning,rotating_light",
          "Click": qrViewUrl,
          "Actions": `view, Scanner QR Code, ${qrViewUrl}`
        },
        body: `Attention : L instance WhatsApp ${opts.instanceId} s est deconnectee (${opts.stateInstance}) a ${dateFormatted}. Cliquez pour ouvrir le QR Code.`
      });
      console.log(`Notification push transmise sur ntfy.sh topic : https://ntfy.sh/${opts.ntfyTopic}`);
    } catch (ntfyErr) {
      console.warn("Échec alerte ntfy :", ntfyErr);
    }
  }

  // Canal 2 : Notification Telegram Bot (avec envoi direct de la photo du QR Code si disponible)
  if (opts.telegramBotToken && opts.telegramChatId) {
    try {
      let sentPhotoSuccess = false;

      // Tentative d'envoi direct de l'image QR Code sur Telegram
      if (opts.qrCodeData) {
        try {
          const rawBase64 = opts.qrCodeData.replace(/^data:image\/[a-z]+;base64,/, "");
          const binaryStr = atob(rawBase64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }

          const formData = new FormData();
          formData.append("chat_id", opts.telegramChatId);
          formData.append("photo", new Blob([bytes], { type: "image/png" }), "whatsapp-qr.png");
          formData.append("caption", `🚨 *ALERTE DÉCONNEXION WHATSAPP (Green API)*\n\n` +
            `⚠️ *Statut :* \`${opts.stateInstance}\`\n` +
            `📱 *Scannez directement ce QR Code avec WhatsApp* (Appareils connectés) pour réactiver l'envoi des plannings.\n\n` +
            `🌐 [Page de surveillance](${qrViewUrl})`);
          formData.append("parse_mode", "Markdown");

          const photoRes = await fetch(`https://api.telegram.org/bot${opts.telegramBotToken}/sendPhoto`, {
            method: "POST",
            body: formData
          });
          const photoJson = await photoRes.json();
          if (photoJson.ok) {
            sentPhotoSuccess = true;
            console.log("Photo QR Code envoyée avec succès sur Telegram.");
          } else {
            console.warn("Échec sendPhoto Telegram :", photoJson.description);
          }
        } catch (photoErr) {
          console.warn("Exception sendPhoto Telegram :", photoErr);
        }
      }

      // Si pas de photo ou si échec de l'envoi photo, message texte avec lien direct
      if (!sentPhotoSuccess) {
        const tgText = `🚨 *ALERTE DÉCONNEXION WHATSAPP*\n\n` +
          `⚠️ *Statut :* \`${opts.stateInstance}\`\n` +
          `📱 *Instance :* \`${opts.instanceId}\`\n` +
          `🕒 *Heure :* ${dateFormatted}\n\n` +
          `📲 [Cliquez ici pour ouvrir le QR Code en direct](${qrViewUrl})`;

        await fetch(`https://api.telegram.org/bot${opts.telegramBotToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: opts.telegramChatId,
            text: tgText,
            parse_mode: "Markdown"
          })
        });
        console.log("Message texte Telegram transmis avec succès.");
      }
    } catch (tgErr) {
      console.error("Échec alerte Telegram :", tgErr);
    }
  }

  // Canal 3 : Alerte Email (Brevo ou Resend)
  const emailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px;">
      <div style="text-align: center; margin-bottom: 20px;">
        <span style="font-size: 40px;">🚨</span>
        <h2 style="color: #dc2626; margin: 8px 0 4px 0;">Alerte Déconnexion WhatsApp (Green API)</h2>
        <p style="color: #64748b; font-size: 13px; margin: 0;">Système de Surveillance • Rotation Urgences CHUL</p>
      </div>

      <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 16px; margin-bottom: 20px;">
        <p style="margin: 0 0 8px 0; color: #991b1b; font-weight: bold; font-size: 14px;">⚠️ L'instance WhatsApp s'est déconnectée !</p>
        <ul style="margin: 0; padding-left: 20px; color: #7f1d1d; font-size: 13px; line-height: 1.6;">
          <li><strong>Statut détecté :</strong> <span style="background: #fee2e2; padding: 2px 6px; border-radius: 4px; font-family: monospace;">${opts.stateInstance}</span></li>
          <li><strong>Instance ID :</strong> ${opts.instanceId}</li>
          <li><strong>Heure de coupure :</strong> ${dateFormatted} (Heure locale)</li>
        </ul>
      </div>

      ${opts.qrCodeData ? `
        <div style="text-align: center; padding: 20px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; margin-bottom: 20px;">
          <p style="color: #0f172a; font-weight: bold; font-size: 14px; margin: 0 0 12px 0;">Scannez directement le QR Code ci-dessous :</p>
          <img src="${opts.qrCodeData.startsWith('data:') ? opts.qrCodeData : `data:image/png;base64,${opts.qrCodeData}`}" alt="QR Code WhatsApp" style="width: 240px; height: 240px; border-radius: 8px; border: 1px solid #cbd5e1;" />
          <p style="color: #64748b; font-size: 11px; margin-top: 8px;">Ouvrez WhatsApp sur votre téléphone > Appareils connectés > Connecter un appareil</p>
        </div>
      ` : `
        <div style="text-align: center; margin-bottom: 20px;">
          <a href="${qrViewUrl}" style="display: inline-block; background: #2563eb; color: #ffffff; font-weight: bold; padding: 12px 24px; border-radius: 10px; text-decoration: none; font-size: 14px;">
            📲 Ouvrir la page de reconnexion (QR Code)
          </a>
        </div>
      `}

      <div style="text-align: center; border-top: 1px solid #f1f5f9; padding-top: 16px;">
        <a href="${qrViewUrl}" style="color: #2563eb; font-size: 12px; font-weight: 600; text-decoration: underline;">
          Lien direct vers la page de scan QR Code
        </a>
      </div>
    </div>
  `;

  if (opts.brevoApiKey && opts.adminEmail) {
    try {
      await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": opts.brevoApiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sender: { name: "Rotation Urgences Alertes", email: "alertes@rotation-urgences.com" },
          to: [{ email: opts.adminEmail }],
          subject: `🚨 URGENT : Déconnexion WhatsApp (${opts.stateInstance}) - QR Code à rescanner`,
          htmlContent: emailHtml
        })
      });
      console.log(`Email d'alerte Brevo envoyé avec succès à ${opts.adminEmail}`);
    } catch (e) {
      console.error("Échec email Brevo :", e);
    }
  } else if (opts.resendApiKey && opts.adminEmail) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${opts.resendApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "Rotation Urgences Alertes <onboarding@resend.dev>",
          to: [opts.adminEmail],
          subject: `🚨 URGENT : Déconnexion WhatsApp (${opts.stateInstance}) - QR Code à rescanner`,
          html: emailHtml
        })
      });
      console.log(`Email d'alerte Resend envoyé avec succès à ${opts.adminEmail}`);
    } catch (e) {
      console.error("Échec de l'envoi de l'email d'alerte Resend :", e);
    }
  }

  // Canal 4 : Webhook externe (Slack, Discord, Backend tiers)
  if (opts.alertWebhookUrl) {
    try {
      const isDiscord = opts.alertWebhookUrl.includes("discord.com");
      const isSlack = opts.alertWebhookUrl.includes("slack.com");
      let bodyPayload: string;

      if (isDiscord) {
        bodyPayload = JSON.stringify({
          content: `🚨 **ALERTE DÉCONNEXION WHATSAPP (Green API)**\n- **Statut** : \`${opts.stateInstance}\`\n- **Instance** : \`${opts.instanceId}\`\n- **Heure** : ${dateFormatted}\n\n📲 **Scanner le QR Code pour reconnecter :**\n${qrViewUrl}`
        });
      } else if (isSlack) {
        bodyPayload = JSON.stringify({
          text: `🚨 *ALERTE DÉCONNEXION WHATSAPP (Green API)*\n• Statut : \`${opts.stateInstance}\`\n• Instance : ${opts.instanceId}\n• Heure : ${dateFormatted}\n• Scanner le QR Code : <${qrViewUrl}|Ouvrir le QR Code>`
        });
      } else {
        bodyPayload = JSON.stringify({
          event: "whatsapp_disconnected",
          stateInstance: opts.stateInstance,
          instanceId: opts.instanceId,
          timestamp: opts.timeIso,
          qrViewUrl
        });
      }

      await fetch(opts.alertWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyPayload
      });
      console.log("Alerte webhook externe transmise avec succès.");
    } catch (e) {
      console.error("Échec alerte webhook externe :", e);
    }
  }
}
