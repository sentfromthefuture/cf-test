-- Blueprint result persistence. Service-role only; no browser table access or public read policies.
create table public.dr_blueprints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cluster_id uuid not null references public.dr_clusters(id) on delete cascade,
  request_key_hash text not null check (request_key_hash ~ '^[a-f0-9]{64}$'),
  request_params jsonb not null,
  schema_version text not null,
  model text not null,
  config_version text not null,
  evidence_pack_sha256 text not null check (evidence_pack_sha256 ~ '^[a-f0-9]{64}$'),
  blueprint jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dr_blueprints_request_unique unique (user_id, cluster_id, request_key_hash)
);

create index dr_blueprints_user_updated_idx on public.dr_blueprints (user_id, updated_at desc);
create index dr_blueprints_cluster_updated_idx on public.dr_blueprints (cluster_id, updated_at desc);

alter table public.dr_blueprints enable row level security;
revoke all on public.dr_blueprints from anon, authenticated;
grant select, insert, update, delete on public.dr_blueprints to service_role;

comment on table public.dr_blueprints is
  'Completed backend-validated ProductBlueprintV1 results. Contains source-derived evidence metadata; service-role access only.';
