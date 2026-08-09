-- Single aggregate for the staging site's shared R2 quota. Keep this security
-- invoker, like the existing storage aggregate functions: the service-role
-- client used by the Worker sees every file row, while an RLS-scoped client
-- would only see rows visible to its caller.
create or replace function public.global_storage_bytes()
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce(sum(f.size_bytes), 0)::bigint
  from files f;
$$;
