/**
 * UrgencesRotation - Planning Quotidien des Stagiaires
 * Rotation journalière (tous les jours de la semaine du Lundi au Dimanche)
 * Grille d'emploi du temps complète & Vue par jour
 */

(function () {
  'use strict';

  // ============================================================================
  // ÉTAT GLOBAL
  // ============================================================================
  const state = {
    supabaseUrl: '',
    supabaseKey: '',
    client: null,
    realtimeChannel: null,
    isSupabaseConnected: false,
    isDemoMode: false,

    // Données
    stagiaires: [],
    config: {
      date_debut_stage: window.APP_CONFIG.DEFAULT_START_DATE,
      pin_code: window.APP_CONFIG.DEFAULT_PIN
    },

    // Navigation & Affichage
    selectedEquipe: '1', // Équipe 1 par défaut ('1' ou '2')
    adminFilterEquipe: '1', // Filtre admin ('1', '2' ou 'all')
    weekOffset: 0,
    simulatedDayOffset: 0, // 0 = temps réel, 1 = simule demain, 2 = après-demain, etc.
    selectedDayIndex: null, // 0 = Lundi, ..., 6 = Dimanche (par défaut = aujourd'hui)
    activeView: localStorage.getItem('urgences_active_view') || (window.innerWidth < 768 ? 'cards' : 'table'),
    searchQuery: '',

    // Administration
    isAdminAuthenticated: false
  };

  const DAYS = [
    { key: 'lun', label: 'Lundi', short: 'LUN', isWeekend: false },
    { key: 'mar', label: 'Mardi', short: 'MAR', isWeekend: false },
    { key: 'mer', label: 'Mercredi', short: 'MER', isWeekend: false },
    { key: 'jeu', label: 'Jeudi', short: 'JEU', isWeekend: false },
    { key: 'ven', label: 'Vendredi', short: 'VEN', isWeekend: false },
    { key: 'sam', label: 'Samedi', short: 'SAM', isWeekend: true },
    { key: 'dim', label: 'Dimanche', short: 'DIM', isWeekend: true }
  ];

  const GROUP_NAMES = ['Groupe A', 'Groupe B', 'Groupe C', 'Groupe D'];

  // ============================================================================
  // INITIALISATION
  // ============================================================================
  document.addEventListener('DOMContentLoaded', async () => {
    loadLocalSettings();
    initCurrentDayIndex();
    initEventListeners();
    await initDatabase();

    // Restaurer recherche sauvegardée
    const savedName = localStorage.getItem('urgences_my_student_name');
    if (savedName) {
      state.searchQuery = savedName;
      const input = document.getElementById('student-search-input');
      if (input) input.value = savedName;
    }

    // Réactualiser automatiquement quand l'étudiant réveille son téléphone le lendemain matin
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        render();
      }
    });

    // Revérifier automatiquement l'heure chaque minute pour franchir minuit en direct
    setInterval(() => {
      render();
    }, 60000);

    render();
  });

  function initCurrentDayIndex() {
    const today = new Date();
    if (state.simulatedDayOffset) {
      today.setDate(today.getDate() + state.simulatedDayOffset);
    }
    const day = today.getDay(); // 0 = Dimanche, 1 = Lundi...
    state.selectedDayIndex = day === 0 ? 6 : day - 1;
  }

  function loadLocalSettings() {
    const storedUrl = localStorage.getItem('urgences_supabase_url');
    const storedKey = localStorage.getItem('urgences_supabase_key');
    const storedPin = localStorage.getItem('urgences_admin_pin');

    state.supabaseUrl = storedUrl || window.APP_CONFIG.SUPABASE_URL || '';
    state.supabaseKey = storedKey || window.APP_CONFIG.SUPABASE_ANON_KEY || '';
    if (storedPin) state.config.pin_code = storedPin;
  }

  async function initDatabase() {
    if (state.supabaseUrl && state.supabaseKey && window.supabase) {
      try {
        state.client = window.supabase.createClient(state.supabaseUrl, state.supabaseKey);

        const [configRes, stagiairesRes] = await Promise.all([
          state.client.from('config').select('*').limit(1).single(),
          state.client.from('stagiaires').select('*').order('nom', { ascending: true })
        ]);

        if (configRes.error && configRes.error.code !== 'PGRST116') throw configRes.error;
        if (stagiairesRes.error) throw stagiairesRes.error;

        if (configRes.data) {
          state.config = {
            date_debut_stage: configRes.data.date_debut_stage || window.APP_CONFIG.DEFAULT_START_DATE,
            pin_code: configRes.data.pin_code || window.APP_CONFIG.DEFAULT_PIN
          };
        }

        state.stagiaires = (stagiairesRes.data || []).map((s) => {
          const parsed = parseStudentNom(s.nom, s.groupe);
          return {
            ...s,
            nom: parsed.nom,
            groupe: parsed.groupe,
            equipe: (s.equipe === '2' || s.equipe === 2) ? '2' : ((s.equipe === '1' || s.equipe === 1) ? '1' : 'auto'),
            disponibilite: (s.disponibilite === 'matin' || s.disponibilite === 'apres_midi') ? s.disponibilite : 'tous'
          };
        });
        applyLocalCustomGroups();

        state.isSupabaseConnected = true;
        state.isDemoMode = false;

        setupRealtimeSubscription();
        return;
      } catch (err) {
        console.warn('Mode hors ligne:', err);
      }
    }

    activateDemoMode();
  }

  function parseStudentNom(rawNom, rawGroupe) {
    let nom = (rawNom || '').trim();
    let groupe = null;

    if (rawGroupe && ['A', 'B', 'C', 'D'].includes(String(rawGroupe).toUpperCase())) {
      groupe = String(rawGroupe).toUpperCase();
    }

    // Extraction et nettoyage complet de tout tag de groupe encodé dans le nom : "[B]", "[Groupe B]", etc.
    while (/\s*\[(?:Groupe\s+)?([A-D])\]\s*$/i.test(nom)) {
      const match = nom.match(/\s*\[(?:Groupe\s+)?([A-D])\]\s*$/i);
      if (match && !groupe) groupe = match[1].toUpperCase();
      nom = nom.replace(/\s*\[(?:Groupe\s+)?([A-D])\]\s*$/i, '').trim();
    }

    return { nom, groupe };
  }

  function getLocalCustomGroups() {
    try {
      const stored = localStorage.getItem('urgences_custom_groups');
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  }

  function saveLocalCustomGroups() {
    const map = {};
    state.stagiaires.forEach((s) => {
      if (s.groupe) map[s.id] = s.groupe;
    });
    localStorage.setItem('urgences_custom_groups', JSON.stringify(map));
  }

  function applyLocalCustomGroups() {
    const map = getLocalCustomGroups();
    state.stagiaires.forEach(async (s) => {
      if (!s.groupe && map[s.id]) {
        s.groupe = map[s.id];
        if (state.client && state.isSupabaseConnected) {
          try {
            await state.client.from('stagiaires').update({ groupe: s.groupe }).eq('id', s.id);
          } catch (e) {
            console.warn('Sync group error:', e);
          }
        }
      }
    });
  }

  function activateDemoMode() {
    state.isSupabaseConnected = false;
    state.isDemoMode = true;

    const localStagiaires = localStorage.getItem('urgences_demo_stagiaires');
    const localStartDate = localStorage.getItem('urgences_demo_start_date');

    if (localStagiaires) {
      try {
        state.stagiaires = JSON.parse(localStagiaires).map((s) => {
          const parsed = parseStudentNom(s.nom, s.groupe);
          return { ...s, nom: parsed.nom, groupe: parsed.groupe, equipe: (s.equipe === '2' || s.equipe === 2) ? '2' : ((s.equipe === '1' || s.equipe === 1) ? '1' : 'auto'), disponibilite: s.disponibilite || 'tous' };
        });
      } catch {
        state.stagiaires = window.APP_CONFIG.DEMO_STAGIAIRES.map((s) => {
          const parsed = parseStudentNom(s.nom, s.groupe);
          return { ...s, nom: parsed.nom, groupe: parsed.groupe, equipe: (s.equipe === '2' || s.equipe === 2) ? '2' : ((s.equipe === '1' || s.equipe === 1) ? '1' : 'auto'), disponibilite: s.disponibilite || 'tous' };
        });
      }
    } else {
      state.stagiaires = window.APP_CONFIG.DEMO_STAGIAIRES.map((s) => {
        const parsed = parseStudentNom(s.nom, s.groupe);
        return { ...s, nom: parsed.nom, groupe: parsed.groupe, equipe: (s.equipe === '2' || s.equipe === 2) ? '2' : ((s.equipe === '1' || s.equipe === 1) ? '1' : 'auto'), disponibilite: s.disponibilite || 'tous' };
      });
      saveDemoStagiaires();
    }

    applyLocalCustomGroups();

    if (localStartDate) state.config.date_debut_stage = localStartDate;
  }

  function saveDemoStagiaires() {
    if (state.isDemoMode) {
      localStorage.setItem('urgences_demo_stagiaires', JSON.stringify(state.stagiaires));
      localStorage.setItem('urgences_demo_start_date', state.config.date_debut_stage);
    }
  }

  function setupRealtimeSubscription() {
    if (!state.client) return;
    if (state.realtimeChannel) state.client.removeChannel(state.realtimeChannel);

    state.realtimeChannel = state.client
      .channel('daily-schedule-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stagiaires' }, (payload) => {
        handleRealtimeChange(payload);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'config' }, (payload) => {
        if (payload.new && payload.new.date_debut_stage) {
          state.config.date_debut_stage = payload.new.date_debut_stage;
          render();
          showToast('Calendrier mis à jour', 'info');
        }
      })
      .subscribe();
  }

  function handleRealtimeChange(payload) {
    const { eventType, new: newRec, old: oldRec } = payload;
    if (eventType === 'INSERT') {
      const parsed = parseStudentNom(newRec.nom, newRec.groupe);
      newRec.nom = parsed.nom;
      newRec.groupe = parsed.groupe;
      newRec.equipe = (newRec.equipe === '2' || newRec.equipe === 2) ? '2' : ((newRec.equipe === '1' || newRec.equipe === 1) ? '1' : 'auto');
      newRec.disponibilite = (newRec.disponibilite === 'matin' || newRec.disponibilite === 'apres_midi') ? newRec.disponibilite : 'tous';
      if (!state.stagiaires.some((s) => s.id === newRec.id)) {
        state.stagiaires.push(newRec);
        state.stagiaires.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
      }
    } else if (eventType === 'UPDATE') {
      const parsed = parseStudentNom(newRec.nom, newRec.groupe);
      newRec.nom = parsed.nom;
      newRec.groupe = parsed.groupe;
      newRec.equipe = (newRec.equipe === '2' || newRec.equipe === 2) ? '2' : ((newRec.equipe === '1' || newRec.equipe === 1) ? '1' : 'auto');
      newRec.disponibilite = (newRec.disponibilite === 'matin' || newRec.disponibilite === 'apres_midi') ? newRec.disponibilite : 'tous';
      const idx = state.stagiaires.findIndex((s) => s.id === newRec.id);
      if (idx !== -1) state.stagiaires[idx] = newRec;
      state.stagiaires.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    } else if (eventType === 'DELETE') {
      state.stagiaires = state.stagiaires.filter((s) => s.id !== oldRec.id);
    }
    applyLocalCustomGroups();
    render();
  }

  // ============================================================================
  // MOTEUR DE ROTATION QUOTIDIENNE (JOUR PAR JOUR)
  // ============================================================================
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

  // Calcul de l'alternance hebdomadaire des créneaux (Matinée vs Après-midi)
  // Référence : Lundi 19 Octobre 2026 (Semaine 0) -> Équipe 1 = Matinée, Équipe 2 = Après-midi
  // Inversion automatique chaque lundi :
  // - Semaine du 26 Octobre (Semaine 1) : Équipe 1 = Après-midi, Équipe 2 = Matinée
  // - Semaine du 02 Novembre (Semaine 2) : Équipe 1 = Matinée, Équipe 2 = Après-midi
  function getWeekShifts(targetMonday) {
    const refMonday = new Date(2026, 9, 19); // Lundi 19 octobre 2026
    refMonday.setHours(0, 0, 0, 0);
    const diffDays = Math.round((targetMonday.getTime() - refMonday.getTime()) / (24 * 60 * 60 * 1000));
    const weekIndex = Math.floor(diffDays / 7);
    const isEvenWeek = ((weekIndex % 2) + 2) % 2 === 0;

    const team1Shift = isEvenWeek ? 'matin' : 'apres_midi';
    const team2Shift = isEvenWeek ? 'apres_midi' : 'matin';

    return {
      weekIndex,
      isEvenWeek,
      team1: {
        shift: team1Shift,
        label: team1Shift === 'matin' ? 'Matinée' : 'Après-midi',
        badgeLabel: team1Shift === 'matin' ? 'Matin' : 'Après-midi',
        emoji: ''
      },
      team2: {
        shift: team2Shift,
        label: team2Shift === 'matin' ? 'Matinée' : 'Après-midi',
        badgeLabel: team2Shift === 'matin' ? 'Matin' : 'Après-midi',
        emoji: ''
      }
    };
  }

  // ============================================================================
  // BASCULEMENT 100% AUTOMATIQUE SELON LES DISPONIBILITÉS HORAIRES
  // - 'matin' : Rattaché automatiquement à l'équipe en Matinée cette semaine-là
  // - 'apres_midi' : Rattaché automatiquement à l'équipe en Après-midi cette semaine-là
  // - 'tous' : Reste dans son équipe de référence (s.equipe || '1')
  // ============================================================================
  function getEffectiveStudentTeam(student, isEvenWeek) {
    if (!student) return '1';
    const dispo = student.disponibilite;
    // Si contrainte horaire stricte, le créneau prime toujours
    if (dispo === 'matin') {
      return isEvenWeek ? '1' : '2';
    }
    if (dispo === 'apres_midi') {
      return isEvenWeek ? '2' : '1';
    }
    // Si l'équipe est explicitement '2'
    if (student.equipe === '2' || student.equipe === 2) {
      return '2';
    }
    if (student.equipe === '1' || student.equipe === 1) {
      return '1';
    }
    // Si equipe === 'auto' et disponibilite === 'tous', affecter par défaut à l'Équipe 1
    return '1';
  }

  // ============================================================================
  // BRASSAGE DYNAMIQUE & COUVERTURE DES 4 SALLES
  // Garanties mathématiques absolues :
  // 1. 100% des stagiaires visitent les 4 SALLES (Triage, Piquage, Déchocage, Obs) chaque semaine
  // 2. ZÉRO répétition consécutive : aucun stagiaire n'est dans la même salle 2 jours de suite
  // 3. Capacités de salles équilibrées chaque jour (Math.floor(N/4) à Math.ceil(N/4))
  // 4. Brassage et rotation des binômes optimisés d'une semaine sur l'autre
  // ============================================================================
  function mulberry32(a) {
    return function() {
      var t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // 144 séquences canoniques individuelles couvrant obligatoirement les 4 salles sans répétition consécutive
  const VALID_ROOM_SEQUENCES = [];
  const SEQS_BY_DUP = [[], [], [], []];
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

  const weeklyScheduleCache = new Map();

  function getDeterministicWeeklySchedule(N, weekNumber) {
    if (N === 0) return [];
    if (N < 4) {
      const res = [];
      for (let i = 0; i < N; i++) {
        res.push([
          (i + 0) % 4,
          (i + 1) % 4,
          (i + 2) % 4,
          (i + 3) % 4,
          (i + 1) % 4
        ]);
      }
      return res;
    }

    const cacheKey = `${N}_${weekNumber}`;
    if (weeklyScheduleCache.has(cacheKey)) {
      return weeklyScheduleCache.get(cacheKey);
    }

    const minCap = Math.floor(N / 4);
    const maxCap = Math.ceil(N / 4);
    const seed = (Math.abs(weekNumber) * 7919 + N * 104729 + 12345) >>> 0;
    const rand = mulberry32(seed);

    // Rotation mensuelle stricte de la salle doublée :
    // Chaque semaine (w = 0, 1, 2, 3), l'étudiant i double une salle différente (i + w) % 4.
    // Sur 4 semaines (20 jours), chaque étudiant fait EXACTEMENT 5 jours par salle (5 Triage, 5 Piquage, 5 Déchocage, 5 Obs) !
    const targetDups = [];
    for (let i = 0; i < N; i++) {
      targetDups.push(((i + weekNumber) % 4 + 4) % 4);
    }

    let bestSeqs = null;
    let bestScore = Infinity;

    for (let trial = 0; trial < 3000; trial++) {
      const chosen = [];
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

        let picked = null;
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

  function getDailyRoomAssignments(activeStudents, workDayIndex) {
    const N = activeStudents.length;
    if (N === 0) return [[], [], [], []];

    const weekNumber = Math.floor(workDayIndex / 5);
    const dayIndex = ((workDayIndex % 5) + 5) % 5;

    const weeklyMatrix = getDeterministicWeeklySchedule(N, weekNumber);
    const assignment = [[], [], [], []];
    for (let i = 0; i < N; i++) {
      const roomIdx = weeklyMatrix[i] ? weeklyMatrix[i][dayIndex] : (i % 4);
      assignment[roomIdx].push(activeStudents[i]);
    }
    return assignment;
  }

  function calculateDailySchedule(offsetWeeks = state.weekOffset, targetEquipe = state.selectedEquipe) {
    const today = new Date();
    if (state.simulatedDayOffset) {
      today.setDate(today.getDate() + state.simulatedDayOffset);
    }
    today.setHours(0, 0, 0, 0);
    const currentMonday = getMonday(today);

    // Lundi de la semaine affichée
    const targetMonday = new Date(currentMonday);
    targetMonday.setDate(targetMonday.getDate() + offsetWeeks * 7);

    const targetSunday = new Date(targetMonday);
    targetSunday.setDate(targetSunday.getDate() + 6);

    const startMonday = getMonday(state.config.date_debut_stage || window.APP_CONFIG.DEFAULT_START_DATE);
    const msInADay = 24 * 60 * 60 * 1000;
    const weekNumber = Math.floor((targetMonday.getTime() - startMonday.getTime()) / (7 * msInADay));

    // Calcul des créneaux de la semaine (Matinée vs Après-midi)
    const weekShifts = getWeekShifts(targetMonday);
    const isEvenWeek = weekShifts.isEvenWeek;

    // Stagiaires de l'équipe ciblée ('1' ou '2')
    // Basculement 100% automatique selon les disponibilités :
    // - Les stagiaires avec 'matin' rejoignent automatiquement l'équipe en Matinée cette semaine
    // - Les stagiaires avec 'apres_midi' rejoignent automatiquement l'équipe en Après-midi cette semaine
    // - Les stagiaires avec 'tous' suivent leur équipe de référence (s.equipe || '1')
    const teamKey = (targetEquipe === '2' || targetEquipe === 2) ? '2' : '1';
    const teamStagiaires = state.stagiaires.filter((s) => getEffectiveStudentTeam(s, isEvenWeek) === teamKey);
    const allStagiaires = [...teamStagiaires].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    const activeStagiaires = allStagiaires.filter((s) => s.actif === true);

    // 4 Groupes stables (A, B, C, D) conservés pour compatibilité et affichage admin
    const groups = [[], [], [], []];
    const studentGroupMap = new Map();
    const groupLetterToIdx = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };

    // 1. D'abord affecter les stagiaires ayant un groupe choisi manuellement par l'admin
    const autoStagiaires = [];
    allStagiaires.forEach((s) => {
      const manualGroup = s.groupe ? String(s.groupe).toUpperCase() : null;
      if (manualGroup && groupLetterToIdx[manualGroup] !== undefined) {
        const gIdx = groupLetterToIdx[manualGroup];
        groups[gIdx].push(s);
        studentGroupMap.set(s.id, gIdx);
      } else {
        autoStagiaires.push(s);
      }
    });

    // 2. Répartir les stagiaires automatiques
    autoStagiaires.forEach((s) => {
      let minCount = Infinity;
      let targetGIdx = 0;
      for (let i = 0; i < 4; i++) {
        if (groups[i].length < minCount) {
          minCount = groups[i].length;
          targetGIdx = i;
        }
      }
      groups[targetGIdx].push(s);
      studentGroupMap.set(s.id, targetGIdx);
    });

    // Calcul pour chacun des 7 jours de la semaine (Lundi à Dimanche)
    const daysData = [];

    for (let d = 0; d < 7; d++) {
      const dayDate = new Date(targetMonday);
      dayDate.setDate(dayDate.getDate() + d);

      const isToday = dayDate.getTime() === today.getTime();
      const isPast = dayDate.getTime() < today.getTime();
      const isWeekend = d === 5 || d === 6; // Samedi = 5, Dimanche = 6

      // Jour ouvré index cumulé depuis le début du stage (Lundi S0 = 0)
      const workDayIndex = weekNumber * 5 + d;
      const cycle = ((workDayIndex % 7) + 7) % 7;

      // Affectation des 4 salles avec brassage quotidien des binômes
      // Uniquement du Lundi au Vendredi, Samedi & Dimanche = R.A.S
      let roomAssignments = [];
      if (!isWeekend) {
        const dailyRoomStudents = getDailyRoomAssignments(activeStagiaires, workDayIndex);
        const absentStudents = allStagiaires.filter((s) => s.actif === false);

        roomAssignments = window.APP_CONFIG.ROOMS.map((room) => {
          const activeInRoom = dailyRoomStudents[room.id] || [];
          return {
            ...room,
            assignedGroup: room.id,
            groupName: 'Binôme du jour',
            students: activeInRoom,
            absentStudents: room.id === 0 ? absentStudents : [],
            cohortStudents: activeInRoom
          };
        });
      }

      daysData.push({
        dayIndex: d,
        dayInfo: DAYS[d],
        date: dayDate,
        dateFormatted: formatDateShort(dayDate),
        isToday,
        isPast,
        isWeekend,
        workDayIndex,
        cycle,
        roomAssignments
      });
    }

    // Fonction pour retrouver la salle d'un étudiant pour un jour donné
    function getStudentRoomOnDay(studentId, dayIndex) {
      if (dayIndex === 5 || dayIndex === 6) {
        return {
          isWeekend: true,
          code: 'ras',
          name: 'R.A.S',
          shortName: 'R.A.S',
          emoji: '',
          badgeClass: 'bg-slate-100 text-slate-600 border-slate-300'
        };
      }
      const dayData = daysData[dayIndex];
      if (!dayData || !dayData.roomAssignments) return null;
      for (const room of dayData.roomAssignments) {
        if (room.students && room.students.some((s) => s.id === studentId)) {
          return room;
        }
      }
      return null;
    }

    // Fonction pour retrouver le ou les binômes d'un étudiant pour un jour donné
    function getStudentPartnersOnDay(studentId, dayIndex) {
      if (dayIndex === 5 || dayIndex === 6) return [];
      const dayData = daysData[dayIndex];
      if (!dayData || !dayData.roomAssignments) return [];
      for (const room of dayData.roomAssignments) {
        if (room.students && room.students.some((s) => s.id === studentId)) {
          return room.students.filter((s) => s.id !== studentId);
        }
      }
      return [];
    }

    const currentTeamShift = (teamKey === '2') ? weekShifts.team2 : weekShifts.team1;

    return {
      equipe: teamKey,
      targetMonday,
      targetSunday,
      weekNumber: weekNumber + 1,
      isCurrentWeek: offsetWeeks === 0,
      shifts: weekShifts,
      currentTeamShift,
      activeCount: activeStagiaires.length,
      inactiveCount: allStagiaires.length - activeStagiaires.length,
      activeStagiaires,
      allStagiaires,
      daysData,
      groups,
      studentGroupMap,
      getStudentRoomOnDay,
      getStudentPartnersOnDay
    };
  }

  // ============================================================================
  // FORMATTAGE & HELPERS
  // ============================================================================
  function formatDateShort(date) {
    return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  function getInitials(name) {
    if (!name) return '??';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function escapeHtml(text) {
    if (!text) return '';
    return String(text).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    const bgColors = {
      success: 'bg-emerald-600 text-white',
      warning: 'bg-amber-600 text-white',
      error: 'bg-rose-600 text-white',
      info: 'bg-slate-900 text-white'
    };

    toast.className = `flex items-center gap-2 px-3.5 py-2.5 rounded-xl shadow-lg font-bold text-xs transition duration-200 ${bgColors[type] || bgColors.info}`;
    toast.textContent = message;

    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  // ============================================================================
  // RENDU DE L'INTERFACE
  // ============================================================================
  function render() {
    const urlParams = new URLSearchParams(window.location.search);
    const isCaptureMode = urlParams.get('mode') === 'capture' || urlParams.get('export') === 'bot';

    if (isCaptureMode) {
      renderCaptureMode();
      return;
    }

    const schedule = calculateDailySchedule(state.weekOffset, state.selectedEquipe);

    renderHeaderStatus();
    renderWeekHeader(schedule);
    renderTeamSwitcher(schedule);
    renderSearchBanner(schedule);
    renderViewSwitcher();
    renderDayView(schedule);
    renderTimetable(schedule);
    renderAdminPanel();
  }

  // ============================================================================
  // MODE CAPTURE ÉCRAN BOT : 2 ÉQUIPES COMBINÉES (?mode=capture)
  // ============================================================================
  function renderCaptureMode() {
    const screenshotZone = document.getElementById('planning-screenshot-zone');
    const interactiveZone = document.getElementById('interactive-app-zone');
    const header = document.querySelector('header');
    const footer = document.querySelector('footer');

    // Cacher les éléments interactifs et les boutons superflus
    if (interactiveZone) interactiveZone.classList.add('hidden');
    if (header) header.classList.add('hidden');
    if (footer) footer.classList.add('hidden');

    if (!screenshotZone) return;
    screenshotZone.classList.remove('hidden');

    // Détermination de la semaine cible pour la capture
    const urlParams = new URLSearchParams(window.location.search);
    let targetOffset = state.weekOffset;

    if (urlParams.get('week') === 'next') {
      targetOffset = 1;
    } else if (urlParams.get('week') === 'current') {
      targetOffset = 0;
    } else if (urlParams.has('week')) {
      const parsed = parseInt(urlParams.get('week'), 10);
      if (!isNaN(parsed)) targetOffset = parsed;
    } else {
      // DÉTECTION INTELLIGENTE DU DIMANCHE (Robot & Envoi WhatsApp) :
      // Le dimanche soir, la semaine de travail est terminée depuis vendredi.
      // Tout planning hebdomadaire diffusé le dimanche prépare obligatoirement la semaine qui démarre demain lundi (+1 semaine) !
      const now = new Date();
      if (state.simulatedDayOffset) now.setDate(now.getDate() + state.simulatedDayOffset);
      if (now.getDay() === 0) {
        targetOffset = 1;
      }
    }

    // Calculer le planning de la semaine cible pour Équipe 1 et Équipe 2
    const s1 = calculateDailySchedule(targetOffset, '1');
    const s2 = calculateDailySchedule(targetOffset, '2');

    const shift1 = s1.currentTeamShift;
    const shift2 = s2.currentTeamShift;

    // Helper pour générer le tableau des 4 salles d'une équipe
    function generateTeamBlock(sched, teamNum, shiftInfo) {
      const activeCount = sched.activeStagiaires.length;
      const isMorning = shiftInfo.shift === 'matin';
      const badgeClass = isMorning
        ? 'bg-amber-100 text-amber-950 border-amber-300'
        : 'bg-indigo-100 text-indigo-950 border-indigo-300';
      const shiftIcon = isMorning
        ? `<svg class="w-4 h-4 text-amber-700 inline shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clip-rule="evenodd"/></svg>`
        : `<svg class="w-4 h-4 text-indigo-700 inline shrink-0" fill="currentColor" viewBox="0 0 20 20"><path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"/></svg>`;

      // En-têtes des 5 jours ouvrés (Lundi à Vendredi)
      let thCols = '';
      for (let d = 0; d < 5; d++) {
        const day = sched.daysData[d];
        thCols += `
          <th class="p-2.5 text-center border border-slate-300 bg-slate-100 text-slate-800 font-bold min-w-[155px]">
            <div class="text-xs uppercase tracking-wider text-slate-700">${day.dayInfo.label}</div>
            <div class="text-[11px] font-semibold text-slate-500">${day.dateFormatted}</div>
          </th>
        `;
      }

      // Configuration des 4 salles
      const roomsConfig = [
        { code: 'SECTEUR 01', name: 'Triage', border: 'border-l-4 border-l-blue-600', dot: 'bg-blue-600', role: 'Accueil & Orientation' },
        { code: 'SECTEUR 02', name: 'Piquage', border: 'border-l-4 border-l-emerald-600', dot: 'bg-emerald-600', role: 'Soins & Bilans' },
        { code: 'SECTEUR 03', name: 'Déchocage', border: 'border-l-4 border-l-rose-600', dot: 'bg-rose-600', role: 'Urgences Absolues' },
        { code: 'SECTEUR 04', name: 'Observation', border: 'border-l-4 border-l-purple-600', dot: 'bg-purple-600', role: 'Surveillance' }
      ];

      let rowsHtml = '';
      for (let r = 0; r < 4; r++) {
        const rc = roomsConfig[r];
        let cellsHtml = '';

        for (let d = 0; d < 5; d++) {
          const roomAssigned = sched.daysData[d].roomAssignments[r];
          const students = roomAssigned?.students || [];

          let pills = '';
          if (students.length === 0) {
            pills = '<span class="text-xs text-slate-400 italic py-1 block text-center">—</span>';
          } else {
            pills = students
              .map((s) => `
                <div class="px-2.5 py-1 rounded-md bg-white border border-slate-300 text-xs font-bold text-slate-900 shadow-2xs flex items-center gap-1.5">
                  <span class="w-1.5 h-1.5 rounded-full ${rc.dot} shrink-0"></span>
                  <span class="truncate">${escapeHtml(s.nom)}</span>
                </div>
              `)
              .join('');
          }

          cellsHtml += `
            <td class="p-2 border border-slate-300 bg-white align-top">
              <div class="flex flex-col gap-1.5">
                ${pills}
              </div>
            </td>
          `;
        }

        rowsHtml += `
          <tr class="border-b border-slate-300">
            <td class="p-3 border border-slate-300 bg-slate-50 font-bold ${rc.border} align-middle">
              <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 leading-none mb-1">${rc.code}</div>
              <div class="text-sm font-black text-slate-900 leading-tight">${rc.name}</div>
              <div class="text-[11px] font-semibold text-slate-500 mt-0.5">${rc.role}</div>
            </td>
            ${cellsHtml}
          </tr>
        `;
      }

      return `
        <div class="bg-white rounded-2xl border-2 border-slate-300 overflow-hidden shadow-xs space-y-0">
          <!-- Bandeau de l'équipe -->
          <div class="p-3.5 bg-slate-50 border-b border-slate-300 flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-3">
              <span class="px-3 py-1 bg-slate-900 text-white text-xs font-black rounded-lg tracking-wider uppercase">
                📋 ÉQUIPE ${teamNum}
              </span>
              <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold border ${badgeClass}">
                ${shiftIcon}
                <span>${shiftInfo.label}</span>
              </div>
            </div>
            <div class="text-xs font-bold text-slate-600">
              Effectif : <span class="text-slate-900 font-black">${activeCount} stagiaire${activeCount > 1 ? 's' : ''} actif${activeCount > 1 ? 's' : ''}</span>
            </div>
          </div>

          <!-- Tableau des 4 salles -->
          <div class="overflow-x-auto">
            <table class="w-full border-collapse border border-slate-300 text-xs">
              <thead>
                <tr>
                  <th class="p-2.5 text-left border border-slate-300 bg-slate-100 text-slate-700 font-bold w-48">
                    Poste / Secteur
                  </th>
                  ${thCols}
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    screenshotZone.innerHTML = `
      <div class="w-full max-w-[1240px] mx-auto bg-white p-6 sm:p-8 rounded-2xl border border-slate-300 shadow-md space-y-6">
        
        <!-- EN-TÊTE PRINCIPAL DE LA CAPTURE -->
        <div class="flex items-center justify-between pb-5 border-b-2 border-slate-200 gap-4">
          <div class="flex items-center gap-4 min-w-0">
            <div class="w-14 h-14 rounded-xl bg-white border border-slate-300 p-1 flex items-center justify-center shadow-xs shrink-0 overflow-hidden">
              <img src="logo-chul.png" alt="Logo CHUL" class="w-full h-full object-contain">
            </div>
            <div class="min-w-0">
              <div class="text-xs font-black uppercase tracking-wider text-blue-700">
                Centre Hospitalier Universitaire de Libreville (CHUL)
              </div>
              <h1 class="text-xl sm:text-2xl font-black text-slate-900 tracking-tight truncate">
                Planning Hebdomadaire • Rotation des Urgences Pédiatriques
              </h1>
              <div class="text-xs text-slate-500 font-semibold">
                Affectation officielle des stagiaires par secteur (Triage • Piquage • Déchocage • Observation)
              </div>
            </div>
          </div>

          <div class="text-right shrink-0">
            <div class="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-900 text-white text-xs sm:text-sm font-black shadow-xs">
              <svg class="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
              </svg>
              <span>Semaine du Lundi ${formatDateShort(s1.targetMonday)} au Dimanche ${formatDateShort(s1.targetSunday)}</span>
            </div>
            <div class="text-[11px] font-semibold text-slate-500 mt-1">
              Alternance hebdomadaire Matin / Après-midi
            </div>
          </div>
        </div>

        <!-- SECTION 1 : ÉQUIPE 1 -->
        ${generateTeamBlock(s1, '1', shift1)}

        <!-- SÉPARATEUR VISUEL PROPRE -->
        <div class="flex items-center gap-4 my-3">
          <div class="flex-1 border-t-2 border-dashed border-slate-300"></div>
          <span class="text-xs font-black text-slate-400 uppercase tracking-widest">• Rotation Clinique Urgences Pédiatriques •</span>
          <div class="flex-1 border-t-2 border-dashed border-slate-300"></div>
        </div>

        <!-- SECTION 2 : ÉQUIPE 2 -->
        ${generateTeamBlock(s2, '2', shift2)}

        <!-- PIED DE CAPTURE OFFICIEL -->
        <div class="pt-4 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500 font-semibold">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-slate-400"></span>
            <span>Samedi & Dimanche : Repos de garde (R.A.S) • Reprise de la rotation lundi à 07h30</span>
          </div>
          <div>
            Application web : <span class="font-bold text-slate-800">https://stg-welle.github.io/rotation-urgences/</span>
          </div>
        </div>

      </div>
    `;

    // Attribut clé pour signaler à Playwright que les données sont complètement chargées
    screenshotZone.setAttribute('data-loaded', 'true');
  }

  function renderTeamSwitcher(schedule) {
    const btn1 = document.getElementById('btn-team-1');
    const btn2 = document.getElementById('btn-team-2');
    const badge1 = document.getElementById('badge-team-1-count');
    const badge2 = document.getElementById('badge-team-2-count');
    const badgeShift1 = document.getElementById('badge-team-1-shift');
    const badgeShift2 = document.getElementById('badge-team-2-shift');
    const shiftSummaryBadge = document.getElementById('shift-summary-badge');
    const teamLabel = document.getElementById('team-student-label');

    const isEven = schedule?.shifts?.isEvenWeek ?? true;
    const count1 = state.stagiaires.filter((s) => getEffectiveStudentTeam(s, isEven) === '1' && s.actif).length;
    const count2 = state.stagiaires.filter((s) => getEffectiveStudentTeam(s, isEven) === '2' && s.actif).length;

    if (badge1) badge1.textContent = count1;
    if (badge2) badge2.textContent = count2;
    if (teamLabel) teamLabel.textContent = `actifs en Équipe ${state.selectedEquipe}`;

    if (schedule?.shifts) {
      const s1 = schedule.shifts.team1;
      const s2 = schedule.shifts.team2;

      if (badgeShift1) {
        badgeShift1.textContent = s1.badgeLabel;
        badgeShift1.className = `px-1.5 py-0.5 rounded-md text-[10px] font-black ${
          s1.shift === 'matin' ? 'bg-amber-400 text-slate-900' : 'bg-indigo-100 text-indigo-900'
        } shadow-2xs`;
      }
      if (badgeShift2) {
        badgeShift2.textContent = s2.badgeLabel;
        badgeShift2.className = `px-1.5 py-0.5 rounded-md text-[10px] font-black ${
          s2.shift === 'matin' ? 'bg-amber-400 text-slate-900' : 'bg-indigo-100 text-indigo-900'
        } shadow-2xs`;
      }
      if (shiftSummaryBadge) {
        shiftSummaryBadge.textContent = `Éq. 1 ${s1.label} • Éq. 2 ${s2.label}`;
      }
    }

    if (btn1 && btn2) {
      if (state.selectedEquipe === '1') {
        btn1.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-2 sm:py-1.5 rounded-md text-xs font-bold transition-all bg-blue-700 text-white shadow-2xs cursor-pointer';
        btn2.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-2 sm:py-1.5 rounded-md text-xs font-bold transition-all text-slate-700 hover:text-slate-900 cursor-pointer';
      } else {
        btn2.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-2 sm:py-1.5 rounded-md text-xs font-bold transition-all bg-blue-700 text-white shadow-2xs cursor-pointer';
        btn1.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-2 sm:py-1.5 rounded-md text-xs font-bold transition-all text-slate-700 hover:text-slate-900 cursor-pointer';
      }
    }
  }

  function renderHeaderStatus() {
    const pill = document.getElementById('status-pill');
    if (!pill) return;
    pill.style.display = 'none';
  }

  function renderWeekHeader(schedule) {
    const title = document.getElementById('week-title');
    const badge = document.getElementById('week-badge');
    const todayBtn = document.getElementById('btn-week-today');

    if (title) {
      const s = formatDateShort(schedule.targetMonday);
      const e = formatDateShort(schedule.targetSunday);
      title.textContent = `Semaine du Lundi ${s} au Dimanche ${e}`;
    }

    if (badge) {
      if (state.simulatedDayOffset !== 0) {
        badge.innerHTML = `<span class="inline-flex items-center gap-1"><svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg> Simulation : +${state.simulatedDayOffset}j</span> <span class="underline ml-1 font-bold">(Retour réel)</span>`;
        badge.className = 'px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold bg-amber-600 text-white shadow-2xs cursor-pointer';
        badge.onclick = () => {
          state.simulatedDayOffset = 0;
          initCurrentDayIndex();
          render();
          showToast('Retour au temps réel', 'info');
        };
      } else if (schedule.isCurrentWeek) {
        badge.onclick = null;
        badge.textContent = `Semaine en cours (S${schedule.weekNumber})`;
        badge.className = 'px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold bg-blue-100 text-blue-900 border border-blue-200';
      } else if (state.weekOffset > 0) {
        badge.onclick = null;
        badge.textContent = `Dans +${state.weekOffset} sem. (S${schedule.weekNumber})`;
        badge.className = 'px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold bg-slate-200 text-slate-800 border border-slate-300';
      } else {
        badge.onclick = null;
        badge.textContent = `Il y a ${Math.abs(state.weekOffset)} sem. (S${schedule.weekNumber})`;
        badge.className = 'px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold bg-slate-100 text-slate-700 border border-slate-200';
      }
    }

    if (todayBtn) {
      if (schedule.isCurrentWeek) {
        todayBtn.classList.add('bg-slate-100', 'text-slate-400');
        todayBtn.classList.remove('bg-white', 'text-slate-900', 'shadow-2xs');
      } else {
        todayBtn.classList.remove('bg-slate-100', 'text-slate-400');
        todayBtn.classList.add('bg-white', 'text-slate-900', 'shadow-2xs');
      }
    }

    const countSpan = document.getElementById('count-active-students');
    if (countSpan) countSpan.textContent = schedule.activeCount;
  }

  // Bandeau informatif personnalisé si recherche active (Format Fiche d'Affectation Clinique)
  function renderSearchBanner(schedule) {
    const banner = document.getElementById('my-assignment-banner');
    const clearBtn = document.getElementById('btn-clear-search');
    if (!banner) return;

    const query = state.searchQuery.trim().toLowerCase();
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', query.length === 0);
    }

    if (query) {
      const found = state.stagiaires.find((s) => s.nom.toLowerCase().includes(query));
      if (!found) {
        banner.classList.remove('hidden');
        banner.innerHTML = `<span class="italic text-slate-500 font-medium">Aucun stagiaire répertorié au tableau de service pour "${escapeHtml(state.searchQuery)}".</span>`;
        return;
      }

      if (!found.actif) {
        banner.classList.remove('hidden');
        banner.innerHTML = `
          <div class="flex items-center gap-2.5">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-200 text-slate-700 uppercase tracking-wider border border-slate-300">Statut : Absent</span>
            <span class="text-slate-700"><strong>${escapeHtml(found.nom)}</strong> est actuellement noté(e) <strong>absent(e) / suspendu(e)</strong> de la rotation clinique.</span>
          </div>
        `;
        return;
      }

      const isEven = schedule?.shifts?.isEvenWeek ?? true;
      const studentEquipe = getEffectiveStudentTeam(found, isEven);
      const studentSchedule = studentEquipe === schedule.equipe ? schedule : calculateDailySchedule(state.weekOffset, studentEquipe);

      const todayIndex = studentSchedule.daysData.findIndex((d) => d.isToday);
      const dayToUse = todayIndex !== -1 ? todayIndex : 0;
      const tomorrowIndex = (dayToUse + 1) % 7;

      let tomorrowSchedule = studentSchedule;
      if (dayToUse === 6) {
        // Le dimanche (index 6), demain est le lundi de la semaine SUIVANTE (+1 semaine)
        const nextMonday = new Date(studentSchedule.targetMonday.getTime() + 7 * 24 * 3600 * 1000);
        const nextWeekShifts = getWeekShifts(nextMonday);
        const nextEquipe = getEffectiveStudentTeam(found, nextWeekShifts.isEvenWeek);
        tomorrowSchedule = calculateDailySchedule(state.weekOffset + 1, nextEquipe);
      }

      const todayRoom = studentSchedule.getStudentRoomOnDay(found.id, dayToUse);
      const tomorrowRoom = tomorrowSchedule.getStudentRoomOnDay(found.id, tomorrowIndex);
      const dayNameToday = studentSchedule.daysData[dayToUse].dayInfo.label;
      const dayNameTomorrow = tomorrowSchedule.daysData[tomorrowIndex].dayInfo.label;

      const isTodayWeekend = studentSchedule.daysData[dayToUse].isWeekend;
      const isTomorrowWeekend = tomorrowSchedule.daysData[tomorrowIndex].isWeekend;

      const todayPartners = studentSchedule.getStudentPartnersOnDay(found.id, dayToUse);
      const tomorrowPartners = tomorrowSchedule.getStudentPartnersOnDay(found.id, tomorrowIndex);

      let todayText = '';
      if (isTodayWeekend) {
        todayText = `<span class="font-bold px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-600 border border-slate-300">R.A.S (Week-end)</span>`;
      } else if (todayRoom) {
        const partnerStr = todayPartners.length > 0 ? ` • en binôme avec <strong class="text-slate-900">${todayPartners.map(p => escapeHtml(p.nom)).join(', ')}</strong>` : '';
        todayText = `au secteur <span class="font-bold px-2 py-0.5 rounded text-xs ${todayRoom.badgeClass}">${todayRoom.name.toUpperCase()}</span>${partnerStr}`;
      } else {
        todayText = `en roulement de service`;
      }

      let tomorrowText = '';
      if (isTomorrowWeekend) {
        tomorrowText = `Demain (${dayNameTomorrow}) : <span class="font-bold text-slate-600">R.A.S</span>`;
      } else if (tomorrowRoom) {
        const partnerStr = tomorrowPartners.length > 0 ? ` (avec ${tomorrowPartners.map(p => escapeHtml(p.nom)).join(', ')})` : '';
        tomorrowText = `Demain (${dayNameTomorrow}) : <span class="font-bold text-slate-900">${tomorrowRoom.name}</span><span class="text-slate-600 font-medium">${partnerStr}</span>`;
      } else {
        tomorrowText = `Demain (${dayNameTomorrow}) : <span class="font-bold text-slate-700">En roulement</span>`;
      }

      banner.classList.remove('hidden');
      banner.innerHTML = `
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-lg ${isTodayWeekend ? 'bg-slate-200 text-slate-700' : 'bg-blue-700 text-white'} font-bold flex items-center justify-center text-xs shrink-0 shadow-2xs border border-blue-800">
            ${getInitials(found.nom)}
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="font-bold text-sm text-slate-900">${escapeHtml(found.nom)}</span>
              <span class="text-[10px] text-blue-900 font-bold bg-blue-100 border border-blue-200 px-1.5 py-0.5 rounded">Équipe ${studentEquipe} • ${studentSchedule.currentTeamShift?.badgeLabel || ''}${found.disponibilite && found.disponibilite !== 'tous' ? ' (Auto)' : ''}</span>
            </div>
            <div class="text-xs text-slate-700 mt-0.5">
              ${studentSchedule.isCurrentWeek ? `Aujourd'hui (${dayNameToday}) ` : `${dayNameToday} `} : ${todayText}
            </div>
          </div>
        </div>
        <div class="text-xs font-semibold text-slate-700 bg-white border border-slate-300 px-3 py-1.5 rounded-md w-full sm:w-auto text-center sm:text-left shadow-2xs shrink-0">
          ${tomorrowText}
        </div>
      `;
      return;
    }

    banner.classList.add('hidden');
  }

  // ============================================================================
  // BASCULE DE VUE (CARTES DU JOUR VS GRILLE COMPLÈTE)
  // ============================================================================
  function renderViewSwitcher() {
    const btnCards = document.getElementById('btn-view-cards');
    const btnTimetable = document.getElementById('btn-view-timetable');
    const viewCards = document.getElementById('view-cards');
    const viewTimetable = document.getElementById('view-timetable');

    if (!btnCards || !btnTimetable || !viewCards || !viewTimetable) return;

    const isCards = state.activeView === 'cards';

    if (isCards) {
      viewCards.classList.remove('hidden');
      viewTimetable.classList.add('hidden');

      btnCards.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-2 sm:py-1.5 rounded-md text-xs font-bold transition-all bg-white text-slate-900 shadow-2xs border border-slate-200 cursor-pointer';
      btnTimetable.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-2 sm:py-1.5 rounded-md text-xs font-bold transition-all text-slate-700 hover:text-slate-900 cursor-pointer';
    } else {
      viewCards.classList.add('hidden');
      viewTimetable.classList.remove('hidden');

      btnCards.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-2 sm:py-1.5 rounded-md text-xs font-bold transition-all text-slate-700 hover:text-slate-900 cursor-pointer';
      btnTimetable.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-2 sm:py-1.5 rounded-md text-xs font-bold transition-all bg-white text-slate-900 shadow-2xs border border-slate-200 cursor-pointer';
    }
  }

  // ============================================================================
  // 1. VUE PAR JOUR (POSTES CLINIQUES & SECTEURS DE SOINS - CHUL)
  // ============================================================================
  function renderDayView(schedule) {
    const pillsContainer = document.getElementById('day-pills-container');
    const dayHeader = document.getElementById('selected-day-header');
    const cardsGrid = document.getElementById('day-cards-grid');
    if (!pillsContainer || !cardsGrid) return;

    if (state.selectedDayIndex === null || state.selectedDayIndex < 0 || state.selectedDayIndex > 6) {
      initCurrentDayIndex();
    }
    const selIdx = state.selectedDayIndex;

    // 1. Boutons calendrier des 7 jours
    let pillsHtml = '';
    schedule.daysData.forEach((d) => {
      const isSelected = d.dayIndex === selIdx;
      const isToday = d.isToday;
      const isWeekend = d.isWeekend;

      let pillClass = '';
      if (isSelected) {
        pillClass = 'bg-slate-900 text-white border-slate-900 font-bold shadow-2xs';
      } else if (isToday) {
        pillClass = 'bg-blue-50 text-blue-950 border border-blue-400 hover:bg-blue-100 font-bold';
      } else if (isWeekend) {
        pillClass = 'bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100 font-medium';
      } else {
        pillClass = 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 font-semibold';
      }

      pillsHtml += `
        <button 
          type="button" 
          data-day-index="${d.dayIndex}"
          class="day-pill-btn shrink-0 px-2.5 sm:px-3 py-2 rounded-lg text-xs transition flex flex-col items-center min-w-[70px] sm:min-w-[88px] cursor-pointer ${pillClass}"
        >
          <div class="flex items-center gap-1 leading-tight">
            <span>${d.dayInfo.short}</span>
            ${isToday ? '<span class="text-[8px] px-1 py-0.2 rounded bg-amber-400 text-slate-950 font-bold">Auj.</span>' : ''}
          </div>
          <span class="text-[10px] opacity-80 mt-0.5">${d.dateFormatted}</span>
        </button>
      `;
    });
    pillsContainer.innerHTML = pillsHtml;

    pillsContainer.querySelectorAll('.day-pill-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-day-index'), 10);
        state.selectedDayIndex = idx;
        render();
      });
    });

    // Centrage automatique de la pastille active sur écran mobile
    const activePill = pillsContainer.querySelector(`[data-day-index="${selIdx}"]`);
    if (activePill && typeof activePill.scrollIntoView === 'function') {
      setTimeout(() => {
        activePill.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }, 50);
    }

    // 2. En-tête du jour sélectionné
    const activeDay = schedule.daysData[selIdx] || schedule.daysData[0];
    const shiftInfo = schedule.currentTeamShift;
    if (dayHeader) {
      dayHeader.innerHTML = `
        <div class="flex items-center gap-1.5 sm:gap-2 flex-wrap">
          <span class="text-sm sm:text-base font-bold text-slate-900">
            ${activeDay.dayInfo.label} ${activeDay.dateFormatted}
          </span>
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${
            shiftInfo?.shift === 'matin' ? 'bg-amber-100 text-amber-950 border border-amber-300' : 'bg-slate-200 text-slate-800 border border-slate-300'
          }">
            ${shiftInfo?.badgeLabel || ''} • Équipe ${schedule.equipe}
          </span>
          ${
            activeDay.isToday
              ? '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-blue-700 text-white uppercase tracking-wider">Aujourd\'hui</span>'
              : activeDay.isWeekend
              ? '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-slate-200 text-slate-700 uppercase tracking-wider">Repos</span>'
              : ''
          }
        </div>
        <span class="text-[11px] font-semibold text-slate-500 hidden sm:inline">
          ${activeDay.isWeekend ? 'Week-end hospitalier' : 'Journée clinique'}
        </span>
      `;
    }

    // 3. Grille des 4 cartes ou message Week-end
    if (activeDay.isWeekend) {
      cardsGrid.innerHTML = `
        <div class="col-span-full bg-white rounded-xl p-6 sm:p-8 text-center border border-slate-300 shadow-xs">
          <div class="w-12 h-12 bg-slate-100 text-slate-700 rounded-lg flex items-center justify-center mx-auto mb-3 border border-slate-200">
            <svg class="w-6 h-6 text-slate-600" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
          </div>
          <h3 class="text-base sm:text-lg font-bold text-slate-900">Service de Week-end • R.A.S (Repos)</h3>
          <p class="text-xs sm:text-sm text-slate-600 max-w-lg mx-auto mt-1 font-medium">
            Conformément aux modalités du stage aux Urgences Pédiatriques, aucun service régulier d'externat ou de stage de jour n'est programmé le samedi et le dimanche.
          </p>
          <div class="inline-flex items-center gap-2 mt-4 px-3.5 py-1.5 rounded-md bg-slate-50 border border-slate-200 text-slate-700 text-xs font-semibold">
            <span class="w-2 h-2 rounded-full bg-slate-400"></span>
            <span>Reprise de la rotation clinique : <strong>Lundi matin à 07h30</strong></span>
          </div>
        </div>
      `;
      return;
    }

    if (schedule.allStagiaires.length === 0) {
      cardsGrid.innerHTML = `
        <div class="col-span-full bg-white rounded-xl p-8 text-center border border-slate-300 shadow-xs">
          <div class="w-12 h-12 bg-slate-100 text-slate-700 rounded-lg flex items-center justify-center mx-auto mb-3 border border-slate-300">
            <svg class="w-6 h-6 text-slate-600" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
            </svg>
          </div>
          <h3 class="text-base font-bold text-slate-900">Aucun stagiaire enregistré dans l'Équipe ${schedule.equipe}</h3>
          <p class="text-xs text-slate-500 mt-1 max-w-sm mx-auto font-medium">Vous pouvez configurer les affectations depuis le bouton <strong class="text-slate-900 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-300">Administration</strong> en haut à droite.</p>
        </div>
      `;
      return;
    }

    const query = state.searchQuery.trim().toLowerCase();
    let cardsHtml = '';

    const SECTOR_METADATA = [
      { code: "SECTEUR 01 • ACCUEIL & ORIENTATION", topBar: "border-t-4 border-t-blue-600" },
      { code: "SECTEUR 02 • SOINS & BILANS", topBar: "border-t-4 border-t-emerald-600" },
      { code: "SECTEUR 03 • URGENCES ABSOLUES", topBar: "border-t-4 border-t-rose-600" },
      { code: "SECTEUR 04 • SURVEILLANCE", topBar: "border-t-4 border-t-purple-600" }
    ];

    activeDay.roomAssignments.forEach((room, roomIdx) => {
      const isRoomHighlighted = query && room.students.some((s) => s.nom.toLowerCase().includes(query));
      const sectorMeta = SECTOR_METADATA[roomIdx] || { code: `SECTEUR 0${roomIdx + 1}`, topBar: "border-t-4 border-t-slate-600" };

      let studentsHtml = '';
      if (room.students.length === 0) {
        studentsHtml = `
          <div class="p-3 text-center text-xs text-slate-400 italic bg-slate-50 rounded-lg border border-dashed border-slate-200">
            ${room.absentStudents && room.absentStudents.length > 0 ? 'Stagiaires absent(s) aujourd\'hui' : 'Aucun stagiaire assigné sur ce créneau'}
          </div>
        `;
      } else {
        studentsHtml = room.students
          .map((student) => {
            const isMatch = query && student.nom.toLowerCase().includes(query);
            return `
              <div class="flex items-center justify-between p-2 rounded-lg transition ${
                isMatch
                  ? 'bg-amber-50 border-2 border-amber-400 text-amber-950 font-bold shadow-2xs'
                  : 'bg-slate-50 border border-slate-200 text-slate-800'
              }">
                <div class="flex items-center gap-2 truncate">
                  <span class="w-6 h-6 rounded-md bg-white text-slate-700 font-bold flex items-center justify-center text-[10px] shrink-0 border border-slate-300">
                    ${getInitials(student.nom)}
                  </span>
                  <span class="text-xs ${isMatch ? 'font-black text-amber-950' : 'font-semibold'} truncate">
                    ${escapeHtml(student.nom)}
                  </span>
                </div>
                ${isMatch ? '<span class="text-[9px] bg-amber-600 text-white font-bold px-1.5 py-0.5 rounded uppercase tracking-wider">Votre poste</span>' : ''}
              </div>
            `;
          })
          .join('');
      }

      let absentHtml = '';
      if (room.absentStudents && room.absentStudents.length > 0) {
        absentHtml = `
          <div class="mt-2 pt-2 border-t border-slate-200 flex items-center gap-1.5 text-[10px] text-slate-500 font-medium bg-slate-50 px-2.5 py-1.5 rounded-md border border-slate-200">
            <span class="w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0"></span>
            <span class="truncate">Absent(s) : <span class="line-through text-slate-500">${room.absentStudents.map(s => escapeHtml(s.nom)).join(', ')}</span></span>
          </div>
        `;
      }

      cardsHtml += `
        <div class="bg-white rounded-xl border ${sectorMeta.topBar} ${
          isRoomHighlighted ? 'border-amber-400 ring-2 ring-amber-200 shadow-md' : 'border-slate-300'
        } p-4 shadow-xs flex flex-col justify-between transition-all hover:border-slate-400">
          <div>
            <!-- En-tête secteur hospitalier -->
            <div class="flex items-start justify-between gap-2 mb-2 pb-2 border-b border-slate-100">
              <div>
                <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">
                  ${sectorMeta.code}
                </div>
                <div class="flex items-center gap-1.5">
                  <span class="w-2.5 h-2.5 rounded-sm ${room.badgeDot} shrink-0"></span>
                  <h4 class="font-black text-sm text-slate-900 leading-tight">${room.name}</h4>
                  <span class="inline-block text-[10px] font-bold px-1.5 py-0.2 rounded border ${room.badgeClass}">
                    ${room.groupName}
                  </span>
                </div>
              </div>
              <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200 shrink-0" title="${room.students.length} stagiaire(s) en poste">
                ${room.students.length} ${room.students.length > 1 ? 'postes' : 'poste'}
              </span>
            </div>

            <!-- Description du secteur -->
            <div class="p-2.5 rounded-lg bg-slate-50/80 border border-slate-100 text-[11px] text-slate-600 mb-3 leading-snug">
              ${room.description}
            </div>

            <!-- Liste des stagiaires affectés -->
            <div class="space-y-1.5 mb-2">
              <div class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 flex items-center justify-between">
                <span>Effectif en poste :</span>
                <span>${room.students.length} actif${room.students.length > 1 ? 's' : ''}</span>
              </div>
              ${studentsHtml}
              ${absentHtml}
            </div>
          </div>

          <!-- Rôle & Missions cliniques -->
          <div class="mt-3 pt-2.5 border-t border-slate-100 text-[10px] text-slate-500 leading-tight">
            <strong class="text-slate-700">Missions cliniques :</strong> ${room.roleInfo}
          </div>
        </div>
      `;
    });

    cardsGrid.innerHTML = cardsHtml;
  }

  // ============================================================================
  // 2. TABLEAU D'EMPLOI DU TEMPS COMPLET (7 JOURS : LUN À DIM - RESPONSIVE)
  // ============================================================================
  function renderTimetable(schedule) {
    const headerRow = document.getElementById('timetable-header-row');
    const tbody = document.getElementById('timetable-body');
    if (!headerRow || !tbody) return;

    // 1. Colonnes d'en-tête (Lundi à Dimanche)
    let headerHtml = `
      <th class="p-2 sm:p-3 sticky-col text-left min-w-[120px] sm:min-w-[170px] bg-slate-100 border-b-2 border-slate-300 text-[11px] sm:text-xs">
        Étudiant Stagiaire
      </th>
    `;

    schedule.daysData.forEach((day) => {
      const isToday = day.isToday;
      const isWeekend = day.isWeekend;
      headerHtml += `
        <th class="p-2 sm:p-2.5 text-center min-w-[95px] sm:min-w-[130px] border-b-2 ${
          isToday
            ? 'bg-blue-100/90 border-b-blue-700 text-blue-950 font-bold'
            : isWeekend
            ? 'bg-slate-50 border-b-slate-300 text-slate-500'
            : 'bg-slate-100 border-b-slate-300 text-slate-800'
        }">
          <div class="flex items-center justify-center gap-1">
            <span class="font-bold sm:font-black">${day.dayInfo.short}</span>
            <span class="text-[9px] sm:text-[10px] font-semibold text-slate-500">${day.dateFormatted}</span>
          </div>
          ${
            isToday
              ? '<span class="inline-block mt-0.5 px-1 sm:px-1.5 py-0.2 rounded text-[8px] sm:text-[9px] bg-blue-700 text-white font-bold uppercase">Auj.</span>'
              : isWeekend
              ? '<span class="inline-block mt-0.5 px-1 sm:px-1.5 py-0.2 rounded text-[8px] sm:text-[9px] bg-slate-200 text-slate-600 font-bold uppercase">R.A.S</span>'
              : ''
          }
        </th>
      `;
    });

    headerRow.innerHTML = headerHtml;

    // 2. Déterminer la liste des étudiants à afficher pour cette équipe
    const query = state.searchQuery.trim().toLowerCase();
    const sortedStudents = [...schedule.allStagiaires].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

    if (sortedStudents.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="p-8 text-center text-xs text-slate-500 font-semibold bg-slate-50/50">
            <div class="max-w-md mx-auto space-y-2">
              <div class="w-10 h-10 bg-slate-100 text-slate-700 rounded-lg flex items-center justify-center mx-auto mb-2 border border-slate-300">
                <svg class="w-5 h-5 text-slate-700" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
              </div>
              <p class="font-bold text-slate-800 text-sm">Aucun stagiaire affecté dans l'Équipe ${schedule.equipe}.</p>
              <p class="text-xs text-slate-500">Accédez à l'espace <strong class="text-slate-900 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-300">Administration</strong> pour configurer les affectations d'équipe.</p>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    let rowsHtml = '';

    sortedStudents.forEach((student) => {
      const isMatch = query && student.nom.toLowerCase().includes(query);
      const isInactive = !student.actif;

      if (isInactive) {
        rowsHtml += `
          <tr class="timetable-row ${isMatch ? 'highlighted' : ''} bg-slate-50/70 opacity-60">
            <td class="p-2 sm:p-2.5 sticky-col font-medium text-xs text-slate-500">
              <div class="flex items-center gap-1.5 truncate">
                <span class="w-2 h-2 rounded-full bg-slate-400 shrink-0"></span>
                <span class="line-through truncate">${escapeHtml(student.nom)}</span>
                <span class="text-[8px] bg-slate-200 text-slate-600 px-1 py-0.2 rounded font-bold shrink-0">Absent</span>
              </div>
            </td>
            <td colspan="7" class="p-2.5 text-center text-xs text-slate-400 italic">
              Stagiaire inactif / absent (ne participe pas aux rotations)
            </td>
          </tr>
        `;
        return;
      }

      const gIdx = schedule.studentGroupMap.get(student.id);
      const groupName = GROUP_NAMES[gIdx] || '';

      // Générer les 7 cellules de jours
      let cellsHtml = '';
      schedule.daysData.forEach((day) => {
        const room = schedule.getStudentRoomOnDay(student.id, day.dayIndex);
        const isToday = day.isToday;
        const isWeekend = day.isWeekend;

        if (isWeekend) {
          cellsHtml += `
            <td class="p-1 sm:p-2 text-center transition ${isToday ? 'col-today bg-blue-50/50' : 'bg-slate-50/40'}">
              <span class="inline-flex items-center justify-center px-2 py-0.5 rounded text-[10px] font-bold text-slate-600 bg-slate-100 border border-slate-300">
                R.A.S
              </span>
            </td>
          `;
        } else if (room) {
          const partners = schedule.getStudentPartnersOnDay(student.id, day.dayIndex);
          const partnerNames = partners.map((p) => p.nom).join(', ');
          const partnerTitle = partnerNames ? `En binôme avec ${escapeHtml(partnerNames)}` : '';
          cellsHtml += `
            <td class="p-1 sm:p-2 text-center transition ${isToday ? 'col-today' : ''}" title="${partnerTitle}">
              <span class="inline-flex flex-col items-center justify-center gap-0.5 px-1.5 sm:px-2 py-1 rounded-md text-[10px] sm:text-xs font-bold border ${room.badgeClass} ${
                isToday ? 'ring-2 ring-blue-600 shadow-2xs' : ''
              }">
                <span class="truncate">${room.shortName}</span>
                ${partnerNames ? `<span class="text-[9px] font-medium text-slate-600 truncate max-w-[85px] sm:max-w-[110px] leading-tight hidden sm:block">avec ${escapeHtml(partnerNames)}</span>` : ''}
              </span>
            </td>
          `;
        } else {
          cellsHtml += `<td class="p-1 sm:p-2 text-center text-slate-400 text-xs">-</td>`;
        }
      });

      rowsHtml += `
        <tr class="timetable-row ${isMatch ? 'highlighted' : ''}">
          <!-- Nom de l'étudiant (Colonne fixe) -->
          <td class="p-2 sm:p-3 sticky-col font-semibold text-xs sm:text-sm text-slate-900">
            <div class="flex items-center gap-1.5 sm:gap-2 truncate">
              <span class="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-slate-100 text-slate-700 font-bold flex items-center justify-center text-[10px] sm:text-xs shrink-0 border border-slate-200">
                ${getInitials(student.nom)}
              </span>
              <span class="truncate text-[11px] sm:text-xs md:text-sm ${isMatch ? 'text-amber-950 font-black' : ''}">
                ${escapeHtml(student.nom)}
              </span>
            </div>
          </td>
          ${cellsHtml}
        </tr>
      `;
    });

    tbody.innerHTML = rowsHtml;
  }

  // ============================================================================
  // PANEL D'ADMINISTRATION
  // ============================================================================
  function renderAdminPanel() {
    const list = document.getElementById('admin-stagiaires-list');
    const totalSpan = document.getElementById('admin-count-total');
    const activeSpan = document.getElementById('admin-count-active');
    const inactiveSpan = document.getElementById('admin-count-inactive');
    const dateInput = document.getElementById('admin-start-date-input');
    const summaryEl = document.getElementById('admin-groups-summary');

    const tabTeam1 = document.getElementById('admin-tab-team-1');
    const tabTeam2 = document.getElementById('admin-tab-team-2');
    const tabAll = document.getElementById('admin-tab-all');
    const tabTeam1Count = document.getElementById('admin-tab-team-1-count');
    const tabTeam2Count = document.getElementById('admin-tab-team-2-count');
    const tabAllCount = document.getElementById('admin-tab-all-count');

    if (dateInput && state.config.date_debut_stage) {
      dateInput.value = state.config.date_debut_stage.substring(0, 10);
    }

    const focusedTeam = state.adminFilterEquipe === '2' ? '2' : '1';
    const schedule = calculateDailySchedule(state.weekOffset, focusedTeam);
    const isEven = schedule.shifts.isEvenWeek;

    const countTeam1 = state.stagiaires.filter((s) => getEffectiveStudentTeam(s, isEven) === '1').length;
    const countTeam2 = state.stagiaires.filter((s) => getEffectiveStudentTeam(s, isEven) === '2').length;
    const countAll = state.stagiaires.length;

    if (tabTeam1Count) tabTeam1Count.textContent = countTeam1;
    if (tabTeam2Count) tabTeam2Count.textContent = countTeam2;
    if (tabAllCount) tabAllCount.textContent = countAll;

    const activeTabClass = 'flex-1 py-1.5 px-2 rounded-lg text-xs font-black transition bg-white text-blue-900 shadow-2xs border border-blue-200';
    const inactiveTabClass = 'flex-1 py-1.5 px-2 rounded-lg text-xs font-bold transition text-slate-600 hover:text-slate-900 hover:bg-white/50';

    if (tabTeam1) tabTeam1.className = state.adminFilterEquipe === '1' ? activeTabClass : inactiveTabClass;
    if (tabTeam2) tabTeam2.className = state.adminFilterEquipe === '2' ? activeTabClass : inactiveTabClass;
    if (tabAll) tabAll.className = state.adminFilterEquipe === 'all' ? activeTabClass : inactiveTabClass;

    // Résumé de la répartition des 4 groupes pour l'équipe en cours
    if (summaryEl) {
      const groupStyles = [
        'bg-blue-50 text-blue-900 border-blue-200',
        'bg-emerald-50 text-emerald-900 border-emerald-200',
        'bg-rose-50 text-rose-900 border-rose-200',
        'bg-purple-50 text-purple-900 border-purple-200'
      ];
      const startingRooms = ['Triage', 'Piquage', 'Déchocage', 'Observation'];
      summaryEl.innerHTML = schedule.groups
        .map((grp, idx) => {
          const letter = ['A', 'B', 'C', 'D'][idx];
          return `
            <div class="p-2 sm:p-2.5 rounded-xl border ${groupStyles[idx]} flex flex-col items-center justify-center text-center">
              <span class="text-[10px] sm:text-[11px] font-black uppercase tracking-wider">Groupe ${letter} (Éq. ${focusedTeam})</span>
              <span class="text-[9px] sm:text-[10px] font-bold opacity-80 mt-0.5">Lundi : ${startingRooms[idx]}</span>
              <span class="text-xs sm:text-sm font-black mt-1">${grp.length} stagiaire${grp.length > 1 ? 's' : ''}</span>
            </div>
          `;
        })
        .join('');
    }

    if (!list) return;

    let displayStudents = state.stagiaires;
    if (state.adminFilterEquipe === '1') {
      displayStudents = state.stagiaires.filter((s) => getEffectiveStudentTeam(s, isEven) === '1');
    } else if (state.adminFilterEquipe === '2') {
      displayStudents = state.stagiaires.filter((s) => getEffectiveStudentTeam(s, isEven) === '2');
    }

    const total = displayStudents.length;
    const active = displayStudents.filter((s) => s.actif).length;
    const inactive = total - active;

    if (totalSpan) totalSpan.textContent = total;
    if (activeSpan) activeSpan.textContent = active;
    if (inactiveSpan) inactiveSpan.textContent = inactive;

    const sorted = [...displayStudents].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

    if (sorted.length === 0) {
      list.innerHTML = `
        <div class="p-6 text-center text-xs text-slate-500 bg-slate-50 rounded-xl border border-dashed border-slate-200">
          Aucun stagiaire dans cette sélection. Utilisez le formulaire ci-dessus pour en ajouter.
        </div>
      `;
      return;
    }

    list.innerHTML = sorted
      .map((s) => {
        const baseTeam = (s.equipe === '2' || s.equipe === 2) ? '2' : (s.equipe === 'auto' ? 'auto' : '1');
        const effectiveTeam = getEffectiveStudentTeam(s, isEven);
        const isFixedSlot = (s.disponibilite === 'matin' || s.disponibilite === 'apres_midi');
        const isAutoTeam = (baseTeam === 'auto');
        const teamSchedule = calculateDailySchedule(state.weekOffset, effectiveTeam);
        const gIdx = teamSchedule.studentGroupMap.get(s.id);
        const currentGroupLetter = gIdx !== undefined ? ['A', 'B', 'C', 'D'][gIdx] : '?';
        const teamShiftInfo = (effectiveTeam === '2' ? teamSchedule.shifts.team2 : teamSchedule.shifts.team1);
        const dispo = s.disponibilite || 'tous';

        return `
      <div class="flex flex-col gap-2.5 p-3.5 rounded-2xl border ${
        s.actif ? 'bg-white border-slate-200 shadow-2xs' : 'bg-slate-50 border-dashed border-slate-300 opacity-60'
      }">
        <!-- Ligne 1 : Nom complet + Statut Présence + Actions rapides -->
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <span class="w-8 h-8 rounded-full ${s.actif ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-500'} font-bold flex items-center justify-center text-xs shrink-0 shadow-2xs">
              ${getInitials(s.nom)}
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-black text-slate-900 truncate">${escapeHtml(s.nom)}</span>
                <span class="text-[10px] font-black px-2 py-0.5 rounded-md ${effectiveTeam === '2' ? 'bg-indigo-100 text-indigo-900' : 'bg-blue-100 text-blue-900'}">
                  En poste : Équipe ${effectiveTeam} (${teamShiftInfo.badgeLabel})
                </span>
                ${
                  (isAutoTeam || isFixedSlot)
                    ? `<span class="text-[10px] font-black px-2 py-0.5 rounded-md bg-cyan-100 text-cyan-900 border border-cyan-200">🔄 Auto</span>`
                    : ''
                }
              </div>
              <div class="text-[11px] ${s.actif ? 'text-emerald-700' : 'text-slate-500'} font-semibold mt-0.5">
                ${s.actif ? '● Présent • En rotation active' : '○ Absent • Exclu temporairement'}
              </div>
            </div>
          </div>

          <!-- Actions rapides : Toggle Présent & Supprimer -->
          <div class="flex items-center gap-2 shrink-0">
            <label class="relative inline-flex items-center cursor-pointer" title="${s.actif ? 'Marquer absent' : 'Marquer présent'}">
              <input type="checkbox" data-admin-toggle="${s.id}" class="sr-only peer" ${s.actif ? 'checked' : ''}>
              <div class="w-9 h-5 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
            </label>
            <button data-admin-delete="${s.id}" data-name="${escapeHtml(s.nom)}" class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition cursor-pointer" title="Supprimer">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- Ligne 2 : Sélecteurs de Configuration (Équipe, Disponibilité, Salle Lundi) -->
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2 border-t border-slate-100 bg-slate-50/70 p-2.5 rounded-xl">
          <!-- Sélecteur d'équipe -->
          <div class="flex flex-col gap-0.5">
            <span class="text-[9px] font-black uppercase tracking-wider text-slate-500">Équipe</span>
            <select data-admin-equipe="${s.id}" class="text-xs font-bold bg-white hover:bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer shadow-2xs" title="Équipe d'affectation">
              <option value="auto" ${baseTeam === 'auto' ? 'selected' : ''}>🔄 Équipe Auto</option>
              <option value="1" ${baseTeam === '1' ? 'selected' : ''}>Équipe 1</option>
              <option value="2" ${baseTeam === '2' ? 'selected' : ''}>Équipe 2</option>
            </select>
          </div>

          <!-- Sélecteur de créneau horaire -->
          <div class="flex flex-col gap-0.5">
            <span class="text-[9px] font-black uppercase tracking-wider text-slate-500">Créneau disponible</span>
            <select data-admin-dispo="${s.id}" class="text-xs font-bold bg-white hover:bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer shadow-2xs" title="Disponibilité horaire">
              <option value="tous" ${dispo === 'tous' ? 'selected' : ''}>Matin & Après-midi (Tous)</option>
              <option value="matin" ${dispo === 'matin' ? 'selected' : ''}>Matin uniquement</option>
              <option value="apres_midi" ${dispo === 'apres_midi' ? 'selected' : ''}>Après-midi uniquement</option>
            </select>
          </div>

          <!-- Sélecteur de groupe / salle de départ -->
          <div class="flex flex-col gap-0.5">
            <span class="text-[9px] font-black uppercase tracking-wider text-slate-500">Salle de départ Lundi</span>
            <select data-admin-group="${s.id}" class="text-xs font-bold bg-white hover:bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer shadow-2xs" title="Groupe d'affectation">
              <option value="" ${!s.groupe ? 'selected' : ''}>Équilibré</option>
              <option value="A" ${s.groupe === 'A' ? 'selected' : ''}>Groupe A • Triage</option>
              <option value="B" ${s.groupe === 'B' ? 'selected' : ''}>Groupe B • Piquage</option>
              <option value="C" ${s.groupe === 'C' ? 'selected' : ''}>Groupe C • Déchocage</option>
              <option value="D" ${s.groupe === 'D' ? 'selected' : ''}>Groupe D • Observation</option>
            </select>
          </div>
        </div>

        <!-- Ligne 3 : Bannière informative automatique si contrainte ou Équipe Auto -->
        ${
          (isAutoTeam || isFixedSlot)
            ? `
          <div class="flex items-center gap-2 p-2 rounded-xl bg-blue-50/90 border border-blue-200 text-blue-900 text-xs font-bold">
            <span class="text-sm shrink-0">🔄</span>
            <span class="truncate sm:whitespace-normal">
              <strong>Adaptation 100% Automatique :</strong> ${
                isFixedSlot
                  ? `Contrainte <strong>${dispo === 'matin' ? 'Matin uniquement' : 'Après-midi uniquement'}</strong>.`
                  : `Configuré(e) en <strong>Équipe Auto</strong>.`
              } Rattaché(e) à l'<strong>Équipe ${effectiveTeam} (${teamShiftInfo.badgeLabel})</strong> cette semaine.
            </span>
          </div>
          `
            : ''
        }
      </div>
    `;
      })
      .join('');

    list.querySelectorAll('[data-admin-equipe]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = sel.getAttribute('data-admin-equipe');
        const val = sel.value;
        await changeStagiaireEquipe(id, val);
      });
    });

    list.querySelectorAll('[data-admin-dispo]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = sel.getAttribute('data-admin-dispo');
        const val = sel.value;
        await changeStagiaireDisponibilite(id, val);
      });
    });

    list.querySelectorAll('[data-admin-quick-swap]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-admin-quick-swap');
        const target = btn.getAttribute('data-target-team');
        await changeStagiaireEquipe(id, target);
      });
    });

    list.querySelectorAll('[data-admin-group]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = sel.getAttribute('data-admin-group');
        const val = sel.value;
        await changeStagiaireGroup(id, val);
      });
    });

    list.querySelectorAll('[data-admin-toggle]').forEach((chk) => {
      chk.addEventListener('change', async () => {
        const id = chk.getAttribute('data-admin-toggle');
        await toggleStagiaire(id, chk.checked);
      });
    });

    list.querySelectorAll('[data-admin-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-admin-delete');
        const name = btn.getAttribute('data-name');
        if (confirm(`Supprimer définitivement ${name} ?`)) {
          await deleteStagiaire(id);
        }
      });
    });

    updateAdminTokenIndicator();
  }

  // ============================================================================
  // ACTIONS BDD
  // ============================================================================
  async function changeStagiaireGroup(id, newGroup) {
    const s = state.stagiaires.find((item) => item.id === id);
    if (!s) return;

    const validGroup = ['A', 'B', 'C', 'D'].includes(newGroup?.toUpperCase()) ? newGroup.toUpperCase() : null;
    const cleanName = s.nom.replace(/\s*\[(?:Groupe\s+)?([A-D])\]\s*$/i, '').trim();
    s.nom = cleanName;
    s.groupe = validGroup;
    saveLocalCustomGroups();

    const roomNames = { 'A': 'Triage', 'B': 'Piquage', 'C': 'Déchocage', 'D': 'Observation' };

    if (state.client && state.isSupabaseConnected) {
      try {
        const { error } = await state.client.from('stagiaires').update({ groupe: validGroup }).eq('id', id);
        if (error) throw error;
        render();
        showToast(validGroup ? `${s.nom} assigné(e) au Groupe ${validGroup} (${roomNames[validGroup]} le Lundi)` : `${s.nom} en Groupe Auto`, 'success');
      } catch (err) {
        console.warn('Erreur mise à jour groupe Supabase:', err);
        render();
        showToast(validGroup ? `${s.nom} assigné(e) au Groupe ${validGroup} (Local)` : `${s.nom} en Groupe Auto`, 'info');
      }
    } else {
      saveDemoStagiaires();
      render();
      showToast(validGroup ? `${s.nom} assigné(e) au Groupe ${validGroup}` : `${s.nom} en Groupe Auto`, 'success');
    }
  }

  async function toggleStagiaire(id, newStatus) {
    const s = state.stagiaires.find((i) => i.id === id);
    const sName = s ? s.nom : 'Stagiaire';

    if (state.client && state.isSupabaseConnected) {
      try {
        const { error } = await state.client.from('stagiaires').update({ actif: newStatus }).eq('id', id);
        if (error) throw error;
        if (s) s.actif = newStatus;
        render();
        showToast(
          newStatus
            ? `${sName} réintégré(e) (Présent)`
            : `${sName} suspendu(e) (Le planning des autres stagiaires reste inchangé)`,
          'success'
        );
      } catch (err) {
        showToast('Erreur Supabase update', 'error');
      }
    } else {
      if (s) {
        s.actif = newStatus;
        saveDemoStagiaires();
        render();
        showToast(
          newStatus
            ? `${sName} réintégré(e)`
            : `${sName} suspendu(e) (Planning protégé)`,
          'success'
        );
      }
    }
  }

  async function changeStagiaireEquipe(id, newEquipe) {
    const s = state.stagiaires.find((item) => item.id === id);
    if (!s) return;

    const validEquipe = (newEquipe === '2' || newEquipe === 2) ? '2' : ((newEquipe === '1' || newEquipe === 1) ? '1' : 'auto');
    s.equipe = validEquipe;

    if (state.client && state.isSupabaseConnected) {
      try {
        const { error } = await state.client.from('stagiaires').update({ equipe: validEquipe }).eq('id', id);
        if (error) throw error;
        render();
        const teamDesc = validEquipe === 'auto' ? 'Équipe Auto' : `Équipe ${validEquipe}`;
        showToast(`${s.nom} configuré(e) en ${teamDesc}`, 'success');
      } catch (err) {
        console.warn('Erreur mise à jour equipe Supabase:', err);
        render();
        showToast(`${s.nom} : Équipe mise à jour (Local)`, 'info');
      }
    } else {
      saveDemoStagiaires();
      render();
      const teamDesc = validEquipe === 'auto' ? 'Équipe Auto' : `Équipe ${validEquipe}`;
      showToast(`${s.nom} configuré(e) en ${teamDesc}`, 'success');
    }
  }

  async function changeStagiaireDisponibilite(id, newDispo) {
    const s = state.stagiaires.find((item) => item.id === id);
    if (!s) return;

    const validDispo = ['matin', 'apres_midi', 'tous'].includes(newDispo) ? newDispo : 'tous';
    s.disponibilite = validDispo;

    const labelMap = {
      tous: 'Matin & Après-midi',
      matin: 'Matinée uniquement',
      apres_midi: 'Après-midi uniquement'
    };

    if (state.client && state.isSupabaseConnected) {
      try {
        const { error } = await state.client.from('stagiaires').update({ disponibilite: validDispo }).eq('id', id);
        if (error) throw error;
        render();
        showToast(`${s.nom} : Disponibilité mise à jour (${labelMap[validDispo]})`, 'success');
      } catch (err) {
        console.warn('Erreur mise à jour disponibilite Supabase:', err);
        render();
        showToast(`${s.nom} : Disponibilité mise à jour (Local)`, 'info');
      }
    } else {
      saveDemoStagiaires();
      render();
      showToast(`${s.nom} : Disponibilité mise à jour`, 'success');
    }
  }

  async function addStagiaire(nom, groupe = '', equipe = 'auto', disponibilite = 'tous') {
    const trimmed = nom.trim();
    if (!trimmed) return;
    const validGroup = ['A', 'B', 'C', 'D'].includes(groupe?.toUpperCase()) ? groupe.toUpperCase() : null;
    const validEquipe = (equipe === '2' || equipe === 2) ? '2' : ((equipe === '1' || equipe === 1) ? '1' : 'auto');
    const validDispo = ['matin', 'apres_midi', 'tous'].includes(disponibilite) ? disponibilite : 'tous';

    if (state.client && state.isSupabaseConnected) {
      try {
        let payload = { nom: trimmed, actif: true, equipe: validEquipe, disponibilite: validDispo };
        if (validGroup) payload.groupe = validGroup;

        let res = await state.client.from('stagiaires').insert([payload]).select().single();
        if (res.error) throw res.error;
        const data = res.data;
        if (data) {
          const parsed = parseStudentNom(data.nom, data.groupe);
          data.nom = parsed.nom;
          data.groupe = parsed.groupe;
          data.equipe = (data.equipe === '2' || data.equipe === 2) ? '2' : ((data.equipe === '1' || data.equipe === 1) ? '1' : 'auto');
          data.disponibilite = validDispo;
          state.stagiaires.push(data);
          state.stagiaires.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
          saveLocalCustomGroups();
        }
        render();
        const teamDesc = validEquipe === 'auto' ? 'Équipe Auto' : `Équipe ${validEquipe}`;
        showToast(`${trimmed} ajouté(e) (${teamDesc}${validGroup ? ', Groupe ' + validGroup : ''})`, 'success');
      } catch (err) {
        showToast('Erreur ajout stagiaire', 'error');
      }
    } else {
      const newStudent = { id: 'demo-' + Date.now(), nom: trimmed, actif: true, groupe: validGroup, equipe: validEquipe, disponibilite: validDispo };
      state.stagiaires.push(newStudent);
      state.stagiaires.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
      saveDemoStagiaires();
      saveLocalCustomGroups();
      render();
      const teamDesc = validEquipe === 'auto' ? 'Équipe Auto' : `Équipe ${validEquipe}`;
      showToast(`${trimmed} ajouté(e) (${teamDesc})`, 'success');
    }
  }

  async function deleteStagiaire(id) {
    if (state.client && state.isSupabaseConnected) {
      try {
        const { error } = await state.client.from('stagiaires').delete().eq('id', id);
        if (error) throw error;
        state.stagiaires = state.stagiaires.filter((s) => s.id !== id);
        render();
        showToast('Stagiaire supprimé', 'info');
      } catch (err) {
        showToast('Erreur suppression', 'error');
      }
    } else {
      state.stagiaires = state.stagiaires.filter((s) => s.id !== id);
      saveDemoStagiaires();
      render();
      showToast('Stagiaire supprimé', 'info');
    }
  }

  async function updateStartDate(newDate) {
    if (!newDate) return;
    if (state.client && state.isSupabaseConnected) {
      try {
        const { error } = await state.client.from('config').upsert({ id: 1, date_debut_stage: newDate });
        if (error) throw error;
        state.config.date_debut_stage = newDate;
        render();
        showToast('Date de début enregistrée', 'success');
      } catch (err) {
        showToast('Erreur enregistrement date', 'error');
      }
    } else {
      state.config.date_debut_stage = newDate;
      saveDemoStagiaires();
      render();
      showToast('Date enregistrée', 'success');
    }
  }

  // ============================================================================
  // WHATSAPP
  // ============================================================================
  function copyTextToClipboard(text, successMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast(successMsg, 'success'));
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(successMsg, 'success');
    }
  }

  // 1. Copier le planning d'aujourd'hui (ou du jour sélectionné)
  function copyWhatsAppToday() {
    const today = new Date();
    if (state.simulatedDayOffset) {
      today.setDate(today.getDate() + state.simulatedDayOffset);
    }
    const day = today.getDay();
    const currentDayIdx = day === 0 ? 6 : day - 1;
    const dayIdx = (state.selectedDayIndex !== null && state.selectedDayIndex >= 0 && state.selectedDayIndex <= 6)
      ? state.selectedDayIndex
      : currentDayIdx;

    const team1Schedule = calculateDailySchedule(state.weekOffset, '1');
    const day1 = team1Schedule.daysData[dayIdx];

    const team2Members = state.stagiaires.filter((s) => (s.equipe || '1') === '2');
    const hasTeam2 = team2Members.length > 0;

    let text = `🏥 *Centre Hospitalier Universitaire de Libreville (CHUL) • Service des Urgences Pédiatriques*\n*Date : ${day1.dayInfo.label} ${day1.dateFormatted}*\n\n`;

    if (day1.isWeekend) {
      text += `⚪ *R.A.S*\n_Reprise du service lundi matin._\n\n`;
    } else if (!hasTeam2) {
      const shift = team1Schedule.currentTeamShift;
      text += `*${shift.label.toUpperCase()} • ÉQUIPE 1* (${shift.shift === 'matin' ? '07h30 - 14h30' : '14h00 - 20h30'})\n\n`;
      day1.roomAssignments.forEach((ra) => {
        text += `${ra.emoji ? ra.emoji + ' ' : ''}*${ra.name}*\n\n`;
        if (ra.students.length === 0) {
          text += `• _(aucun stagiaire en poste)_\n\n`;
        } else {
          ra.students.forEach((st) => {
            text += `• ${st.nom}\n`;
          });
          text += `\n`;
        }
      });
    } else {
      const team2Schedule = calculateDailySchedule(state.weekOffset, '2');
      const day2 = team2Schedule.daysData[dayIdx];

      const team1IsMorning = team1Schedule.shifts.team1.shift === 'matin';

      const morningTeam = team1IsMorning
        ? { name: 'ÉQUIPE 1', day: day1 }
        : { name: 'ÉQUIPE 2', day: day2 };

      const afternoonTeam = team1IsMorning
        ? { name: 'ÉQUIPE 2', day: day2 }
        : { name: 'ÉQUIPE 1', day: day1 };

      // 1. Matinée
      text += `*MATINÉE • ${morningTeam.name}* (07h30 - 14h30)\n\n`;
      morningTeam.day.roomAssignments.forEach((ra) => {
        text += `${ra.emoji ? ra.emoji + ' ' : ''}*${ra.name}*\n\n`;
        if (ra.students.length === 0) {
          text += `• _(aucun stagiaire en poste)_\n\n`;
        } else {
          ra.students.forEach((st) => {
            text += `• ${st.nom}\n`;
          });
          text += `\n`;
        }
      });

      // 2. Séparateur
      text += `───────────────\n`;

      // 3. Après-midi
      text += `*APRÈS-MIDI • ${afternoonTeam.name}* (14h00 - 20h30)\n\n`;
      afternoonTeam.day.roomAssignments.forEach((ra) => {
        text += `${ra.emoji ? ra.emoji + ' ' : ''}*${ra.name}*\n\n`;
        if (ra.students.length === 0) {
          text += `• _(aucun stagiaire en poste)_\n\n`;
        } else {
          ra.students.forEach((st) => {
            text += `• ${st.nom}\n`;
          });
          text += `\n`;
        }
      });
    }

    text += `🌐 *Planning complet de la semaine :*\nhttps://stg-welle.github.io/rotation-urgences/`;
    copyTextToClipboard(text, 'Planning du jour copié !');
    closeModal('whatsapp-modal');
  }

  // 2. Copier le planning de la semaine complète
  function copyWhatsAppWeek() {
    const team1Schedule = calculateDailySchedule(state.weekOffset, '1');
    const team2Members = state.stagiaires.filter((s) => (s.equipe || '1') === '2');
    const hasTeam2 = team2Members.length > 0;
    const team2Schedule = hasTeam2 ? calculateDailySchedule(state.weekOffset, '2') : null;

    const s = formatDateShort(team1Schedule.targetMonday);
    const e = formatDateShort(team1Schedule.targetSunday);

    let text = `🏥 *CHUL • SERVICE DES URGENCES PÉDIATRIQUES*\n`;
    text += `📋 *Planning de la semaine du ${s.toUpperCase()} au ${e.toUpperCase()}*\n`;
    if (hasTeam2) {
      const t1Shift = team1Schedule.shifts.team1;
      const t2Shift = team1Schedule.shifts.team2;
      text += `• Équipe 1 : ${t1Shift.badgeLabel} (${t1Shift.shift === 'matin' ? '07h30-14h30' : '14h00-20h30'})\n`;
      text += `• Équipe 2 : ${t2Shift.badgeLabel} (${t2Shift.shift === 'matin' ? '07h30-14h30' : '14h00-20h30'})\n\n`;
    } else {
      const shift = team1Schedule.currentTeamShift;
      text += `• Créneau : ${shift.badgeLabel}\n\n`;
    }

    for (let d = 0; d < 7; d++) {
      const d1 = team1Schedule.daysData[d];
      text += `📅 *${d1.dayInfo.label.toUpperCase()} ${d1.dateFormatted} :*\n`;
      if (d1.isWeekend) {
        text += `  ⚪ *R.A.S* (Reprise du service lundi matin)\n\n`;
      } else if (!hasTeam2) {
        d1.roomAssignments.forEach((ra) => {
          const names = ra.students.map((st) => st.nom).join(' & ');
          text += `  ${ra.emoji ? ra.emoji + ' ' : ''}*${ra.name} :* ${names || '(aucun)'}\n`;
        });
        text += `\n`;
      } else {
        const d2 = team2Schedule.daysData[d];
        const team1IsMorning = team1Schedule.shifts.team1.shift === 'matin';
        const morningDay = team1IsMorning ? { name: 'Éq.1 (Matin)', day: d1 } : { name: 'Éq.2 (Matin)', day: d2 };
        const afternoonDay = team1IsMorning ? { name: 'Éq.2 (Soir)', day: d2 } : { name: 'Éq.1 (Soir)', day: d1 };

        text += `  *${morningDay.name} :*\n`;
        morningDay.day.roomAssignments.forEach((ra) => {
          const names = ra.students.map((st) => st.nom).join(' & ');
          if (names) text += `    ${ra.emoji ? ra.emoji + ' ' : ''}${ra.name} : ${names}\n`;
        });

        text += `  *${afternoonDay.name} :*\n`;
        afternoonDay.day.roomAssignments.forEach((ra) => {
          const names = ra.students.map((st) => st.nom).join(' & ');
          if (names) text += `    ${ra.emoji ? ra.emoji + ' ' : ''}${ra.name} : ${names}\n`;
        });
        text += `\n`;
      }
    }

    text += `🌐 *Consulter en ligne :*\nhttps://stg-welle.github.io/rotation-urgences/`;
    copyTextToClipboard(text, 'Semaine complète copiée !');
    closeModal('whatsapp-modal');
  }

  // ============================================================================
  // ÉCOUTEURS D'ÉVÉNEMENTS
  // ============================================================================
  function initEventListeners() {
    // Navigation semaines
    document.getElementById('btn-week-prev')?.addEventListener('click', () => {
      state.weekOffset -= 1;
      render();
    });

    document.getElementById('btn-week-next')?.addEventListener('click', () => {
      state.weekOffset += 1;
      render();
    });

    document.getElementById('btn-week-today')?.addEventListener('click', () => {
      state.weekOffset = 0;
      initCurrentDayIndex();
      render();
    });

    // Bascule de vue : Cartes (Mobile) vs Tableau (Semaine)
    document.getElementById('btn-view-cards')?.addEventListener('click', () => {
      state.activeView = 'cards';
      localStorage.setItem('urgences_active_view', 'cards');
      renderViewSwitcher();
    });

    document.getElementById('btn-view-timetable')?.addEventListener('click', () => {
      state.activeView = 'table';
      localStorage.setItem('urgences_active_view', 'table');
      renderViewSwitcher();
      setTimeout(() => {
        const todayCol = document.querySelector('.col-today');
        if (todayCol && window.innerWidth < 768) {
          todayCol.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      }, 100);
    });

    // Sélecteur d'Équipe (Équipe 1 vs Équipe 2)
    document.getElementById('btn-team-1')?.addEventListener('click', () => {
      state.selectedEquipe = '1';
      render();
    });

    document.getElementById('btn-team-2')?.addEventListener('click', () => {
      state.selectedEquipe = '2';
      render();
    });

    // Onglets de filtrage par équipe dans l'espace Admin
    document.getElementById('admin-tab-team-1')?.addEventListener('click', () => {
      state.adminFilterEquipe = '1';
      renderAdminPanel();
    });

    document.getElementById('admin-tab-team-2')?.addEventListener('click', () => {
      state.adminFilterEquipe = '2';
      renderAdminPanel();
    });

    document.getElementById('admin-tab-all')?.addEventListener('click', () => {
      state.adminFilterEquipe = 'all';
      renderAdminPanel();
    });

    // Recherche
    const searchInput = document.getElementById('student-search-input');
    searchInput?.addEventListener('input', (e) => {
      const q = e.target.value;
      state.searchQuery = q;
      if (q.trim()) {
        localStorage.setItem('urgences_my_student_name', q.trim());
        const match = state.stagiaires.find((s) => s.nom.toLowerCase().includes(q.trim().toLowerCase()));
        if (match) {
          const currentSched = calculateDailySchedule(state.weekOffset, state.selectedEquipe);
          const isEven = currentSched.shifts?.isEvenWeek ?? true;
          const effTeam = getEffectiveStudentTeam(match, isEven);
          if (effTeam !== state.selectedEquipe) {
            state.selectedEquipe = effTeam;
          }
        }
      } else {
        localStorage.removeItem('urgences_my_student_name');
      }
      render();
    });

    document.getElementById('btn-clear-search')?.addEventListener('click', () => {
      state.searchQuery = '';
      if (searchInput) searchInput.value = '';
      localStorage.removeItem('urgences_my_student_name');
      render();
    });

    // Boutons WhatsApp
    document.getElementById('btn-share-whatsapp')?.addEventListener('click', () => {
      openModal('whatsapp-modal');
    });

    document.getElementById('btn-copy-wa-today')?.addEventListener('click', copyWhatsAppToday);
    document.getElementById('btn-copy-wa-week')?.addEventListener('click', copyWhatsAppWeek);

    // Admin (Cadenas PIN)

    document.getElementById('btn-open-admin')?.addEventListener('click', () => {
      if (state.isAdminAuthenticated) {
        renderAdminPanel();
        openModal('admin-modal');
      } else {
        openPinModal();
      }
    });

    document.getElementById('pin-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('pin-input');
      const err = document.getElementById('pin-error-msg');
      if (input && input.value.trim() === (state.config.pin_code || '1234')) {
        state.isAdminAuthenticated = true;
        closeModal('pin-modal');
        renderAdminPanel();
        openModal('admin-modal');
        input.value = '';
        if (err) err.classList.add('hidden');
      } else {
        if (err) {
          err.textContent = 'Code incorrect';
          err.classList.remove('hidden');
        }
      }
    });

    document.getElementById('admin-add-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('admin-new-name-input');
      const groupSelect = document.getElementById('admin-new-group-select');
      const equipeSelect = document.getElementById('admin-new-equipe-select');
      const dispoSelect = document.getElementById('admin-new-dispo-select');
      if (nameInput && nameInput.value.trim()) {
        const groupVal = groupSelect ? groupSelect.value : '';
        const equipeVal = equipeSelect ? equipeSelect.value : 'auto';
        const dispoVal = dispoSelect ? dispoSelect.value : 'tous';
        await addStagiaire(nameInput.value.trim(), groupVal, equipeVal, dispoVal);
        nameInput.value = '';
        if (groupSelect) groupSelect.value = '';
        if (dispoSelect) dispoSelect.value = 'tous';
        if (equipeSelect) equipeSelect.value = 'auto';
      }
    });

    document.getElementById('admin-save-start-date')?.addEventListener('click', async () => {
      const input = document.getElementById('admin-start-date-input');
      if (input && input.value) {
        await updateStartDate(input.value);
      }
    });

    // Outils de simulation de date (pour tester et voir la colonne bouger en direct)
    document.getElementById('btn-sim-today')?.addEventListener('click', () => {
      state.simulatedDayOffset = 0;
      initCurrentDayIndex();
      render();
      showToast('Date réelle rétablie', 'info');
      closeModal('admin-modal');
    });

    document.getElementById('btn-sim-tomorrow')?.addEventListener('click', () => {
      state.simulatedDayOffset = 1;
      initCurrentDayIndex();
      render();
      showToast('Simulation active : +1 jour', 'success');
      closeModal('admin-modal');
    });

    document.getElementById('btn-sim-dayafter')?.addEventListener('click', () => {
      state.simulatedDayOffset = 2;
      initCurrentDayIndex();
      render();
      showToast('Simulation active : +2 jours', 'success');
      closeModal('admin-modal');
    });

    // Déclencheur Bot WhatsApp manuel (Espace Admin)
    document.getElementById('btn-admin-trigger-bot')?.addEventListener('click', async () => {
      await triggerWhatsAppBotFromAdmin();
    });

    document.getElementById('btn-toggle-github-token')?.addEventListener('click', () => {
      const panel = document.getElementById('admin-github-token-setup');
      if (panel) panel.classList.toggle('hidden');
    });

    document.getElementById('btn-admin-save-github-token')?.addEventListener('click', () => {
      const input = document.getElementById('admin-github-token-input');
      const val = input ? input.value.trim() : '';
      if (val) {
        localStorage.setItem('urgences_github_token', val);
        showToast('Clé GitHub mémorisée sur cet appareil !', 'success');
        document.getElementById('admin-github-token-setup')?.classList.add('hidden');
        updateAdminTokenIndicator();
      } else {
        localStorage.removeItem('urgences_github_token');
        showToast('Clé GitHub effacée', 'info');
        updateAdminTokenIndicator();
      }
    });

    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeModal(btn.getAttribute('data-close-modal'));
      });
    });

    // Fermeture automatique au clic sur l'arrière-plan (backdrop)
    ['whatsapp-modal', 'pin-modal', 'admin-modal'].forEach((id) => {
      const modal = document.getElementById(id);
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            closeModal(id);
          }
        });
      }
    });

    // Fermeture rapide avec la touche Échap
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        ['whatsapp-modal', 'pin-modal', 'admin-modal'].forEach((id) => closeModal(id));
      }
    });
  }

  function updateAdminTokenIndicator() {
    const indicator = document.getElementById('admin-token-status-indicator');
    const input = document.getElementById('admin-github-token-input');
    const token = localStorage.getItem('urgences_github_token') || window.APP_CONFIG.GITHUB_TOKEN;
    if (indicator) {
      if (token) {
        indicator.innerHTML = '<span class="text-emerald-700">● Clé autorisée</span>';
      } else {
        indicator.innerHTML = '<span class="text-amber-700">○ Clé requise</span>';
      }
    }
    if (input && token && !input.value) {
      input.value = token;
    }
  }

  async function triggerWhatsAppBotFromAdmin() {
    const btn = document.getElementById('btn-admin-trigger-bot');
    const statusBox = document.getElementById('admin-bot-status');
    if (!btn) return;

    const token = localStorage.getItem('urgences_github_token') || window.APP_CONFIG.GITHUB_TOKEN;
    const repo = window.APP_CONFIG.GITHUB_REPO || 'STG-welle/rotation-urgences';
    const workflow = window.APP_CONFIG.GITHUB_WORKFLOW_ID || 'weekly-planning-screenshot.yml';

    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('opacity-75', 'cursor-not-allowed');
    btn.innerHTML = `
      <svg class="animate-spin w-4 h-4 text-white shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
      <span>Lancement du bot WhatsApp en cours...</span>
    `;

    if (statusBox) {
      statusBox.className = 'text-xs font-semibold p-3 rounded-lg border bg-blue-50 border-blue-200 text-blue-900 flex items-center gap-2 block';
      statusBox.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-blue-600 animate-ping"></span>
        <span>Demande transmise au bot. Démarrage de la capture d'écran HD...</span>
      `;
    }

    try {
      let dispatchOk = false;

      // 1. Tentative d'abord via l'Edge Function Supabase sécurisée (1-clic direct sans token côté client)
      try {
        const edgeRes = await fetch(`${window.APP_CONFIG.SUPABASE_URL}/functions/v1/green-api-webhook?action=trigger_dispatch`, {
          method: 'POST'
        });
        const edgeData = await edgeRes.json().catch(() => ({}));
        if (edgeRes.ok && edgeData.success) {
          dispatchOk = true;
        }
      } catch (edgeErr) {
        console.warn('Tentative Edge Function dispatch ignorée, repli direct GitHub...', edgeErr);
      }

      // 2. Si le webhook serveur n'a pas répondu, repli direct via l'API GitHub avec le token navigateur
      if (!dispatchOk) {
        if (!token) {
          showToast('Veuillez renseigner votre clé GitHub ci-dessous', 'warning');
          const panel = document.getElementById('admin-github-token-setup');
          if (panel) panel.classList.remove('hidden');
          document.getElementById('admin-github-token-input')?.focus();
          if (statusBox) {
            statusBox.className = 'text-xs font-semibold p-3 rounded-lg border bg-amber-50 border-amber-300 text-amber-950 block';
            statusBox.textContent = 'Veuillez saisir votre clé GitHub (token) ci-dessous puis cliquer sur Enregistrer.';
          }
          return;
        }

        const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            ref: 'main'
          })
        });

        if (res.status === 204 || res.ok) {
          dispatchOk = true;
        } else {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.message || `Erreur HTTP ${res.status}`);
        }
      }

      if (dispatchOk) {
        showToast('Bot WhatsApp lancé avec succès !', 'success');
        if (statusBox) {
          statusBox.className = 'text-xs font-semibold p-3 rounded-lg border bg-emerald-100/90 border-emerald-300 text-emerald-950 block space-y-1';
          statusBox.innerHTML = `
            <div class="font-bold flex items-center gap-1.5 text-emerald-900">
              <svg class="w-4 h-4 text-emerald-700 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
              <span>✅ Bot déclenché avec succès !</span>
            </div>
            <p class="text-[11px] text-emerald-800 leading-relaxed">
              Le robot génère l'image haute définition des deux équipes et l'envoie dans votre groupe WhatsApp. L'image arrivera dans environ 45 secondes.
            </p>
          `;
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || `Erreur HTTP ${res.status}`);
      }
    } catch (err) {
      console.error('Erreur déclenchement bot:', err);
      showToast('Erreur lors du déclenchement du bot', 'error');
      if (statusBox) {
        statusBox.className = 'text-xs font-semibold p-3 rounded-lg border bg-rose-50 border-rose-300 text-rose-900 block';
        if (err.message && (err.message.includes('Bad credentials') || err.message.includes('401'))) {
          statusBox.textContent = '❌ Clé GitHub invalide ou expirée. Veuillez vérifier ou renouveler votre clé dans les paramètres ci-dessous.';
          const panel = document.getElementById('admin-github-token-setup');
          if (panel) panel.classList.remove('hidden');
        } else {
          statusBox.textContent = `❌ Échec du lancement : ${err.message}`;
        }
      }
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.classList.remove('opacity-75', 'cursor-not-allowed');
        btn.innerHTML = originalHtml;
      }, 4000);
    }
  }

  function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }

  function openPinModal() {
    const input = document.getElementById('pin-input');
    const err = document.getElementById('pin-error-msg');
    if (input) input.value = '';
    if (err) err.classList.add('hidden');
    openModal('pin-modal');
    setTimeout(() => input?.focus(), 120);
  }
})();
