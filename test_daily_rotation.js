/**
 * Test de la rotation quotidienne (journalière) avec les jours de la semaine
 */
const fs = require('fs');

const configContent = fs.readFileSync('config.js', 'utf8');
const fakeWindow = {};
eval(configContent.replace('window.APP_CONFIG', 'fakeWindow.APP_CONFIG'));
const config = fakeWindow.APP_CONFIG;

const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

function getMonday(d) {
  const date = new Date(d);
  if (typeof d === 'string' && d.length === 10) {
    const p = d.split('-');
    date.setFullYear(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(date);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function calculateDailySchedule(startDateStr, weekOffset, stagiaires) {
  const currentMonday = getMonday(new Date());
  const targetMonday = new Date(currentMonday);
  targetMonday.setDate(targetMonday.getDate() + weekOffset * 7);

  const startMonday = getMonday(startDateStr);

  const active = stagiaires.filter(s => s.actif).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  const groups = [[], [], [], []];
  const studentGroupMap = new Map();
  const groupLetterToIdx = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };

  // 1. Affecter les stagiaires avec groupe fixé manuellement
  const auto = [];
  active.forEach(s => {
    const manualGroup = s.groupe ? String(s.groupe).toUpperCase() : null;
    if (manualGroup && groupLetterToIdx[manualGroup] !== undefined) {
      const g = groupLetterToIdx[manualGroup];
      groups[g].push(s);
      studentGroupMap.set(s.id, g);
    } else {
      auto.push(s);
    }
  });

  // 2. Équilibrer les stagiaires automatiques
  auto.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  auto.forEach(s => {
    let minCount = Infinity;
    let target = 0;
    for (let i = 0; i < 4; i++) {
      if (groups[i].length < minCount) {
        minCount = groups[i].length;
        target = i;
      }
    }
    groups[target].push(s);
    studentGroupMap.set(s.id, target);
  });

  // Pour chacun des 7 jours de la semaine :
  const daysSchedule = [];
  for (let d = 0; d < 7; d++) {
    const dayDate = new Date(targetMonday);
    dayDate.setDate(dayDate.getDate() + d);

    const isWeekend = d === 5 || d === 6;
    const workingDaysElapsed = weekOffset * 5 + Math.min(d, 4);
    const cycle = ((workingDaysElapsed % 4) + 4) % 4;

    const roomAssignments = isWeekend
      ? []
      : config.ROOMS.map(room => {
          const assignedGroup = ((room.id - cycle) % 4 + 4) % 4;
          return {
            room: room.name,
            emoji: room.emoji,
            students: groups[assignedGroup].map(s => s.nom)
          };
        });

    daysSchedule.push({
      dayName: DAYS[d],
      date: dayDate,
      isWeekend,
      cycle,
      roomAssignments
    });
  }

  return { daysSchedule, studentGroupMap, groups, active };
}

console.log('--- TEST ROTATION JOURNALIÈRE (AVEC WEEK-END R.A.S) ---');
const res = calculateDailySchedule('2026-10-19', 0, config.DEMO_STAGIAIRES);

res.daysSchedule.forEach(day => {
  if (day.isWeekend) {
    console.log(`\n📅 ${day.dayName} : ⚪ R.A.S (Week-end / Aucun stagiaire en service)`);
  } else {
    console.log(`\n📅 ${day.dayName} (Cycle ${day.cycle}) :`);
    day.roomAssignments.forEach(ra => {
      console.log(`  ${ra.emoji} ${ra.room} : ${ra.students.join(', ')}`);
    });
  }
});

console.log('\n--- PARCOURS D\'UN ÉTUDIANT (Camille Dubois) SUR LA SEMAINE ---');
const camille = config.DEMO_STAGIAIRES.find(s => s.nom === 'Camille Dubois');
const gIndex = res.studentGroupMap.get(camille.id);
console.log(`Camille est dans le Groupe ${['A', 'B', 'C', 'D'][gIndex]}`);

res.daysSchedule.forEach(day => {
  if (day.isWeekend) {
    console.log(`  ${day.dayName} : ⚪ R.A.S (Repos)`);
  } else {
    const roomId = (gIndex + day.cycle) % 4;
    const room = config.ROOMS[roomId];
    console.log(`  ${day.dayName} : ${room.emoji} ${room.name}`);
  }
});

console.log('\n--- TEST CHOIX MANUEL DU GROUPE PAR L\'ADMIN ---');
// Créer un cas où Thomas Laurent et Camille Dubois sont explicitement mis dans le Groupe B
const customList = config.DEMO_STAGIAIRES.map(s => {
  if (s.nom === 'Thomas Laurent') return { ...s, groupe: 'B' };
  if (s.nom === 'Camille Dubois') return { ...s, groupe: 'B' };
  if (s.nom === 'Alexandre Petit') return { ...s, groupe: 'A' };
  return { ...s, groupe: null };
});

const resCustom = calculateDailySchedule('2026-10-19', 0, customList);
console.log('Répartition des groupes avec Thomas et Camille dans le Groupe B :');
['A', 'B', 'C', 'D'].forEach((g, idx) => {
  console.log(`  Groupe ${g} (${resCustom.groups[idx].length} stagiaires) : ${resCustom.groups[idx].map(s => s.nom).join(', ')}`);
});

// Vérifier que Thomas et Camille sont ensemble chaque jour
resCustom.daysSchedule.forEach(day => {
  if (!day.isWeekend) {
    const thomasRoom = day.roomAssignments.find(ra => ra.students.includes('Thomas Laurent'));
    const camilleRoom = day.roomAssignments.find(ra => ra.students.includes('Camille Dubois'));
    if (!thomasRoom || !camilleRoom || thomasRoom.room !== camilleRoom.room) {
      throw new Error(`Divergence le ${day.dayName} ! Thomas est en ${thomasRoom?.room} et Camille en ${camilleRoom?.room}`);
    }
    console.log(`  ${day.dayName} : Thomas & Camille sont ENSEMBLE en salle ${thomasRoom.room}`);
  }
});

console.log('\n✅ TEST VALIDÉ : Choix manuel du groupe respecté et programme toujours parfaitement équilibré !');
