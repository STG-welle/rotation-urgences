-- ==============================================================================
-- CONFIGURATION DU DÉCLENCHEUR CRON AUTOMATIQUE (SUPABASE PG_CRON & PG_NET)
-- ==============================================================================
-- Ce script configure le déclenchement ponctuel du bot WhatsApp chaque dimanche 
-- à 19h00:00 PILE (Heure de Libreville, UTC+1).
--
-- Grâce à Supabase pg_cron + pg_net, l'API GitHub Actions (workflow_dispatch)
-- est appelée instantanément à 19h00:00, évitant ainsi la file d'attente
-- et les retards aléatoires de GitHub Actions.
--
-- À exécuter dans le "SQL Editor" de votre tableau de bord Supabase :
-- 👉 https://supabase.com/dashboard/project/ezpbmutbkuoudmyyozlr/sql
-- ==============================================================================

-- 1. Activer les extensions nécessaires
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- 2. Nettoyer les anciennes tâches cron si elles existent
do $$
begin
  if exists (select 1 from cron.job where jobname = 'envoi-planning-quotidien-whatsapp') then
    perform cron.unschedule('envoi-planning-quotidien-whatsapp');
  end if;
  if exists (select 1 from cron.job where jobname = 'declencheur-hebdo-planning-whatsapp') then
    perform cron.unschedule('declencheur-hebdo-planning-whatsapp');
  end if;
end;
$$;

-- 3. Programmer le Planning Hebdomadaire chaque Dimanche soir à 18h00 UTC = 19h00 Libreville
-- Syntaxe cron : minute(0) heure(18) jour(*) mois(*) jour_semaine(0 = Dimanche)
select cron.schedule(
  'declencheur-hebdo-planning-whatsapp',
  '0 18 * * 0', -- Chaque dimanche soir à 18h00 UTC pile (19h00 Libreville)
  $$
  select net.http_post(
    url := 'https://api.github.com/repos/STG-welle/rotation-urgences/actions/workflows/weekly-planning-screenshot.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer VOTRE_TOKEN_GITHUB',
      'Accept', 'application/vnd.github.v3+json',
      'User-Agent', 'Supabase-pg_net',
      'Content-Type', 'application/json'
    ),
    body := '{"ref": "main"}'::jsonb
  ) as request_id;
  $$
);

-- 4. Programmer le Petit Briefing du Jour : Mardi et Jeudi à 04h10 UTC = 05h10 Libreville
-- Syntaxe cron : minute(10) heure(4) jour(*) mois(*) jour_semaine(2,4 = Mardi et Jeudi)
select cron.schedule(
  'briefing-matin-mardi-jeudi',
  '10 4 * * 2,4',
  $$
  select net.http_post(
    url := 'https://ezpbmutbkuoudmyyozlr.supabase.co/functions/v1/daily-whatsapp-schedule',
    headers := jsonb_build_object(
      'Content-Type', 'application/json'
    ),
    body := '{"source": "pg_cron_briefing_tue_thu"}'::jsonb
  ) as request_id;
  $$
);

-- 5. Vérifier que les tâches sont bien programmées et actives
select jobid, jobname, schedule, active, command 
from cron.job;

-- ==============================================================================
-- TEST MANUEL IMMÉDIAT (Optionnel) :
-- Décommentez et exécutez le bloc ci-dessous pour vérifier que Supabase peut
-- déclencher GitHub Actions dès maintenant :
-- ==============================================================================
/*
select net.http_post(
  url := 'https://api.github.com/repos/STG-welle/rotation-urgences/actions/workflows/weekly-planning-screenshot.yml/dispatches',
  headers := jsonb_build_object(
    'Authorization', 'Bearer VOTRE_TOKEN_GITHUB',
    'Accept', 'application/vnd.github.v3+json',
    'User-Agent', 'Supabase-pg_net',
    'Content-Type', 'application/json'
  ),
  body := '{"ref": "main"}'::jsonb
);
*/
