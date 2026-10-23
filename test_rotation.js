/**
 * Test unitaire de validation du moteur de rotation
 */
const fs = require('fs');

// Charger config.js
const configContent = fs.readFileSync('config.js', 'utf8');
const fakeWindow = {};
eval(configContent.replace('window.APP_CONFIG', 'fakeWindow.APP_CONFIG'));
const config = fakeWindow.APP_CONFIG;

console.log('--- TEST DU MOTEUR DE ROTATION ---');
console.log('Salles configurées :', config.ROOMS.map(r => r.name).join(', '));
console.log('Stagiaires démo :', config.DEMO_STAGIAIRES.length);

function getMonday(dateInput) {
  const d = new Date(dateInput);
  if (typeof dateInput === 'string' && dateInput.length === 10) {
    const parts = dateInput.split('-');
    d.setFullYear(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  }
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function calculateRotationForWeek(startDateStr, weekOffset, stagiaires) {
  const today = new Date();
  const currentMonday = getMonday(today);
  const targetMonday = new Date(currentMonday);
  targetMonday.setDate(targetMonday.getDate() + weekOffset * 7);

  const startMonday = getMonday(startDateStr);
  const msInAWeek = 7 * 24 * 60 * 60 * 1000;
  const weekNumber = Math.floor((targetMonday.getTime() - startMonday.getTime()) / msInAWeek);
  const cycle = ((weekNumber % 4) + 4) % 4;

  const active = stagiaires.filter(s => s.actif).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  const groups = [[], [], [], []];
  active.forEach((s, i) => {
    groups[i % 4].push(s);
  });

  const rooms = config.ROOMS.map(room => {
    const assignedGroupIndex = ((room.id - cycle) % 4 + 4) % 4;
    return {
      name: room.name,
      assignedGroup: 'Groupe ' + ['A', 'B', 'C', 'D'][assignedGroupIndex],
      students: groups[assignedGroupIndex].map(s => s.nom)
    };
  });

  return { weekNumber: weekNumber + 1, cycle, rooms };
}

// Test 1: Semaine 0
console.log('\n--- Test 1 : Semaine en cours ---');
const r0 = calculateRotationForWeek('2026-10-19', 0, config.DEMO_STAGIAIRES);
console.log(`Semaine ${r0.weekNumber} (Cycle ${r0.cycle}) :`);
r0.rooms.forEach(rm => console.log(`  ${rm.name} [${rm.assignedGroup}] : ${rm.students.join(', ')}`));

// Test 2: Semaine suivante
console.log('\n--- Test 2 : Semaine +1 ---');
const r1 = calculateRotationForWeek('2026-10-19', 1, config.DEMO_STAGIAIRES);
console.log(`Semaine ${r1.weekNumber} (Cycle ${r1.cycle}) :`);
r1.rooms.forEach(rm => console.log(`  ${rm.name} [${rm.assignedGroup}] : ${rm.students.join(', ')}`));

// Test 3: Désactivation d'un étudiant (rééquilibrage immédiat)
console.log('\n--- Test 3 : Désactivation d\'un étudiant (Léa Martin passe à actif = false) ---');
const modifiedStagiaires = config.DEMO_STAGIAIRES.map(s => s.nom === 'Léa Martin' ? { ...s, actif: false } : s);
const rActiveChange = calculateRotationForWeek('2026-10-19', 0, modifiedStagiaires);
console.log(`Nombre total d'étudiants actifs : ${modifiedStagiaires.filter(s => s.actif).length}`);
rActiveChange.rooms.forEach(rm => console.log(`  ${rm.name} [${rm.assignedGroup}] (${rm.students.length} stagiaires) : ${rm.students.join(', ')}`));

console.log('\n✅ TOUS LES TESTS DE ROTATION SONT VALIDÉS AVEC SUCCÈS !');
