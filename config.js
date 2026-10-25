/**
 * Configuration de l'application UrgencesRotation
 * ==================================================
 * Vous pouvez :
 * 1. Soit renseigner vos clés Supabase directement ci-dessous avant d'héberger sur GitHub Pages,
 * 2. Soit laisser vide et les saisir directement dans l'interface de l'application (sauvegardées dans le navigateur).
 */

window.APP_CONFIG = {
  // Vos identifiants Supabase (Project Settings > API dans le dashboard Supabase)
  SUPABASE_URL: 'https://ezpbmutbkuoudmyyozlr.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_U7-ao4uwjTorXXLeCyClBA_ZkytQqmE',

  // Code PIN par défaut pour accéder au panel Administrateur
  DEFAULT_PIN: '1234',

  // Date de référence par défaut du premier lundi de stage (format YYYY-MM-DD)
  DEFAULT_START_DATE: '2026-10-19',

  // Définition des 4 Salles d'Urgence du service
  ROOMS: [
    {
      id: 0,
      code: 'triage',
      name: 'Triage',
      shortName: 'Triage',
      color: 'blue',
      emoji: '',
      badgeClass: 'bg-blue-100 text-blue-800 border-blue-200',
      badgeDot: 'bg-blue-500',
      cardBorder: 'border-blue-200 hover:border-blue-300',
      heroGradient: 'from-blue-600 to-indigo-700',
      accentColor: 'text-blue-600',
      bgLight: 'bg-blue-50/70',
      description: 'Accueil, évaluation clinique et orientation immédiate des urgences.',
      roleInfo: 'Évaluation des constantes, échelle de tri, orientation des patients selon gravité.'
    },
    {
      id: 1,
      code: 'piquage',
      name: 'Piquage',
      shortName: 'Piquage',
      color: 'green',
      emoji: '',
      badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-200',
      badgeDot: 'bg-emerald-500',
      cardBorder: 'border-emerald-200 hover:border-emerald-300',
      heroGradient: 'from-emerald-600 to-teal-700',
      accentColor: 'text-emerald-600',
      bgLight: 'bg-emerald-50/70',
      description: 'Soins infirmiers et bilans d’urgence.',
      roleInfo: 'Prélèvements sanguins, bilans d’urgence, administration des thérapeutiques, ECG.'
    },
    {
      id: 2,
      code: 'dechoc',
      name: 'Déchocage',
      shortName: 'Déchoc',
      color: 'red',
      emoji: '',
      badgeClass: 'bg-rose-100 text-rose-800 border-rose-200',
      badgeDot: 'bg-rose-500',
      cardBorder: 'border-rose-200 hover:border-rose-300',
      heroGradient: 'from-rose-600 to-red-700',
      accentColor: 'text-rose-600',
      bgLight: 'bg-rose-50/70',
      description: 'Prise en charge des détresses vitales et urgences absolues.',
      roleInfo: 'Intubations, arrêts cardio-respiratoires, polytraumatisés, surveillance continue.'
    },
    {
      id: 3,
      code: 'observation',
      name: 'Observation',
      shortName: 'Observation',
      color: 'purple',
      emoji: '',
      badgeClass: 'bg-purple-100 text-purple-800 border-purple-200',
      badgeDot: 'bg-purple-500',
      cardBorder: 'border-purple-200 hover:border-purple-300',
      heroGradient: 'from-purple-600 to-violet-700',
      accentColor: 'text-purple-600',
      bgLight: 'bg-purple-50/70',
      description: 'Surveillance clinique rapprochée et attente de résultats.',
      roleInfo: 'Surveillance des paramètres, transmission ciblée, préparation des sorties/mutations.'
    }
  ],

  // Données de démonstration locales (utilisées si Supabase n'est pas encore configuré)
  DEMO_STAGIAIRES: [
    { id: 'demo-1', nom: 'Thomas Laurent', actif: true },
    { id: 'demo-2', nom: 'Camille Dubois', actif: true },
    { id: 'demo-3', nom: 'Maxime Bernard', actif: true },
    { id: 'demo-4', nom: 'Léa Martin', actif: true },
    { id: 'demo-5', nom: 'Alexandre Petit', actif: true },
    { id: 'demo-6', nom: 'Sarah Moreau', actif: true },
    { id: 'demo-7', nom: 'Hugo Simon', actif: true },
    { id: 'demo-8', nom: 'Manon Roux', actif: true },
    { id: 'demo-9', nom: 'Lucas Garcia', actif: true },
    { id: 'demo-10', nom: 'Emma Fournier', actif: true },
    { id: 'demo-11', nom: 'Julien Leroy', actif: true },
    { id: 'demo-12', nom: 'Chloé Guerin', actif: true },
    { id: 'demo-13', nom: 'Antoine Roux', actif: true },
    { id: 'demo-14', nom: 'Inès Bernard', actif: true },
    { id: 'demo-15', nom: 'Romain Michel', actif: true },
    { id: 'demo-16', nom: 'Nathan Lefevre', actif: true },
    { id: 'demo-17', nom: 'Clara Girard', actif: true },
    { id: 'demo-18', nom: 'Paul Mercier', actif: true },
    { id: 'demo-19', nom: 'Mathis David', actif: true },
    { id: 'demo-20', nom: 'Zoé Fontaine', actif: true }
  ]
};
