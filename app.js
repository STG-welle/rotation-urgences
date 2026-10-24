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

        state.stagiaires = stagiairesRes.data || [];
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

  function activateDemoMode() {
    state.isSupabaseConnected = false;
    state.isDemoMode = true;

    const localStagiaires = localStorage.getItem('urgences_demo_stagiaires');
    const localStartDate = localStorage.getItem('urgences_demo_start_date');

    if (localStagiaires) {
      try {
        state.stagiaires = JSON.parse(localStagiaires);
      } catch {
        state.stagiaires = [...window.APP_CONFIG.DEMO_STAGIAIRES];
      }
    } else {
      state.stagiaires = [...window.APP_CONFIG.DEMO_STAGIAIRES];
      saveDemoStagiaires();
    }

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
      if (!state.stagiaires.some((s) => s.id === newRec.id)) {
        state.stagiaires.push(newRec);
        state.stagiaires.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
      }
    } else if (eventType === 'UPDATE') {
      const idx = state.stagiaires.findIndex((s) => s.id === newRec.id);
      if (idx !== -1) state.stagiaires[idx] = newRec;
      state.stagiaires.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    } else if (eventType === 'DELETE') {
      state.stagiaires = state.stagiaires.filter((s) => s.id !== oldRec.id);
    }
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

  function calculateDailySchedule(offsetWeeks = state.weekOffset) {
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

    // Stagiaires actifs triés
    const activeStagiaires = state.stagiaires
      .filter((s) => s.actif === true)
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

    // 4 Groupes équilibrés (A, B, C, D)
    const groups = [[], [], [], []];
    const studentGroupMap = new Map();

    activeStagiaires.forEach((s, idx) => {
      const gIdx = idx % 4;
      groups[gIdx].push(s);
      studentGroupMap.set(s.id, gIdx);
    });

    // Calcul pour chacun des 7 jours de la semaine (Lundi à Dimanche)
    const daysData = [];

    for (let d = 0; d < 7; d++) {
      const dayDate = new Date(targetMonday);
      dayDate.setDate(dayDate.getDate() + d);

      const isToday = dayDate.getTime() === today.getTime();
      const isPast = dayDate.getTime() < today.getTime();
      const isWeekend = d === 5 || d === 6; // Samedi = 5, Dimanche = 6

      // Jours ouvrés écoulés (5 jours par semaine : Lun=0, Mar=1, Mer=2, Jeu=3, Ven=4)
      const workingDaysElapsed = weekNumber * 5 + Math.min(d, 4);
      const cycle = ((workingDaysElapsed % 4) + 4) % 4;

      // Affectation des 4 salles pour ce jour (uniquement du Lundi au Vendredi, Samedi & Dimanche = R.A.S)
      const roomAssignments = isWeekend
        ? []
        : window.APP_CONFIG.ROOMS.map((room) => {
            const assignedGroup = ((room.id - cycle) % 4 + 4) % 4;
            return {
              ...room,
              assignedGroup,
              groupName: GROUP_NAMES[assignedGroup],
              students: groups[assignedGroup] || []
            };
          });

      daysData.push({
        dayIndex: d,
        dayInfo: DAYS[d],
        date: dayDate,
        dateFormatted: formatDateShort(dayDate),
        isToday,
        isPast,
        isWeekend,
        cycle,
        roomAssignments
      });
    }

    // Fonction pour retrouver la salle d'un étudiant pour un jour donné
    function getStudentRoomOnDay(studentId, dayIndex) {
      if (!studentGroupMap.has(studentId)) return null;
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
      const g = studentGroupMap.get(studentId);
      const dayData = daysData[dayIndex];
      const roomId = (g + dayData.cycle) % 4;
      return window.APP_CONFIG.ROOMS[roomId];
    }

    return {
      targetMonday,
      targetSunday,
      weekNumber: weekNumber + 1,
      isCurrentWeek: offsetWeeks === 0,
      activeCount: activeStagiaires.length,
      inactiveCount: state.stagiaires.length - activeStagiaires.length,
      activeStagiaires,
      daysData,
      groups,
      studentGroupMap,
      getStudentRoomOnDay
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
    const schedule = calculateDailySchedule(state.weekOffset);

    renderHeaderStatus();
    renderWeekHeader(schedule);
    renderSearchBanner(schedule);
    renderViewSwitcher();
    renderDayView(schedule);
    renderTimetable(schedule);
    renderAdminPanel();
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
        badge.innerHTML = `🧪 Simulation : +${state.simulatedDayOffset}j <span class="underline ml-1 font-black">(Revenir au réel)</span>`;
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
            <span>⏸️</span>
            <span><strong>${escapeHtml(found.nom)}</strong> est actuellement noté(e) <strong>absent(e)</strong>.</span>
          </div>
        `;
        return;
      }

      const todayIndex = schedule.daysData.findIndex((d) => d.isToday);
      const dayToUse = todayIndex !== -1 ? todayIndex : 0;
      const tomorrowIndex = (dayToUse + 1) % 7;

      const todayRoom = schedule.getStudentRoomOnDay(found.id, dayToUse);
      const tomorrowRoom = schedule.getStudentRoomOnDay(found.id, tomorrowIndex);
      const dayNameToday = schedule.daysData[dayToUse].dayInfo.label;
      const dayNameTomorrow = schedule.daysData[tomorrowIndex].dayInfo.label;

      const isTodayWeekend = schedule.daysData[dayToUse].isWeekend;
      const isTomorrowWeekend = schedule.daysData[tomorrowIndex].isWeekend;

      let todayText = '';
      if (isTodayWeekend) {
        todayText = `<span class="font-extrabold px-2 py-0.5 rounded-md bg-slate-200 text-slate-700 border border-slate-300">⚪ R.A.S (Week-end / Repos)</span>`;
      } else {
        todayText = `au <span class="font-black px-2 py-0.5 rounded-md ${todayRoom.badgeClass}">${todayRoom.emoji} ${todayRoom.name.toUpperCase()}</span>`;
      }

      let tomorrowText = '';
      if (isTomorrowWeekend) {
        tomorrowText = `⏭️ Demain (${dayNameTomorrow}) : <span class="font-black text-slate-600">⚪ R.A.S (Week-end)</span>`;
      } else {
        tomorrowText = `⏭️ Demain (${dayNameTomorrow}) : <span class="font-black text-slate-900">${tomorrowRoom.emoji} ${tomorrowRoom.name}</span>`;
      }

      banner.classList.remove('hidden');
      banner.innerHTML = `
        <div class="flex items-center gap-2">
          <span class="text-xl shrink-0">${isTodayWeekend ? '🏖️' : '📍'}</span>
          <div class="leading-snug">
            <span class="font-black text-xs sm:text-sm text-slate-900">${escapeHtml(found.nom)}</span> :
            ${schedule.isCurrentWeek ? `Aujourd'hui (${dayNameToday}) ` : `${dayNameToday} `}
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
    if (dayHeader) {
      dayHeader.innerHTML = `
        <div class="flex items-center gap-2">
          <span class="text-sm sm:text-base font-black text-slate-900">
            ${activeDay.dayInfo.label} ${activeDay.dateFormatted}
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
        <div class="col-span-full bg-gradient-to-br from-slate-50 to-slate-100 rounded-3xl p-6 sm:p-8 text-center border-2 border-dashed border-slate-300 shadow-xs">
          <span class="text-4xl sm:text-5xl mb-3 block">🏖️</span>
          <h3 class="text-base sm:text-lg font-black text-slate-900">Week-end • Repos Général (R.A.S)</h3>
          <p class="text-xs sm:text-sm text-slate-600 max-w-md mx-auto mt-1 font-medium">
            Aucun étudiant stagiaire n'est de garde le samedi et le dimanche.
          </p>
          <div class="inline-flex items-center gap-1.5 mt-4 px-3.5 py-1.5 rounded-full bg-white border border-slate-300 text-slate-700 text-xs font-bold shadow-2xs">
            <span>⚪</span> Reprise automatique de la rotation le <strong>Lundi matin à 00h00</strong>
          </div>
        </div>
      `;
      return;
    }

    if (state.stagiaires.length === 0) {
      cardsGrid.innerHTML = `
        <div class="col-span-full bg-white rounded-3xl p-8 text-center border border-slate-300 shadow-xs">
          <span class="text-4xl mb-2 block">👥</span>
          <h3 class="text-base font-black text-slate-900">Aucun stagiaire dans la base pour le moment</h3>
          <p class="text-xs text-slate-500 mt-1 max-w-sm mx-auto">Cliquez sur <strong class="text-slate-900 bg-slate-100 px-2 py-0.5 rounded border border-slate-300">🔒 Admin</strong> en haut à droite pour ajouter vos collègues.</p>
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
            Aucun stagiaire affecté
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
                ${isMatch ? '<span class="text-[9px] bg-amber-500 text-white font-extrabold px-1.5 py-0.5 rounded">C\'est toi !</span>' : ''}
              </div>
            `;
          })
          .join('');
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
              <span class="text-[11px] font-black px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200 shrink-0">
                ${room.students.length}
              </span>
            </div>

            <p class="text-[11px] text-slate-500 mb-3 leading-snug">${room.description}</p>

            <!-- Liste des stagiaires affectés -->
            <div class="space-y-1.5 mb-2">
              <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1 flex items-center justify-between">
                <span>Stagiaires en poste :</span>
                <span>${room.students.length} au total</span>
              </div>
              ${studentsHtml}
            </div>
          </div>

          <!-- Rôle & Soins -->
          <div class="mt-3 pt-2.5 border-t border-slate-100 text-[10px] text-slate-400 leading-tight">
            🩺 <strong class="text-slate-600">Missions :</strong> ${room.roleInfo}
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

    // 2. Déterminer la liste des étudiants à afficher
    const query = state.searchQuery.trim().toLowerCase();
    const sortedStudents = [...state.stagiaires].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

    if (sortedStudents.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="p-8 text-center text-xs text-slate-500 font-semibold bg-slate-50/50">
            <div class="max-w-md mx-auto space-y-2">
              <span class="text-3xl">👥</span>
              <p class="font-bold text-slate-700 text-sm">Aucun stagiaire dans la base pour le moment.</p>
              <p class="text-xs text-slate-500">Cliquez sur <strong class="text-slate-900 bg-slate-100 px-2 py-0.5 rounded border border-slate-300">🔒 Admin</strong> en haut à droite pour ajouter vos collègues.</p>
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
                <span>⏸️</span>
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
        } else {
          cellsHtml += `
            <td class="p-1 sm:p-2 text-center transition ${isToday ? 'col-today' : ''}">
              <span class="inline-flex items-center gap-0.5 sm:gap-1 px-1.5 sm:px-2.5 py-1 sm:py-1.5 rounded-lg text-[10px] sm:text-xs font-black border ${room.badgeClass} ${
                isToday ? 'ring-2 ring-blue-500 shadow-xs' : ''
              }">
                <span class="text-xs sm:text-sm leading-none">${room.emoji}</span>
                <span class="truncate">${room.shortName}</span>
              </span>
            </td>
          `;
        }
      });

      rowsHtml += `
        <tr class="timetable-row ${isMatch ? 'highlighted' : ''}">
          <!-- Nom de l'étudiant (Colonne fixe) -->
          <td class="p-2 sm:p-3 sticky-col font-semibold text-xs sm:text-sm text-slate-900">
            <div class="flex items-center justify-between gap-1">
              <div class="flex items-center gap-1.5 sm:gap-2 truncate">
                <span class="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-slate-100 text-slate-700 font-bold flex items-center justify-center text-[10px] sm:text-xs shrink-0 border border-slate-200">
                  ${getInitials(student.nom)}
                </span>
                <span class="truncate text-[11px] sm:text-xs md:text-sm ${isMatch ? 'text-amber-950 font-black' : ''}">
                  ${escapeHtml(student.nom)}
                </span>
              </div>
              <span class="text-[8px] sm:text-[9px] font-bold px-1 sm:px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded border border-slate-200 shrink-0 hidden sm:inline-block">
                ${groupName}
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

    if (dateInput && state.config.date_debut_stage) {
      dateInput.value = state.config.date_debut_stage.substring(0, 10);
    }

    if (!list) return;

    const total = state.stagiaires.length;
    const active = state.stagiaires.filter((s) => s.actif).length;
    const inactive = total - active;

    if (totalSpan) totalSpan.textContent = total;
    if (activeSpan) activeSpan.textContent = active;
    if (inactiveSpan) inactiveSpan.textContent = inactive;

    const sorted = [...state.stagiaires].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

    list.innerHTML = sorted
      .map(
        (s) => `
      <div class="flex items-center justify-between p-2.5 rounded-xl border ${
        s.actif ? 'bg-white border-slate-200' : 'bg-slate-100 border-dashed border-slate-300 opacity-60'
      }">
        <div class="flex items-center gap-2.5">
          <span class="w-7 h-7 rounded-full ${s.actif ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-500'} font-bold flex items-center justify-center text-xs">
            ${getInitials(s.nom)}
          </span>
          <div>
            <div class="text-xs sm:text-sm font-bold text-slate-900">${escapeHtml(s.nom)}</div>
            <div class="text-[10px] ${s.actif ? 'text-emerald-700' : 'text-slate-500'} font-semibold">
              ${s.actif ? '✓ Présent (en rotation)' : '⏸️ Absent (exclu du planning)'}
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <!-- Toggle Actif / Absent -->
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" data-admin-toggle="${s.id}" class="sr-only peer" ${s.actif ? 'checked' : ''}>
            <div class="w-10 h-5 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
          </label>

          <!-- Supprimer -->
          <button data-admin-delete="${s.id}" data-name="${escapeHtml(s.nom)}" class="p-1.5 text-slate-400 hover:text-rose-600 rounded transition" title="Supprimer">
            🗑️
          </button>
        </div>
      </div>
    `
      )
      .join('');

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
  async function toggleStagiaire(id, newStatus) {
    if (state.client && state.isSupabaseConnected) {
      try {
        const { error } = await state.client.from('stagiaires').update({ actif: newStatus }).eq('id', id);
        if (error) throw error;
        const s = state.stagiaires.find((i) => i.id === id);
        if (s) s.actif = newStatus;
        render();
        showToast(`Statut mis à jour (${newStatus ? 'Présent' : 'Absent'})`, 'success');
      } catch (err) {
        showToast('Erreur Supabase update', 'error');
      }
    } else {
      const s = state.stagiaires.find((i) => i.id === id);
      if (s) {
        s.actif = newStatus;
        saveDemoStagiaires();
        render();
        showToast(`Statut mis à jour (Démo)`, 'success');
      }
    }
  }

  async function addStagiaire(nom) {
    const trimmed = nom.trim();
    if (!trimmed) return;

    if (state.client && state.isSupabaseConnected) {
      try {
        const { data, error } = await state.client.from('stagiaires').insert([{ nom: trimmed, actif: true }]).select().single();
        if (error) throw error;
        if (data && !state.stagiaires.some((s) => s.id === data.id)) {
          state.stagiaires.push(data);
          state.stagiaires.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
        }
        render();
        showToast(`${trimmed} ajouté`, 'success');
      } catch (err) {
        showToast('Erreur ajout stagiaire', 'error');
      }
    } else {
      state.stagiaires.push({ id: 'demo-' + Date.now(), nom: trimmed, actif: true });
      state.stagiaires.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
      saveDemoStagiaires();
      render();
      showToast(`${trimmed} ajouté (Démo)`, 'success');
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

  // 1. Copier le planning d'aujourd'hui
  function copyWhatsAppToday() {
    const schedule = calculateDailySchedule(state.weekOffset);
    const todayIndex = schedule.daysData.findIndex((d) => d.isToday);
    const day = schedule.daysData[todayIndex !== -1 ? todayIndex : 0];

    let text = `🏥 *PLANNING URGENCES DU ${day.dayInfo.label.toUpperCase()} ${day.dateFormatted.toUpperCase()}*\n\n`;

    if (day.isWeekend) {
      text += `⚪ *R.A.S (Week-end / Repos)*\nAucun stagiaire en service le week-end.\n\n`;
    } else {
      day.roomAssignments.forEach((ra) => {
        text += `${ra.emoji} *${ra.name.toUpperCase()} :*\n`;
        if (ra.students.length === 0) {
          text += `  _(aucun)_\n`;
        } else {
          ra.students.forEach((st) => {
            text += `  • ${st.nom}\n`;
          });
        }
        text += `\n`;
      });
    }

    text += `🔄 _Rotation quotidienne UrgencesRotation_`;
    copyTextToClipboard(text, 'Planning du jour copié !');
    closeModal('whatsapp-modal');
  }

  // 2. Copier le planning de la semaine complète
  function copyWhatsAppWeek() {
    const schedule = calculateDailySchedule(state.weekOffset);
    const s = formatDateShort(schedule.targetMonday);
    const e = formatDateShort(schedule.targetSunday);

    let text = `🏥 *EMPLOI DU TEMPS - SEMAINE DU ${s.toUpperCase()} AU ${e.toUpperCase()}*\n\n`;

    schedule.daysData.forEach((day) => {
      text += `📅 *${day.dayInfo.label.toUpperCase()} ${day.dateFormatted} :*\n`;
      if (day.isWeekend) {
        text += `  ⚪ *R.A.S* (Repos pour tous les stagiaires)\n\n`;
      } else {
        day.roomAssignments.forEach((ra) => {
          const names = ra.students.map((st) => st.nom).join(', ');
          text += `  ${ra.emoji} *${ra.name} :* ${names || 'aucun'}\n`;
        });
        text += `\n`;
      }
    });

    text += `🔄 _Rotation quotidienne UrgencesRotation_`;
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

    // Recherche
    const searchInput = document.getElementById('student-search-input');
    searchInput?.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      if (e.target.value.trim()) {
        localStorage.setItem('urgences_my_student_name', e.target.value.trim());
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
      const input = document.getElementById('admin-new-name-input');
      if (input && input.value.trim()) {
        await addStagiaire(input.value.trim());
        input.value = '';
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
      showToast('Retour à la date réelle d\'aujourd\'hui', 'info');
      closeModal('admin-modal');
    });

    document.getElementById('btn-sim-tomorrow')?.addEventListener('click', () => {
      state.simulatedDayOffset = 1;
      initCurrentDayIndex();
      render();
      showToast('Simulation : Vous êtes demain ! La colonne a bougé.', 'success');
      closeModal('admin-modal');
    });

    document.getElementById('btn-sim-dayafter')?.addEventListener('click', () => {
      state.simulatedDayOffset = 2;
      initCurrentDayIndex();
      render();
      showToast('Simulation : Vous êtes après-demain !', 'success');
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
