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
const GROUP_NAMES = ['Groupe A', 'Groupe B', 'Groupe C', 'Groupe D'];

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

  // Parsing des stagiaires
  const stagiaires = rawStagiaires.map((s) => {
    let nom = (s.nom || '').trim();
    let groupe = null;
    if (s.groupe && ['A', 'B', 'C', 'D'].includes(String(s.groupe).toUpperCase())) {
      groupe = String(s.groupe).toUpperCase();
    }
    while (/\s*\[(?:Groupe\s+)?([A-D])\]\s*$/i.test(nom)) {
      const m = nom.match(/\s*\[(?:Groupe\s+)?([A-D])\]\s*$/i);
      if (m && !groupe) groupe = m[1].toUpperCase();
      nom = nom.replace(/\s*\[(?:Groupe\s+)?([A-D])\]\s*$/i, '').trim();
    }
    return { id: s.id, nom, actif: s.actif !== false, groupe };
  });

  // Répartition stable
  const allStagiaires = [...stagiaires].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  const groups = [[], [], [], []];
  const groupLetterToIdx = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };
  const auto = [];

  allStagiaires.forEach((s) => {
    if (s.groupe && groupLetterToIdx[s.groupe] !== undefined) {
      groups[groupLetterToIdx[s.groupe]].push(s);
    } else {
      auto.push(s);
    }
  });

  auto.forEach((s) => {
    let minCount = Infinity;
    let target = 0;
    for (let i = 0; i < 4; i++) {
      if (groups[i].length < minCount) {
        minCount = groups[i].length;
        target = i;
      }
    }
    groups[target].push(s);
  });

  // Tester pour chaque jour de la semaine
  console.log('\n--- SIMULATION DES MESSAGES DU LUNDI AU DIMANCHE ---');

  for (let d = 0; d < 7; d++) {
    const isWeekend = d === 5 || d === 6;
    const cycle = d % 4;

    const roomAssignments = isWeekend
      ? []
      : ROOMS.map((room) => {
          const assignedGroup = ((room.id - cycle) % 4 + 4) % 4;
          const cohort = groups[assignedGroup] || [];
          return {
            room: room.name,
            emoji: room.emoji,
            role: room.role,
            groupName: GROUP_NAMES[assignedGroup],
            activeStudents: cohort.filter((s) => s.actif).map((s) => s.nom),
            absentStudents: cohort.filter((s) => !s.actif).map((s) => s.nom)
          };
        });

    const context = {
      date: `${DAYS_FR[d]} 26 octobre 2026`,
      hopital: 'Centre Hospitalier Universitaire de Libreville (CHUL)',
      service: 'Service des Urgences',
      isWeekend,
      roomAssignments
    };

    console.log(`\n================== MESSAGE WHATSAPP (${DAYS_FR[d].toUpperCase()}) ==================`);
    console.log(generateFallbackTemplate(context));
  }
}

function generateFallbackTemplate(ctx) {
  let msg = `🏥 *${ctx.hopital.toUpperCase()}*\n`;
  msg += `📋 *${ctx.service.toUpperCase()} - PLANNING DU JOUR*\n`;
  msg += `📅 _${ctx.date}_\n\n`;

  if (ctx.isWeekend) {
    msg += `⚪ *WEEK-END • REPOS DE SERVICE (R.A.S)*\n\n`;
    msg += `Aucun étudiant stagiaire n'est de garde le samedi et le dimanche.\n`;
    msg += `💤 Repos bien mérité à tous ! Reprise de la rotation *Lundi matin à 00h00*.\n\n`;
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
        msg += `  _Absent(e) : ${ra.absentStudents.join(', ')}_\n`;
      }
      msg += `  ℹ️ _${ra.role}_\n\n`;
    });
    msg += `🩺 *Bonne garde et bon courage à toute l'équipe soignante !*\n`;
  }

  msg += `🔄 _Diffusion automatique • UrgencesRotation CHUL_`;
  return msg;
}

main().catch(console.error);
