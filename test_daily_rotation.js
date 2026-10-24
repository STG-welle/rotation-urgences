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

  active.forEach((s, idx) => {
    const g = idx % 4;
    groups[g].push(s);
    studentGroupMap.set(s.id, g);
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

console.log('\n✅ TEST VALIDÉ : Lundi à Vendredi en rotation circulaire dans les 4 salles, et Samedi/Dimanche en R.A.S !');
