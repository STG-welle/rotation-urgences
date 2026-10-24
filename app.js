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
        showToast('Connecté à Supabase en direct', 'success');
        return;
      } catch (err) {
        console.warn('Mode démo activé:', err);
        showToast('Supabase non joignable. Mode démo actif.', 'warning');
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
        badgeLabel: team1Shift === 'matin' ? '☀️ Matin' : '🌙 Après-midi',
        emoji: team1Shift === 'matin' ? '☀️' : '🌙'
      },
      team2: {
        shift: team2Shift,
        label: team2Shift === 'matin' ? 'Matinée' : 'Après-midi',
        badgeLabel: team2Shift === 'matin' ? '☀️ Matin' : '🌙 Après-midi',
        emoji: team2Shift === 'matin' ? '☀️' : '🌙'
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
  // BRASSAGE DYNAMIQUE QUOTIDIEN DES BINÔMES (Social Golfer / Tournoi Harmonique)
  // Permet à tous les stagiaires de changer de binôme et de salle chaque jour,
  // et de travailler avec TOUS les membres de l'équipe au cours du mois.
  // Propriétés mathématiques vérifiées :
  // 1. Zéro répétition de salle consécutive (aucun stagiaire dans la même salle 2 jours de suite)
  // 2. Zéro répétition de binôme consécutive (aucun stagiaire avec le même collègue 2 jours de suite)
  // 3. Toutes les paires se rencontrent équitablement au moins une fois par semaine / 2 à 3 fois par mois
  // ============================================================================
  const SCHEDULE_7 = [
    [[7, 0], [1, 6], [2, 5], [3, 4]], // Tour 0 : Triage [7,0], Piquage [1,6], Déchoc [2,5], Obs [3,4]
    [[4, 5], [2, 0], [3, 6], [7, 1]], // Tour 1
    [[0, 3], [7, 5], [1, 2], [6, 4]], // Tour 2
    [[5, 6], [3, 1], [4, 0], [7, 2]], // Tour 3
    [[4, 2], [6, 0], [7, 3], [5, 1]], // Tour 4
    [[5, 3], [7, 4], [0, 1], [6, 2]], // Tour 5
    [[1, 4], [2, 3], [7, 6], [0, 5]]  // Tour 6
  ];

  function gcd(a, b) {
    while (b) {
      const t = b;
      b = a % b;
      a = t;
    }
    return a;
  }

  function getDailyRoomAssignments(activeStudents, workDayIndex) {
    const N = activeStudents.length;
    if (N === 0) return [[], [], [], []];

    // Pour l'effectif standard de 8 stagiaires (2 par salle) :
    // Utilise la matrice optimale canonique vérifiée
    if (N === 8) {
      const roundIdx = ((workDayIndex % 7) + 7) % 7;
      const round = SCHEDULE_7[roundIdx];
      return round.map((pair) => pair.map((idx) => activeStudents[idx]));
    }

    // Répartition adaptative pour tout autre effectif (N != 8)
    const baseCap = Math.floor(N / 4);
    const remainder = N % 4;
    const roomCaps = [0, 1, 2, 3].map((r) => baseCap + (r < remainder ? 1 : 0));

    let step = 3;
    while (gcd(step, N) !== 1 && step < N) step++;
    if (step >= N) step = 1;

    const offset = ((workDayIndex * 3) % N + N) % N;
    const perm = [];
    for (let i = 0; i < N; i++) {
      perm.push(activeStudents[(offset + i * step) % N]);
    }

    const roomShift = ((workDayIndex % 4) + 4) % 4;
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
          emoji: '⚪',
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
        shiftSummaryBadge.textContent = `${s1.emoji} Éq. 1 ${s1.label} • ${s2.emoji} Éq. 2 ${s2.label}`;
      }
    }

    if (btn1 && btn2) {
      if (state.selectedEquipe === '1') {
        btn1.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black transition-all bg-blue-600 text-white shadow-xs';
        btn2.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black transition-all text-slate-700 hover:text-slate-900';
      } else {
        btn2.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black transition-all bg-blue-600 text-white shadow-xs';
        btn1.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black transition-all text-slate-700 hover:text-slate-900';
      }
    }
  }


  function renderHeaderStatus() {
    const pill = document.getElementById('status-pill');
    if (!pill) return;

    if (state.isSupabaseConnected) {
      pill.innerHTML = `
        <span class="inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
        <span class="text-emerald-700">En direct</span>
      `;
      pill.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 transition';
    } else {
      pill.innerHTML = `
        <span class="inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
        <span class="text-amber-700">Mode Démo</span>
      `;
      pill.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-50 border border-amber-200 hover:bg-amber-100 transition';
    }
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
        badge.innerHTML = `<span class="inline-flex items-center gap-1"><svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg> Mode Test : +${state.simulatedDayOffset}j</span> <span class="underline ml-1 font-black">(Revenir au réel)</span>`;
        badge.className = 'px-2 py-0.5 rounded-full text-[11px] font-extrabold bg-amber-500 text-white shadow-xs cursor-pointer';
        badge.onclick = () => {
          state.simulatedDayOffset = 0;
          initCurrentDayIndex();
          render();
          showToast('Retour au temps réel', 'info');
        };
      } else if (schedule.isCurrentWeek) {
        badge.onclick = null;
        badge.textContent = `Semaine en cours (S${schedule.weekNumber})`;
        badge.className = 'px-2 py-0.5 rounded-full text-[11px] font-extrabold bg-blue-100 text-blue-800 border border-blue-200';
      } else if (state.weekOffset > 0) {
        badge.onclick = null;
        badge.textContent = `Dans +${state.weekOffset} sem. (S${schedule.weekNumber})`;
        badge.className = 'px-2 py-0.5 rounded-full text-[11px] font-extrabold bg-indigo-100 text-indigo-800 border border-indigo-200';
      } else {
        badge.onclick = null;
        badge.textContent = `Il y a ${Math.abs(state.weekOffset)} sem. (S${schedule.weekNumber})`;
        badge.className = 'px-2 py-0.5 rounded-full text-[11px] font-extrabold bg-slate-100 text-slate-700 border border-slate-200';
      }
    }

    if (todayBtn) {
      if (schedule.isCurrentWeek) {
        todayBtn.classList.add('bg-slate-100', 'text-slate-400');
        todayBtn.classList.remove('bg-white', 'text-slate-900', 'shadow-xs');
      } else {
        todayBtn.classList.remove('bg-slate-100', 'text-slate-400');
        todayBtn.classList.add('bg-white', 'text-slate-900', 'shadow-xs');
      }
    }

    const countSpan = document.getElementById('count-active-students');
    if (countSpan) countSpan.textContent = schedule.activeCount;
  }

  // Bandeau informatif personnalisé si recherche active
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
        banner.innerHTML = `<span class="italic text-slate-500">Aucun stagiaire trouvé pour "${escapeHtml(state.searchQuery)}".</span>`;
        return;
      }

      if (!found.actif) {
        banner.classList.remove('hidden');
        banner.innerHTML = `
          <div class="flex items-center gap-2">
            <span class="px-2 py-0.5 rounded-md text-[10px] font-black bg-slate-200 text-slate-700 uppercase tracking-wider">Absent</span>
            <span><strong>${escapeHtml(found.nom)}</strong> est actuellement noté(e) <strong>absent(e)</strong>.</span>
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

      const todayRoom = studentSchedule.getStudentRoomOnDay(found.id, dayToUse);
      const tomorrowRoom = studentSchedule.getStudentRoomOnDay(found.id, tomorrowIndex);
      const dayNameToday = studentSchedule.daysData[dayToUse].dayInfo.label;
      const dayNameTomorrow = studentSchedule.daysData[tomorrowIndex].dayInfo.label;

      const isTodayWeekend = studentSchedule.daysData[dayToUse].isWeekend;
      const isTomorrowWeekend = studentSchedule.daysData[tomorrowIndex].isWeekend;

      const todayPartners = studentSchedule.getStudentPartnersOnDay(found.id, dayToUse);
      const tomorrowPartners = studentSchedule.getStudentPartnersOnDay(found.id, tomorrowIndex);

      let todayText = '';
      if (isTodayWeekend) {
        todayText = `<span class="font-extrabold px-2 py-0.5 rounded-md bg-slate-200 text-slate-700 border border-slate-300">⚪ R.A.S (Week-end / Repos)</span>`;
      } else if (todayRoom) {
        const partnerStr = todayPartners.length > 0 ? ` avec <span class="underline font-bold">${todayPartners.map(p => escapeHtml(p.nom)).join(', ')}</span>` : '';
        todayText = `au <span class="font-black px-2 py-0.5 rounded-md ${todayRoom.badgeClass}">${todayRoom.emoji} ${todayRoom.name.toUpperCase()}</span>${partnerStr}`;
      } else {
        todayText = `en rotation`;
      }

      let tomorrowText = '';
      if (isTomorrowWeekend) {
        tomorrowText = `Demain (${dayNameTomorrow}) : <span class="font-black text-slate-600">⚪ R.A.S (Week-end)</span>`;
      } else if (tomorrowRoom) {
        const partnerStr = tomorrowPartners.length > 0 ? ` (avec ${tomorrowPartners.map(p => escapeHtml(p.nom)).join(', ')})` : '';
        tomorrowText = `Demain (${dayNameTomorrow}) : <span class="font-black text-slate-900">${tomorrowRoom.emoji} ${tomorrowRoom.name}</span><span class="text-slate-600 font-semibold">${partnerStr}</span>`;
      } else {
        tomorrowText = `Demain (${dayNameTomorrow}) : <span class="font-black text-slate-700">En rotation</span>`;
      }

      banner.classList.remove('hidden');
      banner.innerHTML = `
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-xl ${isTodayWeekend ? 'bg-slate-200 text-slate-600' : 'bg-blue-600 text-white'} flex items-center justify-center shrink-0">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
          </div>
            <span class="font-black text-xs sm:text-sm text-slate-900">${escapeHtml(found.nom)} <span class="text-[10px] text-blue-700 font-extrabold bg-blue-100 px-1.5 py-0.2 rounded-md">Équipe ${studentEquipe} • ${studentSchedule.currentTeamShift?.badgeLabel || ''}${found.disponibilite && found.disponibilite !== 'tous' ? ' (Auto)' : ''}</span></span> :
            ${studentSchedule.isCurrentWeek ? `Aujourd'hui (${dayNameToday}) ` : `${dayNameToday} `}
            ${todayText}.
          </div>
        </div>
        <div class="text-[11px] font-bold text-slate-700 bg-white border border-slate-200 px-2.5 py-1 rounded-lg w-full sm:w-auto text-center sm:text-left shadow-2xs">
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

      btnCards.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-black transition-all bg-white text-blue-900 shadow-xs';
      btnTimetable.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-black transition-all text-slate-600 hover:text-slate-900';
    } else {
      viewCards.classList.add('hidden');
      viewTimetable.classList.remove('hidden');

      btnCards.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-black transition-all text-slate-600 hover:text-slate-900';
      btnTimetable.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-black transition-all bg-white text-blue-900 shadow-xs';
    }
  }

  // ============================================================================
  // 1. VUE PAR JOUR (CARTES ADAPTÉES MOBILE & TOUS ÉCRANS)
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

    // 1. Boutons pilules des 7 jours
    let pillsHtml = '';
    schedule.daysData.forEach((d) => {
      const isSelected = d.dayIndex === selIdx;
      const isToday = d.isToday;
      const isWeekend = d.isWeekend;

      let pillClass = '';
      if (isSelected) {
        pillClass = 'bg-blue-600 text-white shadow-md ring-2 ring-blue-400 font-black';
      } else if (isToday) {
        pillClass = 'bg-blue-50 text-blue-900 border-2 border-blue-400 hover:bg-blue-100 font-extrabold';
      } else if (isWeekend) {
        pillClass = 'bg-slate-100 text-slate-500 border border-slate-200 hover:bg-slate-200 font-semibold';
      } else {
        pillClass = 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 font-bold';
      }

      pillsHtml += `
        <button 
          type="button" 
          data-day-index="${d.dayIndex}"
          class="day-pill-btn shrink-0 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-xl text-xs transition flex flex-col items-center min-w-[70px] sm:min-w-[82px] cursor-pointer ${pillClass}"
        >
          <div class="flex items-center gap-1 leading-tight">
            <span>${d.dayInfo.short}</span>
            ${isToday ? '<span class="text-[8px] sm:text-[9px] px-1 py-0.2 rounded bg-amber-400 text-slate-900 font-black">Auj.</span>' : ''}
            ${isWeekend && !isToday ? '<span class="text-[9px] text-slate-400">⚪</span>' : ''}
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

    // 2. En-tête du jour sélectionné
    const activeDay = schedule.daysData[selIdx] || schedule.daysData[0];
    const shiftInfo = schedule.currentTeamShift;
    if (dayHeader) {
      dayHeader.innerHTML = `
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-sm sm:text-base font-black text-slate-900">
            ${activeDay.dayInfo.label} ${activeDay.dateFormatted}
          </span>
          <span class="px-2 py-0.5 rounded-full text-[10px] font-black ${
            shiftInfo?.shift === 'matin' ? 'bg-amber-100 text-amber-900 border border-amber-300' : 'bg-indigo-100 text-indigo-900 border border-indigo-300'
          }">
            ${shiftInfo?.badgeLabel || ''} • Équipe ${schedule.equipe}
          </span>
          ${
            activeDay.isToday
              ? '<span class="px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-black bg-blue-600 text-white uppercase tracking-wider">Aujourd\'hui</span>'
              : activeDay.isWeekend
              ? '<span class="px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-black bg-slate-200 text-slate-700 uppercase tracking-wider">Repos</span>'
              : ''
          }
        </div>
        <span class="text-[11px] font-bold text-slate-500">
          ${activeDay.isWeekend ? 'Week-end' : 'Jour ouvré'}
        </span>
      `;
    }

    // 3. Grille des 4 cartes ou message Week-end
    if (activeDay.isWeekend) {
      cardsGrid.innerHTML = `
        <div class="col-span-full bg-white rounded-3xl p-6 sm:p-8 text-center border border-slate-300 shadow-xs">
          <div class="w-12 h-12 sm:w-14 sm:h-14 bg-slate-100 text-slate-600 rounded-2xl flex items-center justify-center mx-auto mb-3 border border-slate-200">
            <svg class="w-6 h-6 sm:w-7 sm:h-7 text-slate-600" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>
            </svg>
          </div>
          <h3 class="text-base sm:text-lg font-black text-slate-900">Week-end • Repos de Service (R.A.S)</h3>
          <p class="text-xs sm:text-sm text-slate-600 max-w-md mx-auto mt-1 font-medium">
            Aucun étudiant stagiaire n'est de garde le samedi et le dimanche.
          </p>
          <div class="inline-flex items-center gap-2 mt-4 px-3.5 py-1.5 rounded-full bg-slate-50 border border-slate-200 text-slate-700 text-xs font-bold">
            <span class="w-2 h-2 rounded-full bg-slate-400"></span>
            <span>Reprise de la rotation le <strong>Lundi matin à 00h00</strong></span>
          </div>
        </div>
      `;
      return;
    }

    if (schedule.allStagiaires.length === 0) {
      cardsGrid.innerHTML = `
        <div class="col-span-full bg-white rounded-3xl p-8 text-center border border-slate-300 shadow-xs">
          <div class="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-3 border border-blue-200">
            <svg class="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
            </svg>
          </div>
          <h3 class="text-base font-black text-slate-900">Aucun stagiaire dans l'Équipe ${schedule.equipe}</h3>
          <p class="text-xs text-slate-500 mt-1 max-w-sm mx-auto">Vous pouvez ajouter des collègues dans l'Équipe ${schedule.equipe} ou modifier leur affectation depuis le bouton <strong class="text-slate-900 bg-slate-100 px-2 py-0.5 rounded border border-slate-300">Admin</strong> en haut.</p>
        </div>
      `;
      return;
    }

    const query = state.searchQuery.trim().toLowerCase();
    let cardsHtml = '';

    activeDay.roomAssignments.forEach((room) => {
      const isRoomHighlighted = query && room.students.some((s) => s.nom.toLowerCase().includes(query));

      let studentsHtml = '';
      if (room.students.length === 0) {
        studentsHtml = `
          <div class="p-3 text-center text-xs text-slate-400 italic bg-slate-50 rounded-xl border border-dashed border-slate-200">
            ${room.absentStudents && room.absentStudents.length > 0 ? 'Stagiaires absent(s) aujourd\'hui' : 'Aucun stagiaire en poste'}
          </div>
        `;
      } else {
        studentsHtml = room.students
          .map((student) => {
            const isMatch = query && student.nom.toLowerCase().includes(query);
            return `
              <div class="flex items-center justify-between p-2 rounded-xl transition ${
                isMatch
                  ? 'bg-amber-100 border-2 border-amber-400 ring-2 ring-amber-300 text-amber-950 font-black shadow-xs'
                  : 'bg-slate-50/90 border border-slate-100 text-slate-800'
              }">
                <div class="flex items-center gap-2 truncate">
                  <span class="w-6 h-6 rounded-full bg-white text-slate-700 font-bold flex items-center justify-center text-[10px] shrink-0 border border-slate-200 shadow-2xs">
                    ${getInitials(student.nom)}
                  </span>
                  <span class="text-xs ${isMatch ? 'font-black text-amber-950' : 'font-semibold'} truncate">
                    ${escapeHtml(student.nom)}
                  </span>
                </div>
                ${isMatch ? '<span class="text-[9px] bg-amber-500 text-white font-extrabold px-1.5 py-0.5 rounded uppercase tracking-wider">Votre poste</span>' : ''}
              </div>
            `;
          })
          .join('');
      }

      let absentHtml = '';
      if (room.absentStudents && room.absentStudents.length > 0) {
        absentHtml = `
          <div class="mt-2 pt-2 border-t border-slate-100 flex items-center gap-1.5 text-[10px] text-slate-500 font-semibold bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-200">
            <span class="w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0"></span>
            <span class="truncate">Absent(e) : <span class="line-through text-slate-500">${room.absentStudents.map(s => escapeHtml(s.nom)).join(', ')}</span></span>
          </div>
        `;
      }

      cardsHtml += `
        <div class="bg-white rounded-2xl border-2 ${
          isRoomHighlighted ? 'border-amber-400 ring-4 ring-amber-100 shadow-md' : room.cardBorder
        } p-4 shadow-xs flex flex-col justify-between transition-all hover:shadow-md">
          <div>
            <!-- En-tête salle -->
            <div class="flex items-start justify-between gap-2 mb-2 pb-2.5 border-b border-slate-100">
              <div class="flex items-center gap-2">
                <span class="text-2xl">${room.emoji}</span>
                <div>
                  <h4 class="font-black text-sm text-slate-900 leading-tight">${room.name}</h4>
                  <span class="inline-block mt-0.5 text-[10px] font-extrabold px-1.5 py-0.2 rounded ${room.badgeClass}">
                    ${room.groupName}
                  </span>
                </div>
              </div>
              <span class="text-[11px] font-black px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200 shrink-0" title="${room.students.length} actif(s)">
                ${room.students.length}
              </span>
            </div>

            <p class="text-[11px] text-slate-500 mb-3 leading-snug">${room.description}</p>

            <!-- Liste des stagiaires affectés -->
            <div class="space-y-1.5 mb-2">
              <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1 flex items-center justify-between">
                <span>Stagiaires en poste :</span>
                <span>${room.students.length} actif${room.students.length > 1 ? 's' : ''}</span>
              </div>
              ${studentsHtml}
              ${absentHtml}
            </div>
          </div>

          <!-- Rôle & Soins -->
          <div class="mt-3 pt-2.5 border-t border-slate-100 text-[10px] text-slate-500 leading-tight">
            <strong class="text-slate-700">Rôle :</strong> ${room.roleInfo}
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
            ? 'bg-blue-100/80 border-b-blue-600 text-blue-950 font-black'
            : isWeekend
            ? 'bg-slate-50 border-b-slate-300 text-slate-500'
            : 'border-b-slate-300 text-slate-700'
        }">
          <div class="flex items-center justify-center gap-1">
            <span class="font-bold sm:font-black">${day.dayInfo.short}</span>
            <span class="text-[9px] sm:text-[10px] font-semibold text-slate-500">${day.dateFormatted}</span>
          </div>
          ${
            isToday
              ? '<span class="inline-block mt-0.5 px-1 sm:px-1.5 py-0.2 rounded text-[8px] sm:text-[9px] bg-blue-600 text-white font-extrabold uppercase">Auj.</span>'
              : isWeekend
              ? '<span class="inline-block mt-0.5 px-1 sm:px-1.5 py-0.2 rounded text-[8px] sm:text-[9px] bg-slate-200 text-slate-600 font-bold uppercase">Repos</span>'
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
              <div class="w-10 h-10 bg-blue-100 text-blue-700 rounded-xl flex items-center justify-center mx-auto mb-2">
                <svg class="w-5 h-5 text-blue-700" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
              </div>
              <p class="font-bold text-slate-700 text-sm">Aucun stagiaire dans l'Équipe ${schedule.equipe}.</p>
              <p class="text-xs text-slate-500">Accédez à l'espace <strong class="text-slate-900 bg-slate-100 px-2 py-0.5 rounded border border-slate-300">Admin</strong> pour configurer ou ajouter des étudiants dans l'Équipe ${schedule.equipe}.</p>
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
              <span class="inline-flex items-center justify-center px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-md text-[10px] sm:text-[11px] font-black text-slate-500 bg-slate-100 border border-slate-300 shadow-2xs">
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
              <span class="inline-flex flex-col items-center justify-center gap-0.5 px-1.5 sm:px-2 py-1 rounded-lg text-[10px] sm:text-xs font-black border ${room.badgeClass} ${
                isToday ? 'ring-2 ring-blue-500 shadow-xs' : ''
              }">
                <div class="flex items-center gap-0.5 sm:gap-1">
                  <span class="text-xs sm:text-sm leading-none">${room.emoji}</span>
                  <span class="truncate">${room.shortName}</span>
                </div>
                ${partnerNames ? `<span class="text-[9px] font-semibold text-slate-600 truncate max-w-[85px] sm:max-w-[110px] leading-tight hidden sm:block">avec ${escapeHtml(partnerNames)}</span>` : ''}
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
      const startingRooms = ['🔵 Triage', '🟢 Piquage', '🔴 Déchocage', '🟣 Observation'];
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
              <option value="tous" ${dispo === 'tous' ? 'selected' : ''}>☀️/🌙 Tous</option>
              <option value="matin" ${dispo === 'matin' ? 'selected' : ''}>☀️ Matin uniquement</option>
              <option value="apres_midi" ${dispo === 'apres_midi' ? 'selected' : ''}>🌙 Après-midi uniquement</option>
            </select>
          </div>

          <!-- Sélecteur de groupe / salle de départ -->
          <div class="flex flex-col gap-0.5">
            <span class="text-[9px] font-black uppercase tracking-wider text-slate-500">Salle de départ Lundi</span>
            <select data-admin-group="${s.id}" class="text-xs font-bold bg-white hover:bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer shadow-2xs" title="Groupe d'affectation">
              <option value="" ${!s.groupe ? 'selected' : ''}>Équilibré</option>
              <option value="A" ${s.groupe === 'A' ? 'selected' : ''}>Groupe A • 🔵 Triage</option>
              <option value="B" ${s.groupe === 'B' ? 'selected' : ''}>Groupe B • 🟢 Piquage</option>
              <option value="C" ${s.groupe === 'C' ? 'selected' : ''}>Groupe C • 🔴 Déchocage</option>
              <option value="D" ${s.groupe === 'D' ? 'selected' : ''}>Groupe D • 🟣 Observation</option>
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
                  ? `Contrainte <strong>${dispo === 'matin' ? '☀️ Matin uniquement' : '🌙 Après-midi uniquement'}</strong>.`
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

    const roomNames = { 'A': '🔵 Triage', 'B': '🟢 Piquage', 'C': '🔴 Déchocage', 'D': '🟣 Observation' };

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
      showToast(validGroup ? `${s.nom} assigné(e) au Groupe ${validGroup} (Démo)` : `${s.nom} en Groupe Auto`, 'success');
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
            ? `${sName} réintégré(e) (Démo)`
            : `${sName} suspendu(e) (Démo - Planning protégé)`,
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
      showToast(`${s.nom} configuré(e) en ${teamDesc} (Démo)`, 'success');
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
      showToast(`${s.nom} : Disponibilité mise à jour (Démo)`, 'success');
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
      showToast(`${trimmed} ajouté(e) (${teamDesc}) (Démo)`, 'success');
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
      showToast('Stagiaire supprimé (Démo)', 'info');
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
      showToast('Date enregistrée (Démo)', 'success');
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
      text += `⚪ *R.A.S - Repos de garde*\n_Reprise du service lundi matin._\n\n`;
    } else if (!hasTeam2) {
      const shift = team1Schedule.currentTeamShift;
      text += `${shift.emoji} *${shift.label.toUpperCase()} • ÉQUIPE 1* (${shift.shift === 'matin' ? '07h30 - 14h30' : '14h00 - 20h30'})\n\n`;
      day1.roomAssignments.forEach((ra) => {
        text += `${ra.emoji} *${ra.name}*\n\n`;
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
      text += `☀️ *MATINÉE • ${morningTeam.name}* (07h30 - 14h30)\n\n`;
      morningTeam.day.roomAssignments.forEach((ra) => {
        text += `${ra.emoji} *${ra.name}*\n\n`;
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
      text += `🌙 *APRÈS-MIDI • ${afternoonTeam.name}* (14h00 - 20h30)\n\n`;
      afternoonTeam.day.roomAssignments.forEach((ra) => {
        text += `${ra.emoji} *${ra.name}*\n\n`;
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
        text += `  ⚪ *R.A.S* (Repos de garde pour tous les stagiaires)\n\n`;
      } else if (!hasTeam2) {
        d1.roomAssignments.forEach((ra) => {
          const names = ra.students.map((st) => st.nom).join(' & ');
          text += `  ${ra.emoji} *${ra.name} :* ${names || '(aucun)'}\n`;
        });
        text += `\n`;
      } else {
        const d2 = team2Schedule.daysData[d];
        const team1IsMorning = team1Schedule.shifts.team1.shift === 'matin';
        const morningDay = team1IsMorning ? { name: 'Éq.1 (☀️ Matin)', day: d1 } : { name: 'Éq.2 (☀️ Matin)', day: d2 };
        const afternoonDay = team1IsMorning ? { name: 'Éq.2 (🌙 Soir)', day: d2 } : { name: 'Éq.1 (🌙 Soir)', day: d1 };

        text += `  *${morningDay.name} :*\n`;
        morningDay.day.roomAssignments.forEach((ra) => {
          const names = ra.students.map((st) => st.nom).join(' & ');
          if (names) text += `    ${ra.emoji} ${ra.name} : ${names}\n`;
        });

        text += `  *${afternoonDay.name} :*\n`;
        afternoonDay.day.roomAssignments.forEach((ra) => {
          const names = ra.students.map((st) => st.nom).join(' & ');
          if (names) text += `    ${ra.emoji} ${ra.name} : ${names}\n`;
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

    // Config & Admin
    document.getElementById('status-pill')?.addEventListener('click', openConfigModal);
    document.getElementById('btn-open-config')?.addEventListener('click', openConfigModal);

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

    document.getElementById('supabase-config-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = document.getElementById('cfg-supabase-url')?.value.trim() || '';
      const k = document.getElementById('cfg-supabase-key')?.value.trim() || '';
      state.supabaseUrl = u;
      state.supabaseKey = k;
      localStorage.setItem('urgences_supabase_url', u);
      localStorage.setItem('urgences_supabase_key', k);
      closeModal('config-modal');
      await initDatabase();
      render();
    });

    document.getElementById('btn-switch-demo')?.addEventListener('click', () => {
      localStorage.removeItem('urgences_supabase_url');
      localStorage.removeItem('urgences_supabase_key');
      state.supabaseUrl = '';
      state.supabaseKey = '';
      activateDemoMode();
      closeModal('config-modal');
      render();
      showToast('Basculé en mode démo', 'info');
    });

    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeModal(btn.getAttribute('data-close-modal'));
      });
    });
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
    setTimeout(() => input?.focus(), 100);
  }

  function openConfigModal() {
    const u = document.getElementById('cfg-supabase-url');
    const k = document.getElementById('cfg-supabase-key');
    if (u) u.value = state.supabaseUrl || '';
    if (k) k.value = state.supabaseKey || '';
    openModal('config-modal');
  }
})();
