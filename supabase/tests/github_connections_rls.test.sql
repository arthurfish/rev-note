begin;
select plan(4);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.github_connections'::regclass),
  'GitHub connections have row-level security enabled'
);
select ok(
  not has_table_privilege('anon', 'public.github_connections', 'select')
    and not has_table_privilege('anon', 'public.github_connections', 'insert')
    and not has_table_privilege('anon', 'public.github_connections', 'update')
    and not has_table_privilege('anon', 'public.github_connections', 'delete'),
  'anon has no access to encrypted GitHub tokens'
);
select ok(
  not has_table_privilege('authenticated', 'public.github_connections', 'select')
    and not has_table_privilege('authenticated', 'public.github_connections', 'insert')
    and not has_table_privilege('authenticated', 'public.github_connections', 'update')
    and not has_table_privilege('authenticated', 'public.github_connections', 'delete'),
  'authenticated users have no direct access to encrypted GitHub tokens'
);
select ok(
  has_table_privilege('service_role', 'public.github_connections', 'select')
    and has_table_privilege('service_role', 'public.github_connections', 'insert')
    and has_table_privilege('service_role', 'public.github_connections', 'update')
    and has_table_privilege('service_role', 'public.github_connections', 'delete'),
  'Edge Functions can manage encrypted GitHub connections'
);

select * from finish();
rollback;
