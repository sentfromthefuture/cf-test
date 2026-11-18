-- Enable the Blueprint engine to use the shared AI cache, health circuit breaker,
-- and per-engine usage counters. This only widens the existing task/engine allowlists;
-- it does not change rows, cache behavior, quotas, or any Gemini PRD accounting.

alter table public.dr_ai_cache
  drop constraint if exists dr_ai_cache_task_check,
  add constraint dr_ai_cache_task_check
    check (task in ('decisions', 'summary', 'blueprint'));

alter table public.dr_ai_health
  drop constraint if exists dr_ai_health_task_check,
  add constraint dr_ai_health_task_check
    check (task in ('decisions', 'summary', 'blueprint'));

alter table public.dr_ai_usage
  drop constraint if exists dr_ai_usage_engine_check,
  add constraint dr_ai_usage_engine_check
    check (engine in ('decisions', 'summary', 'blueprint'));
