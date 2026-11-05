-- DemandRadar market-intelligence collection engine: schema (part 1 of 2)
-- Raw collected records are kept separate from processed signals and clusters.
-- All dr_* tables have RLS enabled with NO policies: the browser can only reach data through the
-- SECURITY DEFINER read functions defined in part 2; the collector uses the service role.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------- sources
create table public.dr_sources (
  id                       text primary key,
  name                     text not null,
  description              text,
  availability             text not null check (availability in ('implemented', 'skipped')),
  enabled                  boolean not null default false,
  interval_minutes         integer not null default 360 check (interval_minutes between 5 and 10080),
  config                   jsonb not null default '{}'::jsonb,
  cursor                   jsonb not null default '{}'::jsonb,
  status                   text not null default 'idle' check (status in ('idle', 'running', 'error', 'disabled', 'unavailable')),
  locked_until             timestamptz,
  last_run_at              timestamptz,
  last_success_at          timestamptz,
  next_run_at              timestamptz,
  last_error               text,
  last_error_at            timestamptz,
  consecutive_errors       integer not null default 0,
  records_total            bigint not null default 0,
  quota_limit              integer,
  quota_remaining          integer,
  quota_reset_at           timestamptz,
  license_note             text,
  skip_reason              text,
  access_restriction       text,
  official_api             boolean,
  integration_requirements text,
  docs_url                 text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create table public.dr_collection_runs (
  id          uuid primary key default gen_random_uuid(),
  source_id   text not null references public.dr_sources (id) on delete cascade,
  trigger     text not null check (trigger in ('schedule', 'manual')),
  status      text not null default 'running' check (status in ('running', 'success', 'partial', 'error')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  requests    integer not null default 0,
  fetched     integer not null default 0,
  inserted    integer not null default 0,
  updated     integer not null default 0,
  duplicates  integer not null default 0,
  errors      integer not null default 0,
  error       text,
  details     jsonb not null default '{}'::jsonb
);
create index dr_collection_runs_source_started_idx on public.dr_collection_runs (source_id, started_at desc);
create index dr_collection_runs_started_idx on public.dr_collection_runs (started_at desc);

create table public.dr_api_usage (
  source_id    text not null references public.dr_sources (id) on delete cascade,
  day          date not null default (now() at time zone 'utc')::date,
  requests     integer not null default 0,
  errors       integer not null default 0,
  rate_limited integer not null default 0,
  primary key (source_id, day)
);

-- Cross-invocation job locks (analysis / clustering must not run twice at once).
create table public.dr_job_locks (
  name         text primary key,
  locked_until timestamptz not null
);

create table public.dr_admins (
  user_id uuid primary key,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- raw records
create table public.dr_raw_records (
  id                      uuid primary key default gen_random_uuid(),
  source_id               text not null references public.dr_sources (id),
  source_record_id        text not null,
  discussion_key          text not null,              -- one thread = one discussion (a story and its comments share a key)
  kind                    text not null,              -- issue | story | comment | question
  url                     text not null,
  title                   text,
  excerpt                 text,                       -- permitted excerpt only (truncated by the connector), never the full dump
  author_ref              text,                       -- salted hash; no usernames stored
  parent_source_record_id text,
  published_at            timestamptz,
  updated_at_source       timestamptz,
  collected_at            timestamptz not null default now(),
  engagement              jsonb not null default '{}'::jsonb,
  categories              text[] not null default '{}',
  language                text,
  license                 text not null,
  attribution             text,
  content_hash            text not null,
  analysis_status         text not null default 'pending' check (analysis_status in ('pending', 'done', 'skipped', 'failed')),
  analysis_attempts       integer not null default 0,
  analyzed_hash           text,
  constraint dr_raw_records_source_unique unique (source_id, source_record_id)
);
create index dr_raw_records_pending_idx on public.dr_raw_records (collected_at) where analysis_status = 'pending';
create index dr_raw_records_source_published_idx on public.dr_raw_records (source_id, published_at desc);
create index dr_raw_records_collected_idx on public.dr_raw_records (collected_at desc);
create index dr_raw_records_discussion_idx on public.dr_raw_records (discussion_key);

-- ---------------------------------------------------------------- clusters + signals
create table public.dr_clusters (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null,
  industry            text,
  use_case            text,
  centroid            extensions.vector(768),          -- running SUM of unit-length member embeddings (cosine distance is scale-free)
  members_count       integer not null default 0,
  unique_discussions  integer not null default 0,
  source_count        integer not null default 0,
  sources             text[] not null default '{}',
  source_first_seen   jsonb not null default '{}'::jsonb,
  spreading           boolean not null default false,
  engagement_total    bigint not null default 0,
  first_seen_at       timestamptz,
  last_seen_at        timestamptz,
  recent_discussions  integer not null default 0,      -- unique discussions published in the last 30 days
  prior_discussions   integer not null default 0,      -- ... in the 30 days before that
  growth_rate         numeric,                         -- null = insufficient data
  severity_avg        numeric,                         -- AI ESTIMATE (1-5)
  wtp_signals         integer not null default 0,
  competitors         jsonb not null default '{}'::jsonb,
  scores              jsonb not null default '{}'::jsonb,
  composite_score     numeric,
  confidence          text not null default 'low' check (confidence in ('low', 'medium', 'high')),
  summary             jsonb,                           -- AI-generated narrative, labelled as such
  summary_dirty       boolean not null default true,
  summarized_at       timestamptz,
  stats_dirty         boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index dr_clusters_centroid_idx on public.dr_clusters using hnsw (centroid extensions.vector_cosine_ops);
create index dr_clusters_title_trgm_idx on public.dr_clusters using gin (title extensions.gin_trgm_ops);
create index dr_clusters_score_idx on public.dr_clusters (composite_score desc nulls last);
create index dr_clusters_dirty_idx on public.dr_clusters (updated_at) where stats_dirty;

create table public.dr_problem_signals (
  record_id         uuid primary key references public.dr_raw_records (id) on delete cascade,
  analysis_method   text not null check (analysis_method in ('llm', 'heuristic')),
  model             text,
  is_problem        boolean not null,
  signal_type       text not null check (signal_type in ('complaint', 'feature_request', 'unmet_need', 'question', 'other')),
  problem_statement text,
  industry          text,
  use_case          text,
  severity          smallint check (severity between 1 and 5),   -- AI ESTIMATE
  wtp_evidence      boolean not null default false,
  wtp_quote         text,
  competitors       text[] not null default '{}',
  language          text,
  embedding         extensions.vector(768),
  cluster_id        uuid references public.dr_clusters (id) on delete set null,
  analyzed_at       timestamptz not null default now()
);
create index dr_problem_signals_cluster_idx on public.dr_problem_signals (cluster_id);
create index dr_problem_signals_problem_idx on public.dr_problem_signals (analyzed_at desc) where is_problem;

create table public.dr_cluster_members (
  cluster_id uuid not null references public.dr_clusters (id) on delete cascade,
  record_id  uuid not null unique references public.dr_raw_records (id) on delete cascade,
  similarity real,
  created_at timestamptz not null default now(),
  primary key (cluster_id, record_id)
);

-- ---------------------------------------------------------------- lock everything down
alter table public.dr_sources enable row level security;
alter table public.dr_collection_runs enable row level security;
alter table public.dr_api_usage enable row level security;
alter table public.dr_job_locks enable row level security;
alter table public.dr_admins enable row level security;
alter table public.dr_raw_records enable row level security;
alter table public.dr_clusters enable row level security;
alter table public.dr_problem_signals enable row level security;
alter table public.dr_cluster_members enable row level security;

revoke all on public.dr_sources, public.dr_collection_runs, public.dr_api_usage, public.dr_job_locks,
  public.dr_admins, public.dr_raw_records, public.dr_clusters, public.dr_problem_signals,
  public.dr_cluster_members from anon, authenticated;

-- ---------------------------------------------------------------- source registry seed
-- Implemented connectors (official public APIs). They are seeded enabled but only run once the
-- scheduler is activated (supabase/cron.sql) or an admin triggers a manual sync.
insert into public.dr_sources
  (id, name, description, availability, enabled, interval_minutes, config, license_note, official_api, docs_url)
values
  ('github', 'GitHub', 'Public issues: feature requests, enhancement threads and "wish there was" reports (GitHub REST search API).',
   'implemented', true, 180,
   '{"per_page":100,"max_pages":3,"lookback_days":30,"queries":[
      {"id":"feature-requests","q":"is:issue is:open label:\"feature request\" reactions:>=3"},
      {"id":"enhancements","q":"is:issue is:open label:enhancement comments:>=8"},
      {"id":"wish","q":"is:issue is:open \"wish there was\" in:title,body"},
      {"id":"alternatives","q":"is:issue \"looking for an alternative\" in:title,body comments:>=2"}]}'::jsonb,
   'User-generated content owned by its authors; repository licences vary. Only title + short excerpt stored, with link back. Review GitHub Terms (API + Acceptable Use) before redistributing.',
   true, 'https://docs.github.com/en/rest'),
  ('hackernews', 'Hacker News', 'Ask/Top/Show stories and top-level comments from the official Hacker News Firebase API.',
   'implemented', true, 120,
   '{"lists":["askstories","topstories","showstories"],"list_limit":150,"min_score":5,"comment_story_min_descendants":8,"comments_per_story":12,"concurrency":6,"batch_size":24}'::jsonb,
   'User-contributed content (c) respective authors; API provided by Y Combinator. Excerpts + link back only; no bulk redistribution. Check YC terms before commercial redistribution.',
   true, 'https://github.com/HackerNews/API'),
  ('stackexchange', 'Stack Exchange', 'Questions asking for tools, alternatives and workflows from selected Stack Exchange sites (official API v2.3).',
   'implemented', true, 360,
   '{"pagesize":50,"max_pages":2,"lookback_days":14,"targets":[
      {"id":"softwarerecs","site":"softwarerecs","mode":"questions"},
      {"id":"webapps","site":"webapps","mode":"questions"},
      {"id":"softwareengineering-tools","site":"softwareengineering","mode":"search","q":"is there a tool"},
      {"id":"serverfault-tools","site":"serverfault","mode":"search","q":"is there a tool"},
      {"id":"stackoverflow-alternatives","site":"stackoverflow","mode":"search","q":"alternative to"}]}'::jsonb,
   'Content is CC BY-SA (2.5/3.0/4.0 depending on post date). Attribution (author, link, licence) is stored per record and must be shown wherever excerpts are displayed.',
   true, 'https://api.stackexchange.com/docs');

