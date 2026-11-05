-- Activates scheduled collection. NOT YET RUN OR TESTED against a real project (pg_cron/pg_net are not available in the build sandbox).
-- Run once in the Supabase SQL editor AFTER: migrations applied, `collect` function deployed, COLLECTOR_SECRET set as a function secret.
-- Replace the two placeholders. The secret goes into Supabase Vault, not into this file or the repo.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<PUT-THE-SAME-VALUE-AS-THE-COLLECTOR_SECRET-FUNCTION-SECRET>', 'dr_collector_secret');
select vault.create_secret('https://wgoiukbgrdyjvfpqaipp.supabase.co/functions/v1/collect', 'dr_collector_url');

-- Every 5 minutes: the function only works on sources that are due (per-source interval), and claims them atomically,
-- so overlapping ticks never run the same source twice.
select cron.schedule('dr-collect', '*/5 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'dr_collector_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-collector-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dr_collector_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
$job$);

-- To pause scheduled collection:  select cron.unschedule('dr-collect');
-- To make yourself an admin (manual sync + enable/disable buttons): 
--   insert into public.dr_admins (user_id) select id from auth.users where email = '<your email>';
