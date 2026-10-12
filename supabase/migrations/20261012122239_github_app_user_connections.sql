-- Each application user links an installation and chooses one repository for backups.
create table public.github_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  installation_id text not null check (installation_id ~ '^[0-9]+$'),
  installation_account_login text not null,
  repository_id text check (repository_id is null or repository_id ~ '^[0-9]+$'),
  repository_full_name text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (installation_id),
  check ((repository_id is null) = (repository_full_name is null))
);

-- Short-lived, one-use state binds the GitHub install and OAuth callbacks to a Supabase user.
create table public.github_install_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  installation_id text check (installation_id is null or installation_id ~ '^[0-9]+$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index github_install_states_expiry_idx on public.github_install_states(expires_at);
create index github_install_states_user_idx on public.github_install_states(user_id);

alter table public.github_connections enable row level security;
alter table public.github_install_states enable row level security;

-- These tables are only accessed from Edge Functions. No browser role can read or mutate them.
revoke all on table public.github_connections, public.github_install_states from public, anon, authenticated;
grant all on table public.github_connections, public.github_install_states to service_role;

-- Backup state is also server-managed; do not let clients spoof status or repository metadata.
drop policy if exists "owners manage backup state" on public.github_backup_state;
drop policy if exists "owners read backup state" on public.github_backup_state;
revoke all on table public.github_backup_state from public, anon, authenticated;
grant all on table public.github_backup_state to service_role;