insert into public.dr_sources
  (id, name, description, availability, enabled, status, skip_reason, access_restriction, official_api, integration_requirements, docs_url)
values
  ('google_trends', 'Google Trends',
   'Rising search interest and emerging topics.', 'skipped', false, 'unavailable',
   'No publicly available, permitted API. The only unofficial access paths (pytrends-style libraries, reverse-engineered trends.google.com endpoints) are not an official Google API and are not an authorised collection method.',
   'Official Google Trends API is an alpha limited to approved testers (announced July 2025); access is by application.',
   true,
   'Apply for the Google Trends API alpha, obtain credentials from Google, then add a connector that reads the official API with those credentials. Do not use unofficial libraries or scrape the Trends site.',
   'https://trends.google.com/trends/'),
  ('reddit', 'Reddit',
   'Subreddit discussions about problems and tools.', 'skipped', false, 'unavailable',
   'Reddit Data API requires explicit prior approval under the Responsible Builder Policy, and commercial use needs written approval and a contract. DemandRadar is a commercial product, so this integration is not authorised yet. No scraping or workaround is used.',
   'Approval-gated OAuth API; commercial use requires a separate written agreement.',
   true,
   'Submit a Data API access request describing the commercial use, obtain written approval/contract, then configure OAuth credentials as server-side secrets and add a connector.',
   'https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data'),
  ('producthunt', 'Product Hunt',
   'Product launches and maker discussions.', 'skipped', false, 'unavailable',
   'Product Hunt API v2 states it must not be used for commercial purposes without permission. DemandRadar is commercial.',
   'OAuth/developer-token GraphQL API; commercial use requires permission from Product Hunt (hello@producthunt.com).',
   true,
   'Obtain written commercial permission from Product Hunt, create an application, store its token as a server-side secret, then add a GraphQL connector.',
   'https://api.producthunt.com/v2/docs'),
  ('kaggle', 'Kaggle',
   'Public datasets (market/consumer data).', 'skipped', false, 'unavailable',
   'Not implemented in this release: Kaggle datasets are not discussions that contain problem statements, each dataset carries its own licence (some prohibit commercial use or redistribution), and the API needs an account token.',
   'Official Kaggle API requires an authenticated account API token; per-dataset licences vary.',
   true,
   'Create a Kaggle API token (server-side secret), maintain an allow-list of datasets whose licences permit commercial use, and add a connector that downloads only allow-listed datasets for enrichment (e.g. market sizing), not problem mining.',
   'https://www.kaggle.com/docs/api'),
  ('opendata', 'Government open data',
   'Economic, business and industry datasets from open-data portals (configurable per country).', 'skipped', false, 'unavailable',
   'Not implemented in this release: legitimate APIs exist (CKAN portals, World Bank API), but these are statistical datasets, not problem discussions. They are better used later as a demand-sizing enrichment layer.',
   'Mostly open, key-free APIs; licences are dataset-specific (often CC BY / OGL) and must be recorded per dataset.',
   true,
   'Add a configurable CKAN / World Bank connector with a per-dataset licence allow-list and store indicators in a separate enrichment table.',
   'https://data.worldbank.org/');
