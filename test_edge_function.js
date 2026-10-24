/**
 * Script de test local pour la logique de l'Edge Function daily-whatsapp-schedule
 * Exécution : node test_edge_function.js
 */

const SUPABASE_URL = 'https://ezpbmutbkuoudmyyozlr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_U7-ao4uwjTorXXLeCyClBA_ZkytQqmE';

const ROOMS = [
  { id: 0, code: 'triage', name: 'Triage', emoji: '🔵', role: 'Accueil, évaluation clinique et orientation immédiate des urgences (constantes, tri)' },
  { id: 1, code: 'piquage', name: 'Piquage', emoji: '🟢', role: 'Voies veineuses périphériques, bilans d’urgence, soins infirmiers et ECG' },
  { id: 2, code: 'dechoc', name: 'Déchocage', emoji: '🔴', role: 'Prise en charge des détresses vitales et urgences absolues (SAUV, réanimation)' },
  { id: 3, code: 'observation', name: 'Observation', emoji: '🟣', role: 'Surveillance clinique rapprochée, attente de résultats ou d\'hospitalisation (UHCD)' }
];

const DAYS_FR = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const SCHEDULE_7 = [
  [[7, 0], [1, 6], [2, 5], [3, 4]],
  [[4, 5], [2, 0], [3, 6], [7, 1]],
  [[0, 3], [7, 5], [1, 2], [6, 4]],
  [[5, 6], [3, 1], [4, 0], [7, 2]],
  [[4, 2], [6, 0], [7, 3], [5, 1]],
  [[5, 3], [7, 4], [0, 1], [6, 2]],
  [[1, 4], [2, 3], [7, 6], [0, 5]]
];

function gcd(a, b) {
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

function getDailyRoomAssignments(activeStudents, wIdx) {
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
  const perm = [];
  for (let i = 0; i < N; i++) {
    perm.push(activeStudents[(offset + i * step) % N]);
  }

  const roomShift = ((wIdx % 4) + 4) % 4;
  const shiftedCaps = [0, 1, 2, 3].map((r) => roomCaps[(r - roomShift + 4) % 4]);

  const assignment = [[], [], [], []];
  let p = 0;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < shiftedCaps[r]; c++) {
      if (p < N) assignment[r].push(perm[p++]);
    }
  }
  return assignment;
}

async function main() {
  console.log('🔄 Test de récupération des stagiaires depuis Supabase...');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/stagiaires?select=*`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`
    }
  });

  const rawStagiaires = await res.json();
  console.log(`✅ ${rawStagiaires.length} stagiaires récupérés depuis Supabase.`);

  const stagiaires = rawStagiaires.map((s) => {
    let nom = (s.nom || '').trim();
    while (/\s*\[(?:Groupe\s+)?([A-D])\]\s*$/i.test(nom)) {
      nom = nom.replace(/\s*\[(?:Groupe\s+)?([A-D])\]\s*$/i, '').trim();
    }
    const equipe = (s.equipe === '2' || s.equipe === 2) ? '2' : '1';
    return { id: s.id, nom, actif: s.actif !== false, equipe };
  });

  const team1Members = stagiaires.filter((s) => s.equipe === '1');
  const team2Members = stagiaires.filter((s) => s.equipe === '2');
  const hasTeam2 = team2Members.length > 0;

  // Semaine du 26 Octobre 2026 (weekIndex = 1)
  const weekIndex = 1;
  const isEvenWeek = ((weekIndex % 2) + 2) % 2 === 0;
  const team1IsMorning = isEvenWeek;

  console.log('\n--- SIMULATION DES MESSAGES DU LUNDI AU DIMANCHE (BRASSAGE DYNAMIQUE) ---');

  for (let d = 0; d < 7; d++) {
    const isWeekend = d === 5 || d === 6;
    const workDayIndex = weekIndex * 5 + d;

    function buildDynamicAssignments(members) {
      const active = members.filter((s) => s.actif).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
      const absent = members.filter((s) => !s.actif).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
      const roomAssigned = getDailyRoomAssignments(active, workDayIndex);

      return ROOMS.map((room) => {
        const activeInRoom = roomAssigned[room.id] || [];
        return {
          room: room.name,
          emoji: room.emoji,
          role: room.role,
          activeStudents: activeInRoom.map((s) => s.nom),
          absentStudents: room.id === 0 ? absent.map((s) => s.nom) : []
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

    const context = {
      date: `${DAYS_FR[d]} ${26 + d} octobre 2026`,
      hopital: 'Centre Hospitalier Universitaire de Libreville (CHUL)',
      service: 'Service des Urgences Pédiatriques',
      isWeekend,
      hasTeam2,
      morningTeam,
      afternoonTeam
    };

    console.log(`\n================== MESSAGE WHATSAPP (${DAYS_FR[d].toUpperCase()}) ==================`);
    console.log(generateFallbackTemplate(context));
  }
}

function generateFallbackTemplate(ctx) {
  let msg = `🏥 *${ctx.hopital} • ${ctx.service}*\n`;
  msg += `*Date : ${ctx.date}*\n\n`;

  if (ctx.isWeekend) {
    msg += `⚪ *R.A.S - Repos de garde*\n`;
    msg += `_Reprise du service lundi matin._\n\n`;
  } else if (ctx.hasTeam2) {
    msg += `☀️ *${ctx.morningTeam.name} — Créneau : Matinée (07h30 - 14h30)*\n\n`;
    ctx.morningTeam.assignments.forEach((ra) => {
      msg += `${ra.emoji} *${ra.room}*\n`;
      if (ra.activeStudents.length === 0) {
        msg += `• _(aucun stagiaire actif)_\n\n`;
      } else {
        ra.activeStudents.forEach((st) => {
          msg += `• ${st}\n`;
        });
        msg += `\n`;
      }
    });

    msg += `🌙 *${ctx.afternoonTeam.name} — Créneau : Après-midi (14h00 - 20h30)*\n\n`;
    ctx.afternoonTeam.assignments.forEach((ra) => {
      msg += `${ra.emoji} *${ra.room}*\n`;
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
    ctx.morningTeam.assignments.forEach((ra) => {
      msg += `${ra.emoji} *${ra.room}*\n`;
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

main().catch(console.error);
