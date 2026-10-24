/**
 * Supabase Edge Function : daily-whatsapp-schedule
 * ==============================================================================
 * Diffusion automatique quotidienne du planning de rotation des urgences CHUL
 * sur un groupe WhatsApp via Groq AI & passerelle WhatsApp (Green API / Evolution API).
 *
 * Déclenchée automatiquement chaque matin par pg_cron (ou appel webhook).
 * ==============================================================================
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";

const ROOMS = [
  {
    id: 0,
    code: "triage",
    name: "Triage",
    emoji: "🔵",
    role: "Accueil, évaluation clinique et orientation immédiate des urgences (constantes, tri)"
  },
  {
    id: 1,
    code: "piquage",
    name: "Piquage",
    emoji: "🟢",
    role: "Voies veineuses périphériques, bilans d’urgence, soins infirmiers et ECG"
  },
  {
    id: 2,
    code: "dechoc",
    name: "Déchocage",
    emoji: "🔴",
    role: "Prise en charge des détresses vitales et urgences absolues (SAUV, réanimation)"
  },
  {
    id: 3,
    code: "observation",
    name: "Observation",
    emoji: "🟣",
    role: "Surveillance clinique rapprochée, attente de résultats ou d'hospitalisation (UHCD)"
  }
];

const DAYS_FR = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const MONTHS_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre"
];

const GROUP_NAMES = ["Groupe A", "Groupe B", "Groupe C", "Groupe D"];

serve(async (req: Request) => {
  // Gestion CORS pour les tests depuis le navigateur
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
      }
    });
  }

  try {
    // 1. Paramètres optionnels du body (pour tester manuellement une date ou faire une prévisualisation)
    let bodyParams: { date?: string; previewOnly?: boolean; forceWeekend?: boolean } = {};
    if (req.method === "POST") {
      try {
        bodyParams = await req.json();
      } catch {
        bodyParams = {};
      }
    }

    // 2. Initialisation Supabase Client
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Variables SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquantes dans l'environnement.");
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 3. Récupération des stagiaires depuis Supabase
    const { data: stagiairesData, error: stagiairesError } = await supabase
      .from("stagiaires")
      .select("*")
      .order("nom", { ascending: true });

    if (stagiairesError) throw stagiairesError;
    const rawStagiaires = stagiairesData || [];

    // 4. Parsing robuste des stagiaires et extraction des groupes
    const stagiaires = rawStagiaires.map((s: { id: string; nom: string; actif?: boolean; groupe?: string }) => {
      let nom = (s.nom || "").trim();
      let groupe: string | null = null;
      if (s.groupe && ["A", "B", "C", "D"].includes(String(s.groupe).toUpperCase())) {
        groupe = String(s.groupe).toUpperCase();
      }
      while (/\s*\[(?:Groupe\s+)?([A-D])\]\s*$/i.test(nom)) {
        const m = nom.match(/\s*\[(?:Groupe\s+)?([A-D])\]\s*$/i);
        if (m && !groupe) groupe = m[1].toUpperCase();
        nom = nom.replace(/\s*\[(?:Groupe\s+)?([A-D])\]\s*$/i, "").trim();
      }
      return {
        id: s.id,
        nom,
        actif: s.actif !== false,
        groupe
      };
    });

    // 5. Répartition stable des 4 groupes sur la TOTALITÉ des stagiaires
    // (pour que la suspension d'un collègue ne bouleverse jamais le groupe des autres)
    const allStagiaires = [...stagiaires].sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
    const groups: Array<Array<typeof stagiaires[0]>> = [[], [], [], []];
    const groupLetterToIdx: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };

    const autoStagiaires: typeof stagiaires = [];
    allStagiaires.forEach((s) => {
      if (s.groupe && groupLetterToIdx[s.groupe] !== undefined) {
        groups[groupLetterToIdx[s.groupe]].push(s);
      } else {
        autoStagiaires.push(s);
      }
    });

    autoStagiaires.forEach((s) => {
      let minCount = Infinity;
      let targetIdx = 0;
      for (let i = 0; i < 4; i++) {
        if (groups[i].length < minCount) {
          minCount = groups[i].length;
          targetIdx = i;
        }
      }
      groups[targetIdx].push(s);
    });

    // 6. Calcul de la date du jour (Fuseau horaire de Libreville, Gabon : UTC+1)
    let targetDate = new Date();
    if (bodyParams.date) {
      targetDate = new Date(bodyParams.date);
    } else {
      // Décalage pour obtenir l'heure locale de Libreville (UTC+1)
      const nowUtc = new Date();
      targetDate = new Date(nowUtc.getTime() + 1 * 60 * 60 * 1000);
    }

    // Jour de la semaine : 0 = Lundi, ..., 6 = Dimanche
    const jsDay = targetDate.getUTCDay();
    const dayIndex = jsDay === 0 ? 6 : jsDay - 1;
    const isWeekend = bodyParams.forceWeekend || dayIndex === 5 || dayIndex === 6;

    const dayName = DAYS_FR[dayIndex];
    const dayNumber = targetDate.getUTCDate();
    const monthName = MONTHS_FR[targetDate.getUTCMonth()];
    const year = targetDate.getUTCFullYear();
    const formattedDateFr = `${dayName} ${dayNumber} ${monthName} ${year}`;

    // 7. Calcul de la rotation du jour
    // Cycle quotidien invariant chaque semaine : Lundi=0, Mardi=1, Mercredi=2, Jeudi=3, Vendredi=0
    const cycle = dayIndex % 4;
    const roomAssignments = isWeekend
      ? []
      : ROOMS.map((room) => {
          const assignedGroup = ((room.id - cycle) % 4 + 4) % 4;
          const cohort = groups[assignedGroup] || [];
          const activeStudents = cohort.filter((s) => s.actif);
          const absentStudents = cohort.filter((s) => !s.actif);
          return {
            room: room.name,
            emoji: room.emoji,
            role: room.role,
            groupName: GROUP_NAMES[assignedGroup],
            activeStudents: activeStudents.map((s) => s.nom),
            absentStudents: absentStudents.map((s) => s.nom)
          };
        });

    // 8. Génération du message formaté (Groq AI ou Fallback local)
    const scheduleContext = {
      date: formattedDateFr,
      hopital: "Centre Hospitalier Universitaire de Libreville (CHUL)",
      service: "Service des Urgences",
      isWeekend,
      roomAssignments,
      totalActifs: stagiaires.filter((s) => s.actif).length,
      totalAbsents: stagiaires.filter((s) => !s.actif).length
    };

    let whatsappMessage = "";
    const groqApiKey = Deno.env.get("GROQ_API_KEY");

    if (groqApiKey) {
      try {
        whatsappMessage = await generateWithGroq(groqApiKey, scheduleContext);
      } catch (groqErr) {
        console.warn("Erreur Groq API, passage au template de secours :", groqErr);
        whatsappMessage = generateFallbackTemplate(scheduleContext);
      }
    } else {
      console.info("GROQ_API_KEY non définie, utilisation du template de secours natif.");
      whatsappMessage = generateFallbackTemplate(scheduleContext);
    }

    // 9. Envoi WhatsApp (si ce n'est pas une simple prévisualisation)
    let whatsappSendResult: Record<string, unknown> = { status: "preview_only" };
    if (!bodyParams.previewOnly) {
      whatsappSendResult = await sendToWhatsAppGateway(whatsappMessage);
    }

    return new Response(
      JSON.stringify({
        success: true,
        date: formattedDateFr,
        isWeekend,
        message: whatsappMessage,
        whatsappSendResult
      }, null, 2),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  } catch (error) {
    const err = error as Error;
    console.error("Erreur Edge Function daily-whatsapp-schedule :", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: err.message || String(err)
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }
});

// ==============================================================================
// 1. APPEL À L'API GROQ (Formatage intelligent et chaleureux)
// ==============================================================================
async function generateWithGroq(
  apiKey: string,
  ctx: {
    date: string;
    hopital: string;
    service: string;
    isWeekend: boolean;
    roomAssignments: Array<{
      room: string;
      emoji: string;
      role: string;
      groupName: string;
      activeStudents: string[];
      absentStudents: string[];
    }>;
    totalActifs: number;
    totalAbsents: number;
  }
): Promise<string> {
  const prompt = `Tu es le superviseur pédagogique des urgences du ${ctx.hopital}.
Rédige le message officiel WhatsApp du jour pour diffuser l'emploi du temps des étudiants stagiaires.

Données du jour :
- Date : ${ctx.date}
- Est-ce le week-end : ${ctx.isWeekend ? "OUI (Repos général R.A.S)" : "NON (Jour de stage)"}
- Répartition des salles :
${JSON.stringify(ctx.roomAssignments, null, 2)}
- Nombre de stagiaires actifs : ${ctx.totalActifs}

Consignes strictes de mise en page WhatsApp :
1. Utilise la syntaxe WhatsApp : *gras* pour les titres et noms de salles, _italique_ pour les descriptions courtes.
2. Inclus les emojis médicaux adéquats (🏥, 🔵, 🟢, 🔴, 🟣, 🩺, 💉, ✨, ⚪).
3. Mentionne clairement en tête : "${ctx.hopital} • ${ctx.service}".
4. Pour chaque salle : affiche l'emoji, le nom de la salle en gras, les stagiaires en poste sous forme de tirets (• Nom), et une brève ligne de rôle.
5. Si un stagiaire est absent dans une salle, mentionne-le avec discrétion et bienveillance (ex: _(Absent(e) : Nom)_).
6. Si c'est le week-end, annonce chaleureusement le repos de service (⚪ R.A.S - Repos de garde) et la reprise le Lundi matin.
8. Ne rajoute AUCUNE phrase avant ou après le message WhatsApp (pas de "Voici le message", pas de guillemets).
9. RÈGLE STRICTE : N'utilise JAMAIS de tableaux Markdown avec des barres verticales | (très mal affichés sur WhatsApp mobile). Utilise UNIQUEMENT des listes à puces avec des tirets (• Nom).`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [
        {
          role: "system",
          content: "Tu es un assistant hospitalier d'élite expert en communication soignante et médicale pour le CHUL. Tu rédiges des messages WhatsApp parfaitement lisibles sur smartphone sans tableaux pipes."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 900
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API error (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  const text = result.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Réponse Groq vide.");
  return text;
}

// ==============================================================================
// 2. TEMPLATE DE SECOURS (Si Groq est indisponible ou non configuré)
// ==============================================================================
function generateFallbackTemplate(ctx: {
  date: string;
  hopital: string;
  service: string;
  isWeekend: boolean;
  roomAssignments: Array<{
    room: string;
    emoji: string;
    role: string;
    groupName: string;
    activeStudents: string[];
    absentStudents: string[];
  }>;
}): string {
  let msg = `🏥 *${ctx.hopital.toUpperCase()}*\n`;
  msg += `📋 *${ctx.service.toUpperCase()} - PLANNING DU JOUR*\n`;
  msg += `📅 _${ctx.date}_\n\n`;

  if (ctx.isWeekend) {
    msg += `⚪ *WEEK-END • REPOS DE SERVICE (R.A.S)*\n\n`;
    msg += `Aucun étudiant stagiaire n'est de garde le samedi et le dimanche.\n`;
    msg += `💤 Repos bien mérité à tous ! Reprise de la rotation *Lundi matin*.\n\n`;
  } else {
    ctx.roomAssignments.forEach((ra) => {
      msg += `${ra.emoji} *${ra.room.toUpperCase()}* _(${ra.groupName})_ :\n`;
      if (ra.activeStudents.length === 0) {
        msg += `  _(aucun stagiaire actif)_\n`;
      } else {
        ra.activeStudents.forEach((st) => {
          msg += `  • ${st}\n`;
        });
      }
      if (ra.absentStudents.length > 0) {
        msg += `  _Absent(e) : ${ra.absentStudents.join(", ")}_\n`;
      }
      msg += `  ℹ️ _${ra.role}_\n\n`;
    });
    msg += `🩺 *Bonne garde et bon courage à toute l'équipe soignante !*\n`;
  }

  msg += `🔄 _Diffusion automatique • UrgencesRotation CHUL_`;
  return msg;
}

// ==============================================================================
// 3. ENVOI VERS LA PASSERELLE WHATSAPP (Green API / Evolution API / Webhook)
// ==============================================================================
async function sendToWhatsAppGateway(message: string): Promise<Record<string, unknown>> {
  // Option A : Green API (https://green-api.com)
  const greenInstanceId = Deno.env.get("GREEN_API_INSTANCE_ID");
  const greenApiToken = Deno.env.get("GREEN_API_TOKEN");
  const whatsappChatId = Deno.env.get("WHATSAPP_CHAT_ID"); // ex: "120363023456789012@g.us" pour un groupe

  if (greenInstanceId && greenApiToken && whatsappChatId) {
    const url = `https://api.green-api.com/waInstance${greenInstanceId}/sendMessage/${greenApiToken}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: whatsappChatId,
        message: message
      })
    });
    const data = await res.json();
    return { gateway: "Green API", ok: res.ok, response: data };
  }

  // Option B : Evolution API (https://evolution-api.com)
  const evolutionUrl = Deno.env.get("EVOLUTION_API_URL"); // ex: "https://votre-evolution-api.com"
  const evolutionKey = Deno.env.get("EVOLUTION_API_KEY");
  const evolutionInstance = Deno.env.get("EVOLUTION_INSTANCE_NAME"); // ex: "CHUL-URGENCES"

  if (evolutionUrl && evolutionKey && evolutionInstance && whatsappChatId) {
    const cleanUrl = evolutionUrl.replace(/\/+$/, "");
    const url = `${cleanUrl}/message/sendText/${evolutionInstance}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": evolutionKey
      },
      body: JSON.stringify({
        number: whatsappChatId,
        text: message
      })
    });
    const data = await res.json();
    return { gateway: "Evolution API", ok: res.ok, response: data };
  }

  // Option C : Passerelle Webhook générique REST POST
  const genericWebhookUrl = Deno.env.get("WHATSAPP_WEBHOOK_URL");
  if (genericWebhookUrl) {
    const res = await fetch(genericWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: whatsappChatId || "default",
        message: message,
        text: message
      })
    });
    const textResp = await res.text();
    return { gateway: "Generic Webhook", ok: res.ok, response: textResp };
  }

  console.warn("Aucune passerelle WhatsApp configurée (variables Green API, Evolution API ou Webhook manquantes).");
  return {
    gateway: "none",
    warning: "Message généré mais non envoyé car les identifiants WhatsApp ne sont pas configurés dans Supabase Secrets."
  };
}
