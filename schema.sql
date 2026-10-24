-- ==============================================================================
-- SCHEMA SUPABASE : Gestion de la Rotation Hebdomadaire des Stagiaires Infirmier(e)s
-- ==============================================================================
-- Ce script crée les tables, active les politiques de sécurité (RLS), configure
-- la synchronisation temps réel (Supabase Realtime) et insère 12 stagiaires d'exemple.
--
-- Instructions :
-- 1. Rendez-vous sur votre dashboard Supabase : https://supabase.com/dashboard
-- 2. Ouvrez votre projet, puis allez dans l'onglet "SQL Editor" (icône terminal à gauche).
-- 3. Cliquez sur "New query", collez l'intégralité de ce script et cliquez sur "Run".
-- ==============================================================================

-- 1. Table des Stagiaires
create table if not exists public.stagiaires (
    id uuid primary key default gen_random_uuid(),
    nom text not null,
    actif boolean not null default true,
    groupe text, -- 'A', 'B', 'C', 'D' ou null (auto-équilibré)
    created_at timestamptz not null default now()
);

-- Si votre table existe déjà, exécutez simplement cette ligne :
alter table public.stagiaires add column if not exists groupe text;

-- 2. Table de Configuration (enregistrement unique id = 1)
create table if not exists public.config (
    id int primary key default 1,
    date_debut_stage date not null default current_date,
    pin_code text not null default '1234',
    updated_at timestamptz not null default now()
);

-- 3. Configuration de la Sécurité Row Level Security (RLS)
-- Pour permettre à l'application web statique (GitHub Pages) de lire et mettre à jour
-- les données via la clé anonyme (anon key) sans exiger de compte utilisateur individuel :
alter table public.stagiaires enable row level security;
alter table public.config enable row level security;

drop policy if exists "Accès complet stagiaires" on public.stagiaires;
create policy "Accès complet stagiaires" on public.stagiaires
    for all using (true) with check (true);

drop policy if exists "Accès complet config" on public.config;
create policy "Accès complet config" on public.config
    for all using (true) with check (true);

-- 4. Activation de Supabase Realtime (Indispensable pour la synchro en direct)
-- Permet à tous les téléphones connectés d'observer instantanément les changements
-- de présence ou les ajouts/suppressions faits par le tuteur/admin.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'stagiaires') then
    alter publication supabase_realtime add table public.stagiaires;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'config') then
    alter publication supabase_realtime add table public.config;
  end if;
end;
$$;

-- 5. Données initiales (Configuration & 12 Stagiaires d'exemple)
-- Initialisation de la date de début de stage (Lundi de référence)
insert into public.config (id, date_debut_stage, pin_code)
values (1, '2026-10-19', '1234')
on conflict (id) do update set updated_at = now();

-- Insertion des 12 stagiaires d'exemple si la table est vide
insert into public.stagiaires (nom, actif)
select nom, actif from (
    values
        ('Thomas Laurent', true),
        ('Camille Dubois', true),
        ('Maxime Bernard', true),
        ('Léa Martin', true),
        ('Alexandre Petit', true),
        ('Sarah Moreau', true),
        ('Hugo Simon', true),
        ('Manon Roux', true),
        ('Lucas Garcia', true),
        ('Emma Fournier', true),
        ('Julien Leroy', true),
        ('Chloé Guerin', true),
        ('Antoine Roux', true),
        ('Inès Bernard', true),
        ('Romain Michel', true),
        ('Nathan Lefevre', true),
        ('Clara Girard', true),
        ('Paul Mercier', true),
        ('Mathis David', true),
        ('Zoé Fontaine', true)
) as data(nom, actif)
where not exists (select 1 from public.stagiaires limit 1);

-- 6. Vérification du résultat
select 'Configuration OK ! Stagiaires en base :' as status, count(*) as total_stagiaires from public.stagiaires;
