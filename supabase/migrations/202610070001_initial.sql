-- RevNote's durable sync model: notes are identities, revisions are append-only facts.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;

create table if not exists public.notes (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  current_revision_id uuid,
  created_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'deleted')),
  deleted_at timestamptz,
  unique (id, owner_id)
);

create table if not exists public.note_revisions (
  id uuid primary key,
  note_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  parent_revision_id uuid,
  content text not null,
  captured_at timestamptz not null,
  timezone text not null,
  city text,
  device_type text check (device_type is null or device_type in ('desktop', 'laptop', 'phone', 'tablet', 'unknown')),
  os text check (os is null or os in ('windows', 'macos', 'linux', 'android', 'ios', 'unknown')),
  author_type text not null check (author_type in ('human', 'llm', 'program')),
  author_name text,
  server_created_at timestamptz not null default now(),
  unique (note_id, id),
  foreign key (note_id, owner_id) references public.notes(id, owner_id) on delete cascade,
  foreign key (note_id, parent_revision_id) references public.note_revisions(note_id, id)
);

alter table public.notes drop constraint if exists notes_current_revision_fk;
alter table public.notes add constraint notes_current_revision_fk
  foreign key (id, current_revision_id) references public.note_revisions(note_id, id)
  deferrable initially deferred;

create index if not exists note_revisions_note_time_idx on public.note_revisions(note_id, captured_at desc);
create index if not exists note_revisions_parent_idx on public.note_revisions(note_id, parent_revision_id);

create table if not exists public.note_user_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid not null,
  color text check (color is null or color in ('neutral', 'red', 'orange', 'yellow', 'green', 'blue', 'purple')),
  pinned boolean not null default false,
  primary key (user_id, note_id),
  foreign key (note_id, user_id) references public.notes(id, owner_id) on delete cascade
);

create table if not exists public.note_derived (
  note_id uuid not null,
  revision_id uuid not null,
  search_document tsvector,
  embedding extensions.vector(1536),
  language text,
  character_count integer,
  derived_at timestamptz,
  primary key (note_id, revision_id),
  foreign key (note_id, revision_id) references public.note_revisions(note_id, id) on delete cascade
);
create index if not exists note_derived_fts_idx on public.note_derived using gin(search_document);

-- server_seq is allocated by Postgres and is the only pull cursor clients rely on.
create table if not exists public.sync_events (
  server_seq bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_op_id uuid not null,
  note_id uuid not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  is_conflict boolean not null default false,
  created_at timestamptz not null default now(),
  unique (owner_id, client_op_id),
  foreign key (note_id, owner_id) references public.notes(id, owner_id) on delete cascade
);
create index if not exists sync_events_owner_seq_idx on public.sync_events(owner_id, server_seq);

-- Operational backup state; this is infrastructure metadata, not part of the Note domain.
create table if not exists public.github_backup_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  repository text not null,
  branch text not null,
  commit_sha text not null,
  last_backup_at timestamptz not null default now(),
  note_count integer not null default 0
);

alter table public.notes enable row level security;
alter table public.note_revisions enable row level security;
alter table public.note_user_preferences enable row level security;
alter table public.note_derived enable row level security;
alter table public.sync_events enable row level security;
alter table public.github_backup_state enable row level security;

drop policy if exists "owners read notes" on public.notes;
create policy "owners read notes" on public.notes for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists "owners read revisions" on public.note_revisions;
create policy "owners read revisions" on public.note_revisions for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists "owners manage preferences" on public.note_user_preferences;
drop policy if exists "owners read preferences" on public.note_user_preferences;
create policy "owners read preferences" on public.note_user_preferences for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "owners read derived" on public.note_derived;
create policy "owners read derived" on public.note_derived for select to authenticated using (
  exists (select 1 from public.notes n where n.id = note_derived.note_id and n.owner_id = (select auth.uid()))
);
drop policy if exists "owners read sync events" on public.sync_events;
create policy "owners read sync events" on public.sync_events for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists "owners manage backup state" on public.github_backup_state;
create policy "owners manage backup state" on public.github_backup_state for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create or replace function public.refresh_note_derived(p_note_id uuid, p_revision_id uuid, p_content text)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  insert into public.note_derived(note_id, revision_id, search_document, character_count, derived_at)
  values (p_note_id, p_revision_id, to_tsvector('simple', coalesce(p_content, '')), char_length(coalesce(p_content, '')), now())
  on conflict (note_id, revision_id) do update set
    search_document = excluded.search_document,
    character_count = excluded.character_count,
    derived_at = excluded.derived_at;
