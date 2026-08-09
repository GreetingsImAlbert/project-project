-- Task priority is a zero-based position within the task's normalized category.
-- Position zero is the highest priority. Ties are allowed temporarily so future
-- reorder functions can rewrite a category in one transaction; callers use id as
-- the deterministic final tiebreaker until then.
alter table public.tasks
  add column if not exists priority_position bigint;

with ranked_tasks as (
  select
    id,
    row_number() over (
      partition by project_id, nullif(btrim(category), '')
      order by deadline asc nulls last, deadline_time asc, name asc, id
    ) - 1 as priority_position
  from public.tasks
)
update public.tasks as tasks
set priority_position = ranked_tasks.priority_position
from ranked_tasks
where tasks.id = ranked_tasks.id;

alter table public.tasks
  alter column priority_position set default 0,
  alter column priority_position set not null;

alter table public.tasks
  add constraint tasks_priority_position_nonnegative
  check (priority_position >= 0);

create index if not exists tasks_project_category_priority_idx
on public.tasks (project_id, (nullif(btrim(category), '')), priority_position, id);

-- Category names are free text on tasks, so this table deliberately does not
-- replace task_categories, which is only the project's colour override table.
-- A null category_name represents Uncategorized. Stale rows left behind after a
-- category is renamed or emptied are harmless, just like stale colour overrides.
create table if not exists public.task_category_positions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  category_name text,
  priority_position bigint not null default 0,
  created_at timestamptz not null default now(),
  constraint task_category_positions_name_valid check (
    category_name is null
    or (btrim(category_name) <> '' and char_length(category_name) <= 100)
  ),
  constraint task_category_positions_nonnegative check (priority_position >= 0)
);

-- PostgreSQL's regular unique constraint treats nulls as distinct. The expression
-- makes the single Uncategorized row unique per project without reserving a user-
-- visible category name as a sentinel.
create unique index if not exists task_category_positions_project_category_unique
on public.task_category_positions (project_id, (coalesce(category_name, '')));

create index if not exists task_category_positions_project_priority_idx
on public.task_category_positions (project_id, priority_position, id);

with categories as (
  select distinct
    project_id,
    nullif(btrim(category), '') as category_name
  from public.tasks
), ranked_categories as (
  select
    project_id,
    category_name,
    row_number() over (
      partition by project_id
      order by (category_name is null), category_name
    ) - 1 as priority_position
  from categories
)
insert into public.task_category_positions (project_id, category_name, priority_position)
select project_id, category_name, priority_position
from ranked_categories
on conflict do nothing;

alter table public.task_category_positions enable row level security;

drop policy if exists "project members can view task category positions" on public.task_category_positions;
create policy "project members can view task category positions"
on public.task_category_positions for select
using (public.is_project_member(project_id));

drop policy if exists "editors and owners can create task category positions" on public.task_category_positions;
create policy "editors and owners can create task category positions"
on public.task_category_positions for insert
with check (public.project_role(project_id) in ('owner', 'editor'));

drop policy if exists "editors and owners can update task category positions" on public.task_category_positions;
create policy "editors and owners can update task category positions"
on public.task_category_positions for update
using (public.project_role(project_id) in ('owner', 'editor'));

drop policy if exists "editors and owners can delete task category positions" on public.task_category_positions;
create policy "editors and owners can delete task category positions"
on public.task_category_positions for delete
using (public.project_role(project_id) in ('owner', 'editor'));

grant select, insert, update, delete
on table public.task_category_positions
to anon, authenticated, service_role;
