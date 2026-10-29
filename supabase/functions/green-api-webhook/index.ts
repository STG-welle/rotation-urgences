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
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

// Cooldown anti-spam par chat (5 secondes pour fluidifier les tests interactifs)
const lastBotReplyByChat = new Map<string, number>();
const BOT_COOLDOWN_MS = 5000;

// Contacts autorisés par défaut pour les commandes interactives 'pln' et 'bln'
// Signatures prises en charge : Admin (User), Major et Administrateur de secours
// Modifiable aussi via variable d'environnement Supabase AUTHORIZED_WHATSAPP_NUMBERS
const DEFAULT_AUTHORIZED_SIGNATURES = [
  // 1. Administrateur (Vous) : +241 07 66 61 32 / 24107666132
  "24107666132",
  "07666132",
  "7666132",
  "666132",
  "2417666132",

  // 2. Major des Urgences : +241 66 65 13 14 / 24166651314
  "24166651314",
  "066651314",
  "66651314",
  "651314",

  // 3. Administrateur de secours : 24107102959
  "24107102959",
  "07102959",
  "7102959",
  "102959",
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

  // Endpoint GET / POST universel pour déclencher la capture automatique depuis le site Admin
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

    // E2. Endpoint GET pour tester la génération du texte de bilan (bln)
    if (action === "test_bilan") {
      try {
        const bilanText = await buildBilanMessage(supabase);
        return new Response(JSON.stringify({ success: true, bilan: bilanText }, null, 2), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
    }

    // E3. Endpoint GET pour visualiser/télécharger le PDF officiel de bilan
    if (action === "bilan_pdf") {
      try {
        const { bytes, fileName } = await generateBilanPdf(supabase);
        return new Response(bytes, {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${fileName}"`
          }
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
        const instanceWid = payload.instanceData?.wid || "";
        let senderId = payload.senderData?.sender || "";

        // En outgoingMessageReceived (quand le message est envoyé depuis le téléphone du bot),
        // l'émetteur est le propriétaire de la session WhatsApp.
        if (typeWebhook === "outgoingMessageReceived") {
          senderId = payload.senderData?.sender || instanceWid || "24107666132@c.us";
        } else if (!senderId) {
          senderId = payload.senderData?.chatId || "";
        }

        const senderName = payload.senderData?.senderName || payload.senderData?.senderContactName || "Admin/Major";
        const quotedMessageId = payload.idMessage;

        console.log(`📩 Message WhatsApp (${typeWebhook}) reçu de ${senderName} (${senderId} / chat: ${chatId}) : "${textMessage}"`);

        // Protection anti-boucle : Ignorer les images et les messages émis par le bot
        if (payload.messageData?.typeMessage === "imageMessage") {
          return new Response(JSON.stringify({ success: true, ignored: "imageMessage" }), { headers: CORS_HEADERS });
        }
        const isBotMessage = 
          textMessage.includes("planning des urgences pédiatriques") || 
          textMessage.includes("bonsoir l'équipe") || 
          textMessage.includes("voici de nouveau") || 
          textMessage.includes("bilan d'assiduité") || 
          textMessage.includes("bilan d'émargement") ||
          textMessage.includes("fiche d'émargement de la major");

        // Détection des commandes : "pln" (planning) et "bln" (bilan d'émargement)
        const isPlnTrigger = /(?:^|\s|\/|!|#|\.)(pln|planning)(?:\s|$|[!?.,])/i.test(textMessage);
        const isBlnTrigger = 
          /(?:^|\s|\/|!|#|\.)bln(?:\s|$|[!?.,])/i.test(textMessage) ||
          /^(?:!|\/|#|\.)?bilan(?:\s|$|[!?.,])/i.test(textMessage.trim()) ||
          /(?:bilan\s+(?:du\s+mois|de\s+stage|des\s+stages|des\s+présences|des\s+presences|d'émargement|d'emargement|assiduité|assiduite|actuel|en\s+cours|retard|retards))/i.test(textMessage);

        if (chatId && !isBotMessage && (isPlnTrigger || isBlnTrigger)) {
          // Filtrage des contacts autorisés
          const envSignatures = (Deno.env.get("AUTHORIZED_WHATSAPP_NUMBERS") || "")
            .split(",")
            .map(s => s.trim().replace(/[^0-9]/g, ""))
            .filter(Boolean);

          const authorizedSignatures = envSignatures.length > 0
            ? envSignatures
            : DEFAULT_AUTHORIZED_SIGNATURES;

          const senderDigits = senderId.replace(/[^0-9]/g, "");
          const isAuthorized = authorizedSignatures.some(sig => senderDigits.endsWith(sig) || senderDigits === sig);

          if (!isAuthorized) {
            console.log(`⛔ Demande '${isBlnTrigger ? "bln" : "pln"}' ignorée : ${senderName} (${senderId}) n'est pas dans la liste des contacts autorisés.`);
            return new Response(
              JSON.stringify({ success: true, ignored: "unauthorized_sender", sender: senderId }),
              { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
          }

          // Protection anti-spam par cooldown (5 secondes)
          const now = Date.now();
          const lastSent = lastBotReplyByChat.get(chatId) || 0;
          if (now - lastSent < BOT_COOLDOWN_MS) {
            console.log(`⏳ [COOLDOWN] Demande ignorée dans ${chatId} (${Math.round((now - lastSent) / 1000)}s écoulées sur 5s requises).`);
            return new Response(
              JSON.stringify({ success: true, ignored: "cooldown", chatId }),
              { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
          }
          lastBotReplyByChat.set(chatId, now);

          // CAS 1 : COMMANDE "bln" (Envoi Direct du Document PDF Officiel sans légende texte)
          if (isBlnTrigger) {
            console.log(`🤖 [BOT AUTORISÉ] Commande 'bln' reçue de ${senderName} ! Envoi direct du document PDF...`);
            try {
              const { bytes, fileName } = await generateBilanPdf(supabase);
              const sendUploadUrl = `${greenHost}/waInstance${greenInstanceId}/sendFileByUpload/${greenApiToken}`;
              const blob = new Blob([bytes], { type: "application/pdf" });

              // Tentative 1 : avec quote (sans aucune description textuelle, uniquement le document PDF)
              const formWithQuote = new FormData();
              formWithQuote.append("chatId", chatId);
              formWithQuote.append("fileName", fileName);
              if (quotedMessageId) formWithQuote.append("quotedMessageId", quotedMessageId);
              formWithQuote.append("file", blob, fileName);

              let sendResp = await fetch(sendUploadUrl, {
                method: "POST",
                body: formWithQuote
              });
              let sendResult = await sendResp.json().catch(() => ({}));

              if (!sendResp.ok || sendResult.error) {
                console.warn("Retentative d'envoi PDF sans quote...", sendResult);
                const formNoQuote = new FormData();
                formNoQuote.append("chatId", chatId);
                formNoQuote.append("fileName", fileName);
                formNoQuote.append("file", blob, fileName);

                sendResp = await fetch(sendUploadUrl, {
                  method: "POST",
                  body: formNoQuote
                });
                sendResult = await sendResp.json().catch(() => ({}));
              }

              console.log("✅ Résultat Green API sendFileByUpload (PDF brut) :", JSON.stringify(sendResult));

              return new Response(
                JSON.stringify({
                  success: true,
                  command: "bln",
                  format: "pdf",
                  chatId,
                  idMessage: sendResult.idMessage,
                  urlFile: sendResult.urlFile
                }),
                { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
              );
            } catch (pdfErr) {
              console.error("❌ Erreur génération/envoi PDF, repli texte :", pdfErr);
              const bilanMessage = await buildBilanMessage(supabase);
              const sendMsgUrl = `${greenHost}/waInstance${greenInstanceId}/sendMessage/${greenApiToken}`;
              await fetch(sendMsgUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chatId, message: bilanMessage })
              });
              return new Response(
                JSON.stringify({ success: true, command: "bln", format: "text_fallback" }),
                { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
              );
            }
          }

          // CAS 2 : COMMANDE "pln" (Planning hebdomadaire)
          if (isPlnTrigger) {
            console.log(`🤖 [BOT AUTORISÉ] Commande 'pln' validée pour ${senderName} ! Envoi du planning au chat ${chatId}...`);
            const publicImageUrl = `https://raw.githubusercontent.com/STG-welle/rotation-urgences/main/planning-semaine.png?t=${Date.now()}`;
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
                  command: "pln",
                  chatId,
                  idMessage: sendResult.idMessage
                }),
                { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
              );
            } catch (sendErr) {
              console.error("❌ Erreur expédition image via sendFileByUrl :", sendErr);
            }
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

// ==============================================================================
// 5. GÉNÉRATION DU BILAN D'ASSIDUITÉ & D'ÉMARGEMENT POUR LA COMMANDE "bln"
// ==============================================================================
async function buildBilanMessage(supabase: any): Promise<string> {
  const [stagiairesRes, pointagesRes] = await Promise.all([
    supabase.from("stagiaires").select("*").eq("actif", true).order("nom", { ascending: true }),
    supabase.from("pointages").select("*").order("date", { ascending: true })
  ]);

  const stagiaires = stagiairesRes.data || [];
  const pointages = pointagesRes.data || [];

  if (!pointages || pointages.length === 0) {
    return "🏥 *CHUL • SERVICE DES URGENCES PÉDIATRIQUES*\n📊 *Bilan d'Émargement en cours*\n\nℹ️ _Aucun pointage n'a encore été enregistré pour ce mois._\n\n👉 *Fiche d'émargement de la Major :*\nhttps://stg-welle.github.io/rotation-urgences/pointage.html";
  }

  const sessions = new Set(pointages.map((p: { date: string; creneau: string }) => `${p.date}_${p.creneau}`));

  const stats: Record<string, {
    nom: string;
    present: number;
    absent: number;
    retard: number;
    total: number;
    rooms: Record<string, number>;
  }> = {};

  const nameMapText: Record<string, any> = {};
  stagiaires.forEach((s: { id: string; nom: string }) => {
    const entry = {
      nom: s.nom,
      present: 0,
      absent: 0,
      retard: 0,
      total: 0,
      rooms: { "Triage": 0, "Piquage": 0, "Déchocage": 0, "Observation": 0 }
    };
    stats[s.id] = entry;
    nameMapText[cleanAscii(s.nom).trim().toLowerCase()] = entry;
  });

  pointages.forEach((p: { stagiaire_id: string; stagiaire_nom?: string; statut: string; salle: string }) => {
    const target = stats[p.stagiaire_id] || (p.stagiaire_nom ? nameMapText[cleanAscii(p.stagiaire_nom).trim().toLowerCase()] : null);
    if (target) {
      target.total++;
      if (p.statut === "present") target.present++;
      else if (p.statut === "absent") target.absent++;
      else if (p.statut === "retard") {
        target.retard++;
        target.present++;
      }
      if (p.statut !== "absent" && p.salle) {
        const sClean = cleanAscii(p.salle).trim().toLowerCase();
        if (sClean.includes("tri")) target.rooms["Triage"] = (target.rooms["Triage"] || 0) + 1;
        else if (sClean.includes("piq")) target.rooms["Piquage"] = (target.rooms["Piquage"] || 0) + 1;
        else if (sClean.includes("choc")) target.rooms["Déchocage"] = (target.rooms["Déchocage"] || 0) + 1;
        else if (sClean.includes("obs")) target.rooms["Observation"] = (target.rooms["Observation"] || 0) + 1;
      }
    }
  });

  let totalScheduled = 0;
  let totalAttended = 0;
  let totalRetards = 0;
  let totalAbsents = 0;
  Object.values(stats).forEach((s) => {
    totalScheduled += s.total;
    totalAttended += s.present;
    totalRetards += s.retard;
    totalAbsents += s.absent;
  });

  const globalRate = totalScheduled > 0 ? Math.round((totalAttended / totalScheduled) * 100) : 100;

  let msg = "🏥 *CHUL • URGENCES PÉDIATRIQUES*\n";
  msg += "📊 *Bilan d'Assiduité & Émargement (en cours)*\n\n";
  msg += `📈 *Assiduité globale du service : ${globalRate}%*\n`;
  msg += `📝 *Séances d'émargement enregistrées : ${sessions.size}*\n`;
  msg += `👥 *Stagiaires actifs : ${stagiaires.length}*\n`;
  if (totalRetards > 0 || totalAbsents > 0) {
    msg += `⚠️ *Cumul du mois : ${totalAbsents} absence(s) • ⏱ ${totalRetards} retard(s)*\n`;
  }
  msg += "\n───────────────\n";
  msg += "📋 *SITUATION DES STAGIAIRES :*\n\n";

  const sorted = Object.values(stats).sort((a, b) => a.nom.localeCompare(b.nom, "fr"));

  sorted.forEach((s) => {
    if (s.total === 0) {
      msg += `• *${s.nom}* : _0 séance pointée_\n\n`;
      return;
    }
    const pct = Math.round((s.present / s.total) * 100);
    const badges: string[] = [];
    if (s.absent > 0) badges.push(`⚠️ ${s.absent} abs`);
    if (s.retard > 0) badges.push(`⏱ ${s.retard} retard`);
    if (badges.length === 0) badges.push(`✅ 100%`);
    const badgeStr = badges.join(" • ");

    msg += `• *${s.nom}* : ${s.present}/${s.total} présent (${pct}% • ${badgeStr})\n`;
    const roomDetails: string[] = [];
    if (s.rooms["Triage"] > 0) roomDetails.push(`Tri: ${s.rooms["Triage"]}`);
    if (s.rooms["Piquage"] > 0) roomDetails.push(`Piq: ${s.rooms["Piquage"]}`);
    if (s.rooms["Déchocage"] > 0) roomDetails.push(`Déc: ${s.rooms["Déchocage"]}`);
    if (s.rooms["Observation"] > 0) roomDetails.push(`Obs: ${s.rooms["Observation"]}`);
    if (roomDetails.length > 0) {
      msg += `  ↳ ${roomDetails.join(" | ")}\n`;
    }
    msg += "\n";
  });

  msg += "───────────────\n";
  msg += "🌐 *Fiche d'émargement de la Major :*\n";
  msg += "https://stg-welle.github.io/rotation-urgences/pointage.html\n\n";
  msg += "📄 _Le bilan mensuel officiel est disponible en PDF ci-dessus._";

  return msg;
}

// Nettoyage ASCII pour encodage PDF standard (Helvetica)
function cleanAscii(str: string): string {
  if (!str) return "";
  return str
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// ==============================================================================
// 6. GÉNÉRATION DU DOCUMENT PDF OFFICIEL DU CHUL POUR LA COMMANDE "bln"
// ==============================================================================
async function generateBilanPdf(supabase: any): Promise<{ bytes: Uint8Array; fileName: string; stats: any }> {
  const [stagiairesRes, pointagesRes] = await Promise.all([
    supabase.from("stagiaires").select("*").eq("actif", true).order("nom", { ascending: true }),
    supabase.from("pointages").select("*").order("date", { ascending: true })
  ]);

  const stagiaires = stagiairesRes.data || [];
  const pointages = pointagesRes.data || [];

  const sessions = new Set(pointages.map((p: { date: string; creneau: string }) => `${p.date}_${p.creneau}`));

  const stats: Record<string, {
    nom: string;
    present: number;
    absent: number;
    retard: number;
    total: number;
    rooms: Record<string, number>;
  }> = {};

  const nameMapPdf: Record<string, any> = {};
  stagiaires.forEach((s: { id: string; nom: string }) => {
    const entry = {
      nom: s.nom,
      present: 0,
      absent: 0,
      retard: 0,
      total: 0,
      rooms: { "Triage": 0, "Piquage": 0, "Déchocage": 0, "Observation": 0 }
    };
    stats[s.id] = entry;
    nameMapPdf[cleanAscii(s.nom).trim().toLowerCase()] = entry;
  });

  pointages.forEach((p: { stagiaire_id: string; stagiaire_nom?: string; statut: string; salle: string }) => {
    const target = stats[p.stagiaire_id] || (p.stagiaire_nom ? nameMapPdf[cleanAscii(p.stagiaire_nom).trim().toLowerCase()] : null);
    if (target) {
      target.total++;
      if (p.statut === "present") target.present++;
      else if (p.statut === "absent") target.absent++;
      else if (p.statut === "retard") {
        target.retard++;
        target.present++;
      }
      if (p.statut !== "absent" && p.salle) {
        const sClean = cleanAscii(p.salle).trim().toLowerCase();
        if (sClean.includes("tri")) target.rooms["Triage"] = (target.rooms["Triage"] || 0) + 1;
        else if (sClean.includes("piq")) target.rooms["Piquage"] = (target.rooms["Piquage"] || 0) + 1;
        else if (sClean.includes("choc")) target.rooms["Déchocage"] = (target.rooms["Déchocage"] || 0) + 1;
        else if (sClean.includes("obs")) target.rooms["Observation"] = (target.rooms["Observation"] || 0) + 1;
      }
    }
  });

  let totalScheduled = 0;
  let totalAttended = 0;
  let totalRetards = 0;
  let totalAbsents = 0;
  Object.values(stats).forEach((s) => {
    totalScheduled += s.total;
    totalAttended += s.present;
    totalRetards += s.retard;
    totalAbsents += s.absent;
  });

  const globalRate = totalScheduled > 0 ? Math.round((totalAttended / totalScheduled) * 100) : 100;

  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();

  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontOblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  const cNavy = rgb(0.08, 0.2, 0.38);
  const cBlue = rgb(0.12, 0.42, 0.78);
  const cSlate = rgb(0.39, 0.45, 0.55);
  const cDark = rgb(0.1, 0.13, 0.18);
  const cLightBg = rgb(0.96, 0.97, 0.99);
  const cBorder = rgb(0.85, 0.89, 0.93);
  const cGreen = rgb(0.05, 0.6, 0.38);
  const cRed = rgb(0.85, 0.2, 0.2);
  const cWhite = rgb(1, 1, 1);

  let curY = height - 35;

  // 1. Logo officiel CHUL
  try {
    const logoResp = await fetch("https://raw.githubusercontent.com/STG-welle/rotation-urgences/main/logo-chul.png");
    if (logoResp.ok) {
      const logoBuffer = await logoResp.arrayBuffer();
      const logoImg = await doc.embedPng(new Uint8Array(logoBuffer));
      page.drawImage(logoImg, {
        x: 40,
        y: curY - 50,
        width: 50,
        height: 50
      });
    }
  } catch (logoErr) {
    console.warn("Logo non disponible :", logoErr);
  }

  // En-tete textuel officiel
  page.drawText("REPUBLIQUE GABONAISE • MINISTERE DE LA SANTE", {
    x: 105,
    y: curY - 5,
    size: 7.5,
    font: fontBold,
    color: cSlate
  });

  page.drawText("CENTRE HOSPITALIER UNIVERSITAIRE DE LIBREVILLE (CHUL)", {
    x: 105,
    y: curY - 20,
    size: 11,
    font: fontBold,
    color: cNavy
  });

  page.drawText("DEPARTEMENT DE PEDIATRIE • SERVICE DES URGENCES PEDIATRIQUES", {
    x: 105,
    y: curY - 34,
    size: 8.5,
    font: fontBold,
    color: cBlue
  });

  page.drawText("B.P. 2228 Libreville - Gabon • Direction des Soins Infirmiers", {
    x: 105,
    y: curY - 46,
    size: 7,
    font: fontRegular,
    color: cSlate
  });

  curY -= 62;

  // Ligne de separation
  page.drawLine({
    start: { x: 40, y: curY },
    end: { x: width - 40, y: curY },
    thickness: 1.5,
    color: cNavy
  });

  curY -= 14;

  // 2. Bloc Titre
  const titleBoxHeight = 44;
  page.drawRectangle({
    x: 40,
    y: curY - titleBoxHeight,
    width: width - 80,
    height: titleBoxHeight,
    color: cLightBg,
    borderColor: cBorder,
    borderWidth: 1
  });

  page.drawText("BILAN D'ASSIDUITE & D'EMARGEMENT DES STAGIAIRES", {
    x: 52,
    y: curY - 18,
    size: 12,
    font: fontBold,
    color: cNavy
  });

  const now = new Date();
  const monthsFr = ["Janvier", "Fevrier", "Mars", "Avril", "Mai", "Juin", "Juillet", "Aout", "Septembre", "Octobre", "Novembre", "Decembre"];
  const currentMonthName = monthsFr[now.getMonth()];
  const dateStr = `${now.getDate()} ${currentMonthName} ${now.getFullYear()} a ${String(now.getHours()).padStart(2, '0')}h${String(now.getMinutes()).padStart(2, '0')}`;

  page.drawText(`Rapport officiel valide par la Major • Edition du ${dateStr} (Libreville)`, {
    x: 52,
    y: curY - 33,
    size: 8,
    font: fontOblique,
    color: cSlate
  });

  curY -= (titleBoxHeight + 14);

  // 3. KPI Cards
  const cardWidth = (width - 80 - 18) / 4;
  const cardHeight = 42;

  const kpis = [
    { label: "ASSIDUITE GLOBALE", val: `${globalRate}%`, color: cGreen },
    { label: "SEANCES POINTEES", val: String(sessions.size), color: cNavy },
    { label: "TOTAL ABSENCES", val: String(totalAbsents), color: totalAbsents > 0 ? cRed : cSlate },
    { label: "TOTAL RETARDS", val: String(totalRetards), color: totalRetards > 0 ? rgb(0.85, 0.55, 0.1) : cSlate }
  ];

  kpis.forEach((kpi, idx) => {
    const cardX = 40 + idx * (cardWidth + 6);
    page.drawRectangle({
      x: cardX,
      y: curY - cardHeight,
      width: cardWidth,
      height: cardHeight,
      color: rgb(0.98, 0.99, 1.0),
      borderColor: cBorder,
      borderWidth: 0.8
    });

    page.drawText(kpi.label, {
      x: cardX + 8,
      y: curY - 14,
      size: 6.5,
      font: fontBold,
      color: cSlate
    });

    page.drawText(kpi.val, {
      x: cardX + 8,
      y: curY - 32,
      size: 14,
      font: fontBold,
      color: kpi.color
    });
  });

  curY -= (cardHeight + 18);

  // 4. Tableau d'emargement des stagiaires
  // 4. Tableau d'emargement des stagiaires avec colonnes dediees par service
  const colX = {
    num: 44,
    nom: 64,
    pointages: 182,
    taux: 224,
    abs: 258,
    ret: 284,
    tri: 312,
    piq: 352,
    dec: 394,
    obs: 436,
    statut: 480
  };

  const headerHeight = 22;
  page.drawRectangle({
    x: 40,
    y: curY - headerHeight,
    width: width - 80,
    height: headerHeight,
    color: cNavy
  });

  page.drawText("N°", { x: colX.num, y: curY - 15, size: 7, font: fontBold, color: cWhite });
  page.drawText("NOM DU STAGIAIRE", { x: colX.nom, y: curY - 15, size: 7, font: fontBold, color: cWhite });
  page.drawText("SEANCES", { x: colX.pointages, y: curY - 15, size: 6.5, font: fontBold, color: cWhite });
  page.drawText("TAUX", { x: colX.taux, y: curY - 15, size: 6.5, font: fontBold, color: cWhite });
  page.drawText("ABS", { x: colX.abs, y: curY - 15, size: 6.5, font: fontBold, color: cWhite });
  page.drawText("RET", { x: colX.ret, y: curY - 15, size: 6.5, font: fontBold, color: cWhite });
  page.drawText("TRIAGE", { x: colX.tri, y: curY - 15, size: 6.5, font: fontBold, color: rgb(0.65, 0.88, 1.0) });
  page.drawText("PIQUAGE", { x: colX.piq, y: curY - 15, size: 6.5, font: fontBold, color: rgb(0.65, 1.0, 0.75) });
  page.drawText("DECHOC.", { x: colX.dec, y: curY - 15, size: 6.5, font: fontBold, color: rgb(1.0, 0.7, 0.7) });
  page.drawText("OBSERV.", { x: colX.obs, y: curY - 15, size: 6.5, font: fontBold, color: rgb(0.9, 0.75, 1.0) });
  page.drawText("STATUT", { x: colX.statut, y: curY - 15, size: 7, font: fontBold, color: cWhite });

  curY -= headerHeight;

  const sorted = Object.values(stats).sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
  const rowHeight = 18;

  sorted.forEach((row, i) => {
    const isEven = i % 2 === 0;
    const bgRowColor = isEven ? rgb(0.98, 0.99, 1.0) : cWhite;

    page.drawRectangle({
      x: 40,
      y: curY - rowHeight,
      width: width - 80,
      height: rowHeight,
      color: bgRowColor,
      borderColor: rgb(0.9, 0.92, 0.95),
      borderWidth: 0.5
    });

    const yText = curY - 12;
    page.drawText(String(i + 1), { x: colX.num, y: yText, size: 7.5, font: fontRegular, color: cSlate });
    page.drawText(cleanAscii(row.nom).slice(0, 20), { x: colX.nom, y: yText, size: 7.5, font: fontBold, color: cDark });

    const triCount = row.rooms["Triage"] || 0;
    const piqCount = row.rooms["Piquage"] || 0;
    const decCount = (row.rooms["Déchocage"] || 0) + (row.rooms["Dechocage"] || 0);
    const obsCount = row.rooms["Observation"] || 0;

    if (row.total > 0) {
      const pct = Math.round((row.present / row.total) * 100);
      page.drawText(`${row.present}/${row.total}`, { x: colX.pointages, y: yText, size: 7, font: fontRegular, color: cDark });
      page.drawText(`${pct}%`, { x: colX.taux, y: yText, size: 7, font: fontBold, color: pct >= 80 ? cGreen : cRed });
      page.drawText(String(row.absent), { x: colX.abs, y: yText, size: 7, font: row.absent > 0 ? fontBold : fontRegular, color: row.absent > 0 ? cRed : cSlate });
      page.drawText(String(row.retard), { x: colX.ret, y: yText, size: 7, font: row.retard > 0 ? fontBold : fontRegular, color: row.retard > 0 ? rgb(0.85, 0.55, 0.1) : cSlate });

      // Affichage distinct du nombre de fois dans chaque salle
      page.drawText(triCount > 0 ? String(triCount) : "-", { x: colX.tri + 8, y: yText, size: 7.5, font: triCount > 0 ? fontBold : fontRegular, color: triCount > 0 ? cNavy : cSlate });
      page.drawText(piqCount > 0 ? String(piqCount) : "-", { x: colX.piq + 8, y: yText, size: 7.5, font: piqCount > 0 ? fontBold : fontRegular, color: piqCount > 0 ? cNavy : cSlate });
      page.drawText(decCount > 0 ? String(decCount) : "-", { x: colX.dec + 8, y: yText, size: 7.5, font: decCount > 0 ? fontBold : fontRegular, color: decCount > 0 ? cNavy : cSlate });
      page.drawText(obsCount > 0 ? String(obsCount) : "-", { x: colX.obs + 8, y: yText, size: 7.5, font: obsCount > 0 ? fontBold : fontRegular, color: obsCount > 0 ? cNavy : cSlate });

      page.drawText(row.absent === 0 ? "Conforme" : "A surveiller", {
        x: colX.statut,
        y: yText,
        size: 7,
        font: fontBold,
        color: row.absent === 0 ? cGreen : rgb(0.85, 0.5, 0.1)
      });
    } else {
      page.drawText("0/0", { x: colX.pointages, y: yText, size: 7, font: fontRegular, color: cSlate });
      page.drawText("-", { x: colX.taux, y: yText, size: 7, font: fontRegular, color: cSlate });
      page.drawText("-", { x: colX.abs, y: yText, size: 7, font: fontRegular, color: cSlate });
      page.drawText("-", { x: colX.ret, y: yText, size: 7, font: fontRegular, color: cSlate });
      page.drawText("-", { x: colX.tri + 8, y: yText, size: 7, font: fontRegular, color: cSlate });
      page.drawText("-", { x: colX.piq + 8, y: yText, size: 7, font: fontRegular, color: cSlate });
      page.drawText("-", { x: colX.dec + 8, y: yText, size: 7, font: fontRegular, color: cSlate });
      page.drawText("-", { x: colX.obs + 8, y: yText, size: 7, font: fontRegular, color: cSlate });
      page.drawText("En attente", { x: colX.statut, y: yText, size: 7, font: fontOblique, color: cSlate });
    }

    curY -= rowHeight;
  });

  curY -= 20;

  // 5. Cadres de Visa et Signatures Officielles
  const visaBoxWidth = (width - 80 - 20) / 2;
  const visaBoxHeight = 65;

  // Cadre Major de Service
  page.drawRectangle({
    x: 40,
    y: curY - visaBoxHeight,
    width: visaBoxWidth,
    height: visaBoxHeight,
    color: rgb(0.99, 0.99, 1.0),
    borderColor: cBorder,
    borderWidth: 0.8
  });

  page.drawText("MAJOR DE SERVICE", {
    x: 50,
    y: curY - 18,
    size: 8,
    font: fontBold,
    color: cNavy
  });
  page.drawText("Date & Signature :", {
    x: 50,
    y: curY - 52,
    size: 7.5,
    font: fontBold,
    color: cSlate
  });

  // Cadre Medecin Chef de Service
  const chefX = 40 + visaBoxWidth + 20;
  page.drawRectangle({
    x: chefX,
    y: curY - visaBoxHeight,
    width: visaBoxWidth,
    height: visaBoxHeight,
    color: rgb(0.99, 0.99, 1.0),
    borderColor: cBorder,
    borderWidth: 0.8
  });

  page.drawText("MEDECIN CHEF DE SERVICE", {
    x: chefX + 10,
    y: curY - 18,
    size: 8,
    font: fontBold,
    color: cNavy
  });
  page.drawText("Date & Signature :", {
    x: chefX + 10,
    y: curY - 52,
    size: 7.5,
    font: fontBold,
    color: cSlate
  });

  // 6. Pied de page
  page.drawLine({
    start: { x: 40, y: 35 },
    end: { x: width - 40, y: 35 },
    thickness: 0.5,
    color: cBorder
  });

  page.drawText("Centre Hospitalier Universitaire de Libreville (CHUL) • Service des Urgences Pediatriques", {
    x: 40,
    y: 22,
    size: 7,
    font: fontRegular,
    color: cSlate
  });

  page.drawText("Document securise genere numeriquement • Page 1/1", {
    x: width - 230,
    y: 22,
    size: 7,
    font: fontRegular,
    color: cSlate
  });

  const pdfBytes = await doc.save();
  const fileName = `Bilan_Assiduite_CHUL_${currentMonthName}_${now.getFullYear()}.pdf`;

  return {
    bytes: pdfBytes,
    fileName,
    stats: {
      globalRate,
      stagiairesCount: stagiaires.length,
      totalAbsents,
      totalRetards,
      sessionsCount: sessions.size
    }
  };
}

