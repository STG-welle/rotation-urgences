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
    let bodyParams: { date?: string; previewOnly?: boolean; forceWeekend?: boolean; force?: boolean; source?: string } = {};
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
      const disponibilite = (s.disponibilite === "matin" || s.disponibilite === "apres_midi") ? s.disponibilite : "tous";
      return {
        id: s.id,
        nom,
        actif: s.actif !== false,
        groupe,
        equipe,
        disponibilite
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

    // 6. Calcul de la date du jour (Fuseau horaire de Libreville, Gabon : UTC+1)
    let targetDate = new Date();
    if (bodyParams.date) {
      targetDate = new Date(bodyParams.date);
    } else {
      // Décalage pour obtenir l'heure locale de Libreville (UTC+1)
      const nowUtc = new Date();
      // Buffer de 2 minutes pour sécuriser les déclenchements pg_cron de 23h00 UTC
      targetDate = new Date(nowUtc.getTime() + (1 * 60 + 2) * 60 * 1000);
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

    // 7. Calcul de l'alternance hebdomadaire des créneaux (Matinée vs Après-midi)
    // Référence : Lundi 19 Octobre 2026 (Semaine 0) -> Équipe 1 = Matinée, Équipe 2 = Après-midi
    // Inversion automatique chaque lundi :
    // - Semaine du 26 Octobre (Semaine 1) : Équipe 1 = Après-midi, Équipe 2 = Matinée
    // - Semaine du 02 Novembre (Semaine 2) : Équipe 1 = Matinée, Équipe 2 = Après-midi
    function getUtcMonday(d: Date): Date {
      const date = new Date(d);
      const day = date.getUTCDay();
      const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(date);
      monday.setUTCDate(diff);
      monday.setUTCHours(0, 0, 0, 0);
      return monday;
    }

    const refMonday = new Date(Date.UTC(2026, 9, 19, 0, 0, 0));
    const currentMonday = getUtcMonday(targetDate);
    const diffDays = Math.round((currentMonday.getTime() - refMonday.getTime()) / (24 * 60 * 60 * 1000));
    const weekIndex = Math.floor(diffDays / 7);
    const isEvenWeek = ((weekIndex % 2) + 2) % 2 === 0;

    const team1IsMorning = isEvenWeek;

    // Basculement 100% automatique selon les disponibilités horaires :
    // - 'matin' : Rattaché automatiquement à l'équipe en Matinée cette semaine
    // - 'apres_midi' : Rattaché automatiquement à l'équipe en Après-midi cette semaine
    // - 'tous' : Reste dans son équipe de référence (s.equipe === '2' ? '2' : '1')
    function getEffectiveStudentTeam(s: typeof stagiaires[0], isEven: boolean): string {
      if (s.disponibilite === "matin") return isEven ? "1" : "2";
      if (s.disponibilite === "apres_midi") return isEven ? "2" : "1";
      return s.equipe === "2" ? "2" : "1";
    }

    const team1Members = stagiaires.filter((s) => getEffectiveStudentTeam(s, isEvenWeek) === "1");
    const team2Members = stagiaires.filter((s) => getEffectiveStudentTeam(s, isEvenWeek) === "2");
    const hasTeam2 = team2Members.length > 0;

    const groupsTeam1 = buildCohortGroups(team1Members);
    const groupsTeam2 = hasTeam2 ? buildCohortGroups(team2Members) : [[], [], [], []];

    // 8. Calcul de la rotation avec BRASSAGE DYNAMIQUE QUOTIDIEN DES BINÔMES
    // social golfer / tournoi harmonique 7 jours garantissant 0 répétitions consécutives de salle ou de binôme
    const workDayIndex = weekIndex * 5 + dayIndex;

    const SCHEDULE_7 = [
      [[7, 0], [1, 6], [2, 5], [3, 4]],
      [[4, 5], [2, 0], [3, 6], [7, 1]],
      [[0, 3], [7, 5], [1, 2], [6, 4]],
      [[5, 6], [3, 1], [4, 0], [7, 2]],
      [[4, 2], [6, 0], [7, 3], [5, 1]],
      [[5, 3], [7, 4], [0, 1], [6, 2]],
      [[1, 4], [2, 3], [7, 6], [0, 5]]
    ];

    function gcd(a: number, b: number): number {
      while (b) {
        const t = b;
        b = a % b;
        a = t;
      }
      return a;
    }

    function getDailyRoomAssignments(activeStudents: Array<typeof stagiaires[0]>, wIdx: number) {
      const N = activeStudents.length;
      if (N === 0) return [[], [], [], []];

      if (N === 8) {
        const roundIdx = ((wIdx % 7) + 7) % 7;
        const round = SCHEDULE_7[roundIdx];
        return round.map((pair) => pair.map((idx) => activeStudents[idx]));
      }

      const baseCap = Math.floor(N / 4);
      const remainder = N % 4;
      const roomCaps = [0, 1, 2, 3].map((r) => baseCap + (r < remainder ? 1 : 0));

      let step = 3;
      while (gcd(step, N) !== 1 && step < N) step++;
      if (step >= N) step = 1;

      const offset = ((wIdx * 3) % N + N) % N;
      const perm: Array<typeof stagiaires[0]> = [];
      for (let i = 0; i < N; i++) {
        perm.push(activeStudents[(offset + i * step) % N]);
      }

      const roomShift = ((wIdx % 4) + 4) % 4;
      const shiftedCaps = [0, 1, 2, 3].map((r) => roomCaps[(r - roomShift + 4) % 4]);

      const assignment: Array<Array<typeof stagiaires[0]>> = [[], [], [], []];
      let p = 0;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < shiftedCaps[r]; c++) {
          if (p < N) assignment[r].push(perm[p++]);
        }
      }
      return assignment;
    }

    function buildDynamicAssignments(teamMembers: typeof stagiaires) {
      const activeMembers = teamMembers.filter((s) => s.actif).sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
      const absentMembers = teamMembers.filter((s) => !s.actif).sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
      const roomAssigned = getDailyRoomAssignments(activeMembers, workDayIndex);

      return ROOMS.map((room) => {
        const activeInRoom = roomAssigned[room.id] || [];
        return {
          room: room.name,
          emoji: room.emoji,
          role: room.role,
          activeStudents: activeInRoom.map((s) => s.nom),
          absentStudents: room.id === 0 ? absentMembers.map((s) => s.nom) : []
        };
      });
    }

    const roomAssignmentsTeam1 = isWeekend ? [] : buildDynamicAssignments(team1Members);
    const roomAssignmentsTeam2 = (isWeekend || !hasTeam2) ? [] : buildDynamicAssignments(team2Members);

    const morningTeam = team1IsMorning
      ? { name: "Équipe 1", assignments: roomAssignmentsTeam1, shift: "Matinée", emoji: "☀️" }
      : { name: "Équipe 2", assignments: roomAssignmentsTeam2, shift: "Matinée", emoji: "☀️" };

    const afternoonTeam = team1IsMorning
      ? { name: "Équipe 2", assignments: roomAssignmentsTeam2, shift: "Après-midi", emoji: "🌙" }
      : { name: "Équipe 1", assignments: roomAssignmentsTeam1, shift: "Après-midi", emoji: "🌙" };

    // 9. Génération du message formaté (Groq AI ou Fallback local)
    const scheduleContext = {
      date: formattedDateFr,
      hopital: "Centre Hospitalier Universitaire de Libreville (CHUL)",
      service: "Service des Urgences Pédiatriques",
      isWeekend,
      hasTeam2,
      team1IsMorning,
      morningTeam,
      afternoonTeam,
      roomAssignmentsTeam1,
      roomAssignmentsTeam2,
      totalActifs: stagiaires.filter((s: { actif: boolean }) => s.actif).length,
      totalAbsents: stagiaires.filter((s: { actif: boolean }) => !s.actif).length
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

    // 10. Envoi WhatsApp avec verrou anti-doublon (Idempotence)
    // Empêche formellement qu'un message ne soit envoyé plus d'une fois le même jour
    const dateKey = targetDate.toISOString().split("T")[0]; // Format standard : "YYYY-MM-DD"
    let whatsappSendResult: Record<string, unknown> = { status: "preview_only" };

    if (!bodyParams.previewOnly) {
      // Vérifier si un message a déjà été envoyé aujourd'hui pour cette date (sauf si forcé avec force: true)
      const { data: alreadySentList } = await supabase
        .from("whatsapp_dispatch_history")
        .select("id, sent_at, whatsapp_message_id")
        .eq("dispatch_date", dateKey)
        .order("sent_at", { ascending: false })
        .limit(1);

      const alreadySent = alreadySentList && alreadySentList.length > 0 ? alreadySentList[0] : null;

      if (alreadySent && !bodyParams.force) {
        console.warn(`[ANTI-DOUBLON] Message pour le ${dateKey} DÉJÀ envoyé à ${alreadySent.sent_at} (ID: ${alreadySent.whatsapp_message_id}). Envoi ignoré.`);
        return new Response(
          JSON.stringify({
            success: true,
            skipped: true,
            reason: "already_sent_today",
            date: formattedDateFr,
            alreadySentAt: alreadySent.sent_at,
            previousMessageId: alreadySent.whatsapp_message_id,
            message: whatsappMessage
          }, null, 2),
          {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          }
        );
      }

      // Envoi réel vers la passerelle
      whatsappSendResult = await sendToWhatsAppGateway(whatsappMessage);

      // Enregistrement dans l'historique d'envoi pour verrouiller le jour
      try {
        const msgId = (whatsappSendResult.response as Record<string, unknown>)?.idMessage || null;
        await supabase.from("whatsapp_dispatch_history").insert({
          dispatch_date: dateKey,
          message_text: whatsappMessage,
          whatsapp_message_id: msgId ? String(msgId) : null,
          gateway: String(whatsappSendResult.gateway || "unknown"),
          source: bodyParams.source || "pg_cron_daily"
        });
      } catch (logErr) {
        console.warn("Erreur enregistrement whatsapp_dispatch_history:", logErr);
      }
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
    morningTeam: {
      name: string;
      assignments: Array<{
        room: string;
        emoji: string;
        role: string;
        groupName: string;
        activeStudents: string[];
        absentStudents: string[];
      }>;
      shift: string;
      emoji: string;
    };
    afternoonTeam: {
      name: string;
      assignments: Array<{
        room: string;
        emoji: string;
        role: string;
        groupName: string;
        activeStudents: string[];
        absentStudents: string[];
      }>;
      shift: string;
      emoji: string;
    };
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
    const singleTeam = ctx.morningTeam.name === "Équipe 1" ? ctx.morningTeam : ctx.afternoonTeam;
    prompt = `Tu es le superviseur des urgences du ${ctx.hopital}.
Rédige le message officiel WhatsApp en respectant SCRUPULEUSEMENT ce format minimaliste, aéré et épuré.

Données du jour :
- Date : ${ctx.date}
- Créneau : ${singleTeam.emoji} ${singleTeam.shift.toUpperCase()} • ${singleTeam.name.toUpperCase()}
- Répartition :
${JSON.stringify(singleTeam.assignments, null, 2)}

FORMAT EXACT REQUIS :
🏥 *Centre Hospitalier Universitaire de Libreville (CHUL) • Service des Urgences Pédiatriques*
*Date : ${ctx.date}*

${singleTeam.emoji} *${singleTeam.shift.toUpperCase()} • ${singleTeam.name.toUpperCase()}*

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
6. Ne rajoute AUCUNE phrase d'introduction ni de conclusion, ni de guillemets.
7. Si une salle ne compte aucun stagiaire actif (tableau activeStudents vide), affiche impérativement "• _(aucun stagiaire en poste)_" sous le titre de cette salle. Ne laisse JAMAIS un titre de salle vide.`;
  } else {
    prompt = `Tu es le superviseur des urgences du ${ctx.hopital}.
Rédige le message officiel WhatsApp en respectant SCRUPULEUSEMENT ce format minimaliste, aéré et épuré séparant la MATINÉE et l'APRÈS-MIDI.

Données du jour :
- Date : ${ctx.date}
- Répartition MATINÉE (${ctx.morningTeam.name}) :
${JSON.stringify(ctx.morningTeam.assignments, null, 2)}
- Répartition APRÈS-MIDI (${ctx.afternoonTeam.name}) :
${JSON.stringify(ctx.afternoonTeam.assignments, null, 2)}

FORMAT EXACT REQUIS :
🏥 *Centre Hospitalier Universitaire de Libreville (CHUL) • Service des Urgences Pédiatriques*
*Date : ${ctx.date}*

☀️ *MATINÉE • ${ctx.morningTeam.name.toUpperCase()}*

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
🌙 *APRÈS-MIDI • ${ctx.afternoonTeam.name.toUpperCase()}*

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
5. Sépare la Matinée et l'Après-midi par la ligne "───────────────".
6. Affiche UNIQUEMENT les stagiaires actifs (ceux listés dans activeStudents). Les personnes suspendues ou absentes NE DOIVENT PAS apparaître dans le programme.
7. Ne rajoute AUCUNE phrase d'introduction ni de conclusion, ni de guillemets.
8. Si une salle ne compte aucun stagiaire actif (tableau activeStudents vide), affiche impérativement "• _(aucun stagiaire en poste)_" sous le titre de cette salle. Ne laisse JAMAIS un titre de salle vide.`;
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
  morningTeam: {
    name: string;
    assignments: Array<{
      room: string;
      emoji: string;
      role: string;
      groupName: string;
      activeStudents: string[];
      absentStudents: string[];
    }>;
    shift: string;
    emoji: string;
  };
  afternoonTeam: {
    name: string;
    assignments: Array<{
      room: string;
      emoji: string;
      role: string;
      groupName: string;
      activeStudents: string[];
      absentStudents: string[];
    }>;
    shift: string;
    emoji: string;
  };
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
    const singleTeam = ctx.morningTeam.name === "Équipe 1" ? ctx.morningTeam : ctx.afternoonTeam;
    msg += `${singleTeam.emoji} *${singleTeam.shift.toUpperCase()} • ${singleTeam.name.toUpperCase()}*\n\n`;
    singleTeam.assignments.forEach((ra) => {
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
    msg += `☀️ *MATINÉE • ${ctx.morningTeam.name.toUpperCase()}*\n\n`;
    ctx.morningTeam.assignments.forEach((ra) => {
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
    msg += `🌙 *APRÈS-MIDI • ${ctx.afternoonTeam.name.toUpperCase()}*\n\n`;
    ctx.afternoonTeam.assignments.forEach((ra) => {
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
