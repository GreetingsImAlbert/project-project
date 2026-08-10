-- Task 11: reserve one import attempt per importer/archive and reuse the
-- resulting project when a request is retried after a successful commit.

create table if not exists public.project_imports (
  importer_id uuid not null references public.profiles(id) on delete cascade,
  import_token text not null check (
    import_token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or import_token ~ '^[0-9a-f]{64}$'
  ),
  project_id uuid references public.projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (importer_id, import_token)
);

alter table public.project_imports enable row level security;

revoke all on table public.project_imports from public, anon, authenticated;
grant select on table public.project_imports to service_role;

create index if not exists project_imports_project_id_idx
on public.project_imports (project_id)
where project_id is not null;

-- The task 10 import_project function remains the atomic row inserter. This
-- wrapper reserves the token in the same transaction before calling it. A
-- concurrent insert waits on the primary key; once the first call commits, the
-- loser reads its project ID. If the first call fails, the reservation rolls
-- back and the retry can claim the token.
create or replace function public.import_project_once(
  p_importer_id uuid,
  p_import_token text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_existing_project_id uuid;
  v_project_id uuid;
begin
  if p_importer_id is null then
    raise exception 'invalid importer';
  end if;
  if p_import_token is null
    or (
      p_import_token !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and p_import_token !~ '^[0-9a-f]{64}$'
    ) then
    raise exception 'invalid import token';
  end if;

  insert into public.project_imports (importer_id, import_token)
  values (p_importer_id, p_import_token)
  on conflict (importer_id, import_token) do nothing;

  if not found then
    select project_id
      into v_existing_project_id
    from public.project_imports
    where importer_id = p_importer_id
      and import_token = p_import_token
    for update;

    if v_existing_project_id is null then
      raise exception 'project import is already in progress';
    end if;
    return v_existing_project_id;
  end if;

  v_project_id := public.import_project(p_importer_id, p_payload);

  update public.project_imports
  set project_id = v_project_id
  where importer_id = p_importer_id
    and import_token = p_import_token;

  return v_project_id;
end;
$function$;

revoke all on function public.import_project_once(uuid, text, jsonb) from public;
grant execute on function public.import_project_once(uuid, text, jsonb) to service_role;
