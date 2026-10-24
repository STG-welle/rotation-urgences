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

    // 4. Parsing robuste des stagiaires et extraction des groupes & équipes
    const stagiaires = rawStagiaires.map((s: { id: string; nom: string; actif?: boolean; groupe?: string; equipe?: string }) => {
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
      const equipe = (s.equipe === "2" || s.equipe === 2) ? "2" : "1";
      return {
        id: s.id,
        nom,
        actif: s.actif !== false,
        groupe,
        equipe
      };
    });

    // 5. Répartition stable des 4 groupes par Équipe (Équipe 1 et Équipe 2)
    function buildCohortGroups(teamMembers: typeof stagiaires) {
      const sorted = [...teamMembers].sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
      const groups: Array<Array<typeof stagiaires[0]>> = [[], [], [], []];
      const groupLetterToIdx: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };

      const autoMembers: typeof stagiaires = [];
      sorted.forEach((s) => {
        if (s.groupe && groupLetterToIdx[s.groupe] !== undefined) {
          groups[groupLetterToIdx[s.groupe]].push(s);
        } else {
          autoMembers.push(s);
        }
      });

      autoMembers.forEach((s) => {
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
      return groups;
    }

    const team1Members = stagiaires.filter((s) => s.equipe === "1");
    const team2Members = stagiaires.filter((s) => s.equipe === "2");
    const hasTeam2 = team2Members.length > 0;

    const groupsTeam1 = buildCohortGroups(team1Members);
    const groupsTeam2 = hasTeam2 ? buildCohortGroups(team2Members) : [[], [], [], []];

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

    function buildAssignments(cohortGroups: Array<Array<typeof stagiaires[0]>>) {
      return ROOMS.map((room) => {
        const assignedGroup = ((room.id - cycle) % 4 + 4) % 4;
        const cohort = cohortGroups[assignedGroup] || [];
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
    }

    const roomAssignmentsTeam1 = isWeekend ? [] : buildAssignments(groupsTeam1);
    const roomAssignmentsTeam2 = (isWeekend || !hasTeam2) ? [] : buildAssignments(groupsTeam2);

    // 8. Génération du message formaté (Groq AI ou Fallback local)
    const scheduleContext = {
      date: formattedDateFr,
      hopital: "Centre Hospitalier Universitaire de Libreville (CHUL)",
      service: "Service des Urgences Pédiatriques",
      isWeekend,
      hasTeam2,
      roomAssignments: roomAssignmentsTeam1,
      roomAssignmentsTeam1,
      roomAssignmentsTeam2,
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

    // Ajout systématique du lien vers le site si manquant
    const SITE_URL = "https://stg-welle.github.io/rotation-urgences/";
    if (!whatsappMessage.includes("stg-welle.github.io/rotation-urgences")) {
      whatsappMessage = whatsappMessage.trim() + `\n\n🌐 *Planning complet de la semaine :*\n${SITE_URL}`;
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
// 1. APPEL À L'API GROQ (Formatage minimaliste et épuré)
// ==============================================================================
async function generateWithGroq(
  apiKey: string,
  ctx: {
    date: string;
    hopital: string;
    service: string;
    isWeekend: boolean;
    hasTeam2?: boolean;
    roomAssignmentsTeam1: Array<{
      room: string;
      emoji: string;
      role: string;
      groupName: string;
      activeStudents: string[];
      absentStudents: string[];
    }>;
    roomAssignmentsTeam2?: Array<{
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
  let prompt = "";

  if (ctx.isWeekend) {
    prompt = `Tu es le superviseur des urgences du ${ctx.hopital}.
Rédige le message officiel WhatsApp en respectant SCRUPULEUSEMENT ce format :

🏥 *Centre Hospitalier Universitaire de Libreville (CHUL) • Service des Urgences Pédiatriques*
*Date : ${ctx.date}*

⚪ *R.A.S - Repos de garde*
_Reprise du service lundi matin._

🌐 *Planning complet de la semaine :*
https://stg-welle.github.io/rotation-urgences/`;
  } else if (!ctx.hasTeam2) {
    prompt = `Tu es le superviseur des urgences du ${ctx.hopital}.
Rédige le message officiel WhatsApp en respectant SCRUPULEUSEMENT ce format minimaliste, aéré et épuré.

Données du jour :
- Date : ${ctx.date}
- Répartition :
${JSON.stringify(ctx.roomAssignmentsTeam1, null, 2)}

FORMAT EXACT REQUIS :
🏥 *Centre Hospitalier Universitaire de Libreville (CHUL) • Service des Urgences Pédiatriques*
*Date : ${ctx.date}*

🔵 *Triage*

• Nom1
• Nom2

🟢 *Piquage*

• Nom1
• Nom2

🔴 *Déchocage*

• Nom1
• Nom2

🟣 *Observation*

• Nom1
• Nom2

🌐 *Planning complet de la semaine :*
https://stg-welle.github.io/rotation-urgences/

Consignes strictes :
1. N'ajoute AUCUNE description de rôle sous les salles.
2. Ne mets PAS les lettres de groupe comme "(Groupe A)". Affiche seulement "🔵 *Triage*", "🟢 *Piquage*", "🔴 *Déchocage*", "🟣 *Observation*".
3. Laisse une ligne vide entre le titre de la salle et la liste des noms.
4. Laisse une ligne vide entre chaque bloc de salle.
5. Affiche UNIQUEMENT les stagiaires actifs (ceux listés dans activeStudents). Les personnes suspendues ou absentes NE DOIVENT PAS apparaître dans le programme.
6. Ne rajoute AUCUNE phrase d'introduction ni de conclusion, ni de guillemets.`;
  } else {
    prompt = `Tu es le superviseur des urgences du ${ctx.hopital}.
Rédige le message officiel WhatsApp en respectant SCRUPULEUSEMENT ce format minimaliste, aéré et épuré séparant ÉQUIPE 1 et ÉQUIPE 2.

Données du jour :
- Date : ${ctx.date}
- Répartition Équipe 1 :
${JSON.stringify(ctx.roomAssignmentsTeam1, null, 2)}
- Répartition Équipe 2 :
${JSON.stringify(ctx.roomAssignmentsTeam2, null, 2)}

FORMAT EXACT REQUIS :
🏥 *Centre Hospitalier Universitaire de Libreville (CHUL) • Service des Urgences Pédiatriques*
*Date : ${ctx.date}*

📌 *ÉQUIPE 1*

🔵 *Triage*

• Nom1
• Nom2

🟢 *Piquage*

• Nom1
• Nom2

🔴 *Déchocage*

• Nom1
• Nom2

🟣 *Observation*

• Nom1
• Nom2

───────────────
📌 *ÉQUIPE 2*

🔵 *Triage*

• NomA
• NomB

🟢 *Piquage*

• NomC
• NomD

🔴 *Déchocage*

• NomE
• NomF

🟣 *Observation*

• NomG
• NomH

🌐 *Planning complet de la semaine :*
https://stg-welle.github.io/rotation-urgences/

Consignes strictes :
1. N'ajoute AUCUNE description de rôle sous les salles.
2. Ne mets PAS les lettres de groupe comme "(Groupe A)". Affiche seulement "🔵 *Triage*", "🟢 *Piquage*", "🔴 *Déchocage*", "🟣 *Observation*".
3. Laisse une ligne vide entre le titre de la salle et la liste des noms.
4. Laisse une ligne vide entre chaque bloc de salle.
5. Sépare Équipe 1 et Équipe 2 par la ligne "───────────────".
6. Affiche UNIQUEMENT les stagiaires actifs (ceux listés dans activeStudents). Les personnes suspendues ou absentes NE DOIVENT PAS apparaître dans le programme.
7. Ne rajoute AUCUNE phrase d'introduction ni de conclusion, ni de guillemets.`;
  }

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
          content: "Tu es un assistant hospitalier expert pour le CHUL. Tu formates les plannings WhatsApp de façon minimaliste, aérée et ultra-lisible, sans explications superflues."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 800
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
  hasTeam2?: boolean;
  roomAssignmentsTeam1: Array<{
    room: string;
    emoji: string;
    role: string;
    groupName: string;
    activeStudents: string[];
    absentStudents: string[];
  }>;
  roomAssignmentsTeam2?: Array<{
    room: string;
    emoji: string;
    role: string;
    groupName: string;
    activeStudents: string[];
    absentStudents: string[];
  }>;
}): string {
  let msg = `🏥 *${ctx.hopital} • ${ctx.service}*\n`;
  msg += `*Date : ${ctx.date}*\n\n`;

  if (ctx.isWeekend) {
    msg += `⚪ *R.A.S - Repos de garde*\n`;
    msg += `_Reprise du service lundi matin._\n\n`;
  } else if (!ctx.hasTeam2) {
    ctx.roomAssignmentsTeam1.forEach((ra) => {
      msg += `${ra.emoji} *${ra.room}*\n\n`;
      if (ra.activeStudents.length === 0) {
        msg += `• _(aucun stagiaire actif)_\n\n`;
      } else {
        ra.activeStudents.forEach((st) => {
          msg += `• ${st}\n`;
        });
        msg += `\n`;
      }
    });
  } else {
    msg += `📌 *ÉQUIPE 1*\n\n`;
    ctx.roomAssignmentsTeam1.forEach((ra) => {
      msg += `${ra.emoji} *${ra.room}*\n\n`;
      if (ra.activeStudents.length === 0) {
        msg += `• _(aucun stagiaire actif)_\n\n`;
      } else {
        ra.activeStudents.forEach((st) => {
          msg += `• ${st}\n`;
        });
        msg += `\n`;
      }
    });

    msg += `───────────────\n`;
    msg += `📌 *ÉQUIPE 2*\n\n`;
    (ctx.roomAssignmentsTeam2 || []).forEach((ra) => {
      msg += `${ra.emoji} *${ra.room}*\n\n`;
      if (ra.activeStudents.length === 0) {
        msg += `• _(aucun stagiaire actif)_\n\n`;
      } else {
        ra.activeStudents.forEach((st) => {
          msg += `• ${st}\n`;
        });
        msg += `\n`;
      }
    });
  }

  msg += `🌐 *Planning complet de la semaine :*\nhttps://stg-welle.github.io/rotation-urgences/`;
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
    const greenHost = (Deno.env.get("GREEN_API_HOST") || "https://7107.api.greenapi.com").replace(/\/+$/, "");
    const url = `${greenHost}/waInstance${greenInstanceId}/sendMessage/${greenApiToken}`;
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
