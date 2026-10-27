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
    role: "Soins infirmiers, bilans d’urgence et ECG"
  },
  {
    id: 2,
    code: "dechoc",
    name: "Déchocage",
    emoji: "🔴",
    role: "Prise en charge des détresses vitales et urgences absolues"
  },
  {
    id: 3,
    code: "observation",
    name: "Observation",
    emoji: "🟣",
    role: "Surveillance clinique rapprochée et attente de résultats"
  }
];

const DAYS_FR = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const MONTHS_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre"
];

const GROUP_NAMES = ["Groupe A", "Groupe B", "Groupe C", "Groupe D"];

function mulberry32(a: number) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// 144 séquences canoniques garantissant la visite des 4 salles chaque semaine sans répétition consécutive
const VALID_ROOM_SEQUENCES: number[][] = [];
const SEQS_BY_DUP: number[][][] = [[], [], [], []];
for (let s0 = 0; s0 < 4; s0++) {
  for (let s1 = 0; s1 < 4; s1++) {
    if (s1 === s0) continue;
    for (let s2 = 0; s2 < 4; s2++) {
      if (s2 === s1) continue;
      for (let s3 = 0; s3 < 4; s3++) {
        if (s3 === s2) continue;
        for (let s4 = 0; s4 < 4; s4++) {
          if (s4 === s3) continue;
          if (new Set([s0, s1, s2, s3, s4]).size === 4) {
            const seq = [s0, s1, s2, s3, s4];
            const counts = [0, 0, 0, 0];
            seq.forEach((r) => counts[r]++);
            const dupRoom = counts.findIndex((c) => c === 2);
            VALID_ROOM_SEQUENCES.push(seq);
            SEQS_BY_DUP[dupRoom].push(seq);
          }
        }
      }
    }
  }
}

const weeklyScheduleCache = new Map<string, number[][]>();

