-- ==============================================================================
-- CONFIGURATION DU DÉCLENCHEUR CRON AUTOMATIQUE (PG_CRON & PG_NET)
-- ==============================================================================
-- Ce script configure l'envoi automatique chaque matin du planning sur WhatsApp.
-- À exécuter dans le "SQL Editor" de votre tableau de bord Supabase :
-- https://supabase.com/dashboard/project/ezpbmutbkuoudmyyozlr/sql
-- ==============================================================================

-- 1. Activer les extensions indispensables
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- 2. Supprimer l'ancienne tâche si elle existait déjà
do $$
begin
  if exists (select 1 from cron.job where jobname = 'envoi-planning-quotidien-whatsapp') then
    perform cron.unschedule('envoi-planning-quotidien-whatsapp');
  end if;
end;
$$;

-- 3. Programmer l'exécution quotidienne chaque nuit à Minuit (00h00 Heure de Libreville, UTC+1)
-- 00h00 heure locale à Libreville = 23h00 UTC
-- Syntax cron : minute heure jour mois jour_semaine
select cron.schedule(
  'envoi-planning-quotidien-whatsapp',
  '0 23 * * *', -- Tous les soirs à 23h00 UTC (00h00 / Minuit pile à Libreville)
  $$
  select net.http_post(
    -- URL de votre Edge Function Supabase
    url := 'https://ezpbmutbkuoudmyyozlr.supabase.co/functions/v1/daily-whatsapp-schedule',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_U7-ao4uwjTorXXLeCyClBA_ZkytQqmE'
    ),
    body := '{"source": "pg_cron_daily"}'::jsonb
  ) as request_id;
  $$
);

-- 4. Pour tester immédiatement sans attendre demain 06h00 :
-- Décommentez et exécutez la ligne ci-dessous :
/*
select net.http_post(
  url := 'https://ezpbmutbkuoudmyyozlr.supabase.co/functions/v1/daily-whatsapp-schedule',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer sb_publishable_U7-ao4uwjTorXXLeCyClBA_ZkytQqmE'
  ),
  body := '{"source": "test_manuel"}'::jsonb
);
*/

-- 5. Vérifier que la tâche est bien programmée
select jobid, jobname, schedule, command, active from cron.job where jobname = 'envoi-planning-quotidien-whatsapp';
