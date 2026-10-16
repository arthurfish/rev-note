-- A connection now stores one repository-scoped PAT encrypted by the Edge Function.
-- Users must reconnect because GitHub App installations cannot be converted into PATs.
drop table if exists public.github_install_states;
drop table if exists public.github_connections;

create table public.github_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token_ciphertext text not null,
  repository_full_name text not null check (repository_full_name ~ '^[^/[:space:]]+/[^/[:space:]]+$'),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.github_connections enable row level security;
revoke all on table public.github_connections from public, anon, authenticated;
grant select, insert, update, delete on table public.github_connections to service_role;

-- Existing backup state belongs to the old connection and must not claim a new repo is backed up.
delete from public.github_backup_state;