function getDeterministicWeeklySchedule(N: number, weekNumber: number): number[][] {
  if (N === 0) return [];
  if (N < 4) {
    const res: number[][] = [];
    for (let i = 0; i < N; i++) {
      res.push([(i + 0) % 4, (i + 1) % 4, (i + 2) % 4, (i + 3) % 4, (i + 1) % 4]);
    }
    return res;
  }

  const cacheKey = `${N}_${weekNumber}`;
  if (weeklyScheduleCache.has(cacheKey)) {
    return weeklyScheduleCache.get(cacheKey)!;
  }

  const minCap = Math.floor(N / 4);
  const maxCap = Math.ceil(N / 4);
  const seed = (Math.abs(weekNumber) * 7919 + N * 104729 + 12345) >>> 0;
  const rand = mulberry32(seed);

  // Rotation mensuelle stricte de la salle doublée :
  // Chaque semaine (w = 0, 1, 2, 3), l'étudiant i double une salle différente (i + w) % 4.
  // Sur 4 semaines (20 jours), chaque étudiant fait EXACTEMENT 5 jours par salle (5 Triage, 5 Piquage, 5 Déchocage, 5 Obs) !
  const targetDups: number[] = [];
  for (let i = 0; i < N; i++) {
    targetDups.push(((i + weekNumber) % 4 + 4) % 4);
  }

  let bestSeqs: number[][] | null = null;
  let bestScore = Infinity;

  for (let trial = 0; trial < 3000; trial++) {
    const chosen: number[][] = [];
    const counts = Array.from({ length: 5 }, () => [0, 0, 0, 0]);
    let possible = true;

    for (let i = 0; i < N; i++) {
      const targetRoom = targetDups[i];
      const pool = SEQS_BY_DUP[targetRoom];

      const cands = [...pool];
      for (let k = cands.length - 1; k > 0; k--) {
        const j = Math.floor(rand() * (k + 1));
        const tmp = cands[k];
        cands[k] = cands[j];
        cands[j] = tmp;
      }

      let picked: number[] | null = null;
      for (const seq of cands) {
        let canAdd = true;
        for (let d = 0; d < 5; d++) {
          if (counts[d][seq[d]] >= maxCap) {
            canAdd = false;
            break;
          }
        }
        if (canAdd) {
          picked = seq;
          break;
        }
      }

      if (!picked) {
        possible = false;
        break;
      }

      chosen.push(picked);
      for (let d = 0; d < 5; d++) counts[d][picked[d]]++;
    }

    if (!possible || chosen.length !== N) continue;

    let valid = true;
    for (let d = 0; d < 5; d++) {
      for (let r = 0; r < 4; r++) {
        if (counts[d][r] < minCap || counts[d][r] > maxCap) {
          valid = false;
          break;
        }
      }
      if (!valid) break;
    }
    if (!valid) continue;

    let pairRepetitions = 0;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        let sameRoom = 0;
        for (let d = 0; d < 5; d++) {
          if (chosen[i][d] === chosen[j][d]) sameRoom++;
        }
        if (sameRoom > 1) pairRepetitions += (sameRoom - 1);
      }
    }

    if (pairRepetitions < bestScore) {
      bestScore = pairRepetitions;
      bestSeqs = chosen;
      if (bestScore === 0) break;
    }
  }

  if (!bestSeqs) {
    bestSeqs = [];
    for (let i = 0; i < N; i++) {
      const d = targetDups[i];
      bestSeqs.push([
        d,
        (d + 1) % 4,
        (d + 2) % 4,
        (d + 3) % 4,
        d
      ]);
    }
  }

  weeklyScheduleCache.set(cacheKey, bestSeqs);
  return bestSeqs;
}

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

    // 3. Récupération des stagiaires et de la configuration depuis Supabase
    const [stagiairesRes, configRes] = await Promise.all([
      supabase.from("stagiaires").select("*").order("nom", { ascending: true }),
      supabase.from("config").select("date_debut_stage").eq("id", 1).maybeSingle()
    ]);

    if (stagiairesRes.error) throw stagiairesRes.error;
    const rawStagiaires = stagiairesRes.data || [];
    const configStartDate = configRes.data?.date_debut_stage || "2026-10-19";

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
      const equipe = (s.equipe === "2" || s.equipe === 2) ? "2" : ((s.equipe === "1" || s.equipe === 1) ? "1" : "auto");
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

    const [refY, refM, refD] = configStartDate.split("-").map((v: string) => parseInt(v, 10));
    const refDateObj = new Date(Date.UTC(refY || 2026, (refM ? refM - 1 : 9), refD || 19, 0, 0, 0));
    const refMonday = getUtcMonday(refDateObj);
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
      if (s.equipe === "2") return "2";
      if (s.equipe === "1") return "1";
      return "1";
    }

    const team1Members = stagiaires.filter((s) => getEffectiveStudentTeam(s, isEvenWeek) === "1");
    const team2Members = stagiaires.filter((s) => getEffectiveStudentTeam(s, isEvenWeek) === "2");
    const hasTeam2 = team2Members.length > 0;

    const groupsTeam1 = buildCohortGroups(team1Members);
    const groupsTeam2 = hasTeam2 ? buildCohortGroups(team2Members) : [[], [], [], []];

    // 8. Calcul de la rotation avec BRASSAGE DYNAMIQUE QUOTIDIEN DES BINÔMES
    // social golfer / tournoi harmonique 7 jours garantissant 0 répétitions consécutives de salle ou de binôme
    const workDayIndex = weekIndex * 5 + dayIndex;

    function getDailyRoomAssignments(activeStudents: Array<typeof stagiaires[0]>, wIdx: number) {
      const N = activeStudents.length;
      if (N === 0) return [[], [], [], []];

      const wNum = Math.floor(wIdx / 5);
      const dIdx = ((wIdx % 5) + 5) % 5;

      const weeklyMatrix = getDeterministicWeeklySchedule(N, wNum);
      const assignment: Array<Array<typeof stagiaires[0]>> = [[], [], [], []];
      for (let i = 0; i < N; i++) {
        const roomIdx = weeklyMatrix[i] ? weeklyMatrix[i][dIdx] : (i % 4);
        assignment[roomIdx].push(activeStudents[i]);
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
      if (!bodyParams.force) {
        // 1. Verrouillage atomique pré-envoi :
        // Grâce à la contrainte UNIQUE sur dispatch_date, cette insertion ne peut réussir
        // qu'UNE SEULE FOIS pour une date donnée. Si deux requêtes arrivent simultanément,
        // la seconde échouera instantanément au niveau du moteur PostgreSQL.
        const { error: lockErr } = await supabase
          .from("whatsapp_dispatch_history")
          .insert({
            dispatch_date: dateKey,
            message_text: "Envoi en cours...",
            source: bodyParams.source || "pg_cron_daily"
          });

        if (lockErr) {
          console.warn(`[ANTI-DOUBLON STRICT] Message pour le ${dateKey} DÉJÀ envoyé ou en cours d'envoi. Envoi bloqué pour éviter tout doublon.`);
          return new Response(
            JSON.stringify({
              success: true,
              skipped: true,
              reason: "already_sent_today",
              date: formattedDateFr,
              dateKey,
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
      }

      // 2. Envoi réel vers la passerelle WhatsApp
      try {
        whatsappSendResult = await sendToWhatsAppGateway(whatsappMessage);
      } catch (sendErr) {
        const errMsg = (sendErr as Error).message || String(sendErr);
        console.error("[ÉCHEC ENVOI WHATSAPP]", errMsg);

        // En cas d'erreur de passerelle ou de déconnexion notAuthorized :
        // Le message est mis en statut "failed_retry" dans Supabase (ni perdu, ni faussement marqué comme envoyé !)
        await supabase
          .from("whatsapp_dispatch_history")
          .upsert({
            dispatch_date: dateKey,
            message_text: whatsappMessage,
            status: "failed_retry",
            error_message: errMsg,
            source: bodyParams.source || "pg_cron_daily",
            sent_at: new Date().toISOString()
          }, { onConflict: "dispatch_date" });

        return new Response(
          JSON.stringify({
            success: false,
            status: "failed_retry",
            error: errMsg,
            reconnectQrUrl: `${supabaseUrl}/functions/v1/green-api-webhook?action=qr`
          }, null, 2),
          {
            status: 503,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          }
        );
      }

      // 3. Finalisation après succès réel
      try {
        const msgId = (whatsappSendResult.response as Record<string, unknown>)?.idMessage || null;
        await supabase
          .from("whatsapp_dispatch_history")
          .upsert({
            dispatch_date: dateKey,
            message_text: whatsappMessage,
            whatsapp_message_id: msgId ? String(msgId) : null,
            gateway: String(whatsappSendResult.gateway || "unknown"),
            source: bodyParams.source || "pg_cron_daily",
            status: "sent",
            error_message: null,
            sent_at: new Date().toISOString()
          }, { onConflict: "dispatch_date" });
      } catch (logErr) {
        console.warn("Erreur finalisation whatsapp_dispatch_history:", logErr);
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

⚪ *R.A.S*
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

☀️ *MATINÉE • ${ctx.morningTeam.name.toUpperCase()}* (07h30 - 12h00)

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
🌙 *APRÈS-MIDI • ${ctx.afternoonTeam.name.toUpperCase()}* (12h00 - 17h00)

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
    msg += `⚪ *R.A.S*\n`;
    msg += `_Reprise du service lundi matin._\n\n`;
  } else if (!ctx.hasTeam2) {
    const singleTeam = ctx.morningTeam.name === "Équipe 1" ? ctx.morningTeam : ctx.afternoonTeam;
    const hours = singleTeam.shift === "Matinée" ? "(07h30 - 12h00)" : "(12h00 - 17h00)";
    msg += `${singleTeam.emoji} *${singleTeam.shift.toUpperCase()} • ${singleTeam.name.toUpperCase()}* ${hours}\n\n`;
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
    msg += `☀️ *MATINÉE • ${ctx.morningTeam.name.toUpperCase()}* (07h30 - 12h00)\n\n`;
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
    msg += `🌙 *APRÈS-MIDI • ${ctx.afternoonTeam.name.toUpperCase()}* (12h00 - 17h00)\n\n`;
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

    // 1. Contrôle pré-vol (Pre-flight check) : Vérification que l'instance est connectée et autorisée
    try {
      const stateUrl = `${greenHost}/waInstance${greenInstanceId}/getStateInstance/${greenApiToken}`;
      const stateRes = await fetch(stateUrl);
      const stateJson = await stateRes.json();
      if (stateJson.stateInstance !== "authorized") {
        throw new Error(`Instance Green API non connectée (statut : ${stateJson.stateInstance || "inconnu"}). Envoi WhatsApp suspendu pour éviter la perte de message.`);
      }
    } catch (stateErr) {
      console.warn("Échec du contrôle pré-vol Green API :", stateErr);
      throw stateErr;
    }

    // 2. Temporisation de sécurité anti-spam (3,5 secondes de pause avant envoi)
    await new Promise((resolve) => setTimeout(resolve, 3500));

    // 3. Envoi du message WhatsApp via Green API
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
    if (!res.ok) {
      throw new Error(`Erreur Green API (HTTP ${res.status}): ${JSON.stringify(data)}`);
    }
    return { gateway: "Green API", ok: true, response: data };
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
