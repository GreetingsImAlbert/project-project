-- Public visibility is deliberately section-scoped. Existing projects stay
-- private for the new sections because every column is non-null and defaults
-- to false.
alter table public.projects
  add column public_tasks_enabled boolean default false not null,
  add column public_journal_enabled boolean default false not null,
  add column public_money_enabled boolean default false not null;

create index projects_public_tasks_enabled_idx
  on public.projects (public_tasks_enabled)
  where public_tasks_enabled;

create index projects_public_journal_enabled_idx
  on public.projects (public_journal_enabled)
  where public_journal_enabled;

create index projects_public_money_enabled_idx
  on public.projects (public_money_enabled)
  where public_money_enabled;

-- The return type changes as the public navigation contract grows, so these
-- functions must be dropped before being recreated. They remain SECURITY
-- DEFINER boundaries: callers can learn only the explicitly selected public
-- metadata, never the projects table through an anonymous SELECT policy.
drop function if exists public.public_project_get(uuid);

create function public.public_project_get (
  p_id uuid
)
returns table (
  id                     uuid,
  name                   text,
  description            text,
  is_public              boolean,
  public_files_enabled   boolean,
  public_tasks_enabled   boolean,
  public_journal_enabled boolean,
  public_money_enabled   boolean
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    p.id,
    p.name,
    p.description,
    p.is_public,
    p.public_files_enabled,
    p.public_tasks_enabled,
    p.public_journal_enabled,
    p.public_money_enabled
  from public.projects p
  where p.id = p_id
    and p.is_public;
$function$;

revoke all on function public.public_project_get(uuid) from public;
grant execute on function public.public_project_get(uuid) to anon, authenticated, service_role;

drop function if exists public.public_project_list();

create function public.public_project_list()
returns table (
  id            uuid,
  name          text,
  description   text,
  landing_page  text
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    p.id,
    p.name,
    p.description,
    case
      when p.is_public then 'overview'
      when p.public_tasks_enabled then 'tasks'
      when p.public_files_enabled then 'files'
      when p.public_journal_enabled then 'journal'
      when p.public_money_enabled then 'money'
    end as landing_page
  from public.projects p
  where p.is_public
     or p.public_tasks_enabled
     or p.public_files_enabled
     or p.public_journal_enabled
     or p.public_money_enabled
  order by p.created_at desc;
$function$;

revoke all on function public.public_project_list() from public;
grant execute on function public.public_project_list() to anon, authenticated, service_role;