$$;

-- Clients cannot update revisions or write sync events directly. All writes pass through this idempotent command.
create or replace function public.push_note_operation(
  p_client_op_id uuid,
  p_event_type text,
  p_note_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_owner uuid := auth.uid();
  v_previous public.sync_events%rowtype;
  v_note jsonb;
  v_revision jsonb;
  v_context jsonb;
  v_device jsonb;
  v_author jsonb;
  v_parent uuid;
  v_current uuid;
  v_conflict boolean := false;
  v_seq bigint;
  v_status text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_client_op_id is null or p_note_id is null then raise exception 'Operation and note IDs are required'; end if;

  -- Serialize one owner's event allocation so a later pull cursor cannot skip an uncommitted lower sequence.
  perform pg_advisory_xact_lock(hashtextextended(v_owner::text, 0));
  select * into v_previous from public.sync_events where owner_id = v_owner and client_op_id = p_client_op_id;
  if found then
    return jsonb_build_object('serverSeq', v_previous.server_seq, 'isConflict', v_previous.is_conflict, 'duplicate', true);
  end if;

  if p_event_type = 'note.created' then
    v_note := p_payload->'note';
    v_revision := p_payload->'revision';
    if v_note is null or v_revision is null or (v_note->>'id')::uuid <> p_note_id or (v_revision->>'noteId')::uuid <> p_note_id then
      raise exception 'Invalid note.created payload';
    end if;
    insert into public.notes(id, owner_id, current_revision_id, created_at, status)
      values (p_note_id, v_owner, null, coalesce((v_note->>'createdAt')::timestamptz, now()), 'active');
    v_context := v_revision->'captureContext';
    v_device := v_context->'device';
    v_author := v_revision->'author';
    insert into public.note_revisions(id, note_id, owner_id, parent_revision_id, content, captured_at, timezone, city, device_type, os, author_type, author_name)
      values (
        (v_revision->>'id')::uuid, p_note_id, v_owner, null, coalesce(v_revision->>'content', ''),
        coalesce((v_context->'time'->>'datetime')::timestamptz, now()), coalesce(v_context->'time'->>'timezone', 'UTC'),
        v_context->'place'->>'city', v_device->>'type', v_device->>'os', coalesce(v_author->>'type', 'human'), v_author->>'name'
      );
    update public.notes set current_revision_id = (v_revision->>'id')::uuid where id = p_note_id and owner_id = v_owner;
    perform public.refresh_note_derived(p_note_id, (v_revision->>'id')::uuid, coalesce(v_revision->>'content', ''));

  elsif p_event_type = 'revision.created' then
    v_revision := p_payload->'revision';
    if v_revision is null or (v_revision->>'noteId')::uuid <> p_note_id then raise exception 'Invalid revision.created payload'; end if;
    select current_revision_id into v_current from public.notes where id = p_note_id and owner_id = v_owner for update;
    if not found then raise exception 'Note not found'; end if;
    v_parent := nullif(v_revision->>'parentRevisionId', '')::uuid;
    v_context := v_revision->'captureContext';
    v_device := v_context->'device';
    v_author := v_revision->'author';
    insert into public.note_revisions(id, note_id, owner_id, parent_revision_id, content, captured_at, timezone, city, device_type, os, author_type, author_name)
      values (
        (v_revision->>'id')::uuid, p_note_id, v_owner, v_parent, coalesce(v_revision->>'content', ''),
        coalesce((v_context->'time'->>'datetime')::timestamptz, now()), coalesce(v_context->'time'->>'timezone', 'UTC'),
        v_context->'place'->>'city', v_device->>'type', v_device->>'os', coalesce(v_author->>'type', 'human'), v_author->>'name'
      );
    if v_parent is not distinct from v_current then
      update public.notes set current_revision_id = (v_revision->>'id')::uuid where id = p_note_id and owner_id = v_owner;
    else
      v_conflict := true;
    end if;
    perform public.refresh_note_derived(p_note_id, (v_revision->>'id')::uuid, coalesce(v_revision->>'content', ''));

  elsif p_event_type in ('note.deleted', 'note.restored') then
    v_status := case when p_event_type = 'note.deleted' then 'deleted' else 'active' end;
    update public.notes set status = v_status, deleted_at = case when v_status = 'deleted' then now() else null end
      where id = p_note_id and owner_id = v_owner;
    if not found then raise exception 'Note not found'; end if;

  elsif p_event_type = 'revision.selected' then
    if p_payload->>'revisionId' is null then raise exception 'Revision ID is required'; end if;
    update public.notes n set current_revision_id = (p_payload->>'revisionId')::uuid
      where n.id = p_note_id and n.owner_id = v_owner
        and exists (select 1 from public.note_revisions r where r.id = (p_payload->>'revisionId')::uuid and r.note_id = p_note_id and r.owner_id = v_owner);
    if not found then raise exception 'Note or revision not found'; end if;

  elsif p_event_type = 'preference.changed' then
    insert into public.note_user_preferences(user_id, note_id, color, pinned)
      select v_owner, p_note_id, nullif(p_payload->'preference'->>'color', '')::text,
        coalesce((p_payload->'preference'->>'pinned')::boolean, false)
      where exists (select 1 from public.notes n where n.id = p_note_id and n.owner_id = v_owner)
    on conflict (user_id, note_id) do update set color = excluded.color, pinned = excluded.pinned;
    if not found then raise exception 'Note not found'; end if;

  else
    raise exception 'Unsupported event type: %', p_event_type;
  end if;

  select current_revision_id into v_current from public.notes where id = p_note_id and owner_id = v_owner;
  insert into public.sync_events(owner_id, client_op_id, note_id, event_type, payload, is_conflict)
    values (v_owner, p_client_op_id, p_note_id, p_event_type,
      p_payload || jsonb_build_object('serverCurrentRevisionId', v_current), v_conflict)
    returning server_seq into v_seq;
  return jsonb_build_object('serverSeq', v_seq, 'isConflict', v_conflict, 'duplicate', false);
end;
$$;

create or replace function public.pull_sync_events(p_after bigint default 0, p_limit integer default 200)
returns table(server_seq bigint, client_op_id uuid, note_id uuid, event_type text, payload jsonb, is_conflict boolean, created_at timestamptz)
language sql
stable
security definer
set search_path = public, auth
as $$
  select e.server_seq, e.client_op_id, e.note_id, e.event_type, e.payload, e.is_conflict, e.created_at
  from public.sync_events e
  where e.owner_id = auth.uid() and e.server_seq > greatest(p_after, 0)
  order by e.server_seq asc
  limit least(greatest(p_limit, 1), 500);
$$;

create or replace function public.search_current_notes(p_query text, p_limit integer default 50)
returns table(note_id uuid, revision_id uuid, content text, rank real, captured_at timestamptz)
language sql
stable
security invoker
set search_path = public, auth
as $$
  select n.id, r.id, r.content, ts_rank(d.search_document, websearch_to_tsquery('simple', p_query)), r.captured_at
  from public.notes n
  join public.note_revisions r on r.note_id = n.id and r.id = n.current_revision_id
  join public.note_derived d on d.note_id = n.id and d.revision_id = r.id
  where n.owner_id = auth.uid() and n.status = 'active'
    and d.search_document @@ websearch_to_tsquery('simple', p_query)
  order by ts_rank(d.search_document, websearch_to_tsquery('simple', p_query)) desc, r.captured_at desc
  limit least(greatest(p_limit, 1), 100);
$$;

revoke all on function public.push_note_operation(uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.push_note_operation(uuid, text, uuid, jsonb) to authenticated;
revoke all on function public.refresh_note_derived(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.pull_sync_events(bigint, integer) from public, anon;
grant execute on function public.pull_sync_events(bigint, integer) to authenticated;
revoke all on function public.search_current_notes(text, integer) from public, anon;
grant execute on function public.search_current_notes(text, integer) to authenticated;

-- Realtime is a wake-up hint. Clients always catch up through pull_sync_events(server_seq).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_events') then
    alter publication supabase_realtime add table public.sync_events;
  end if;
end;
$$;
