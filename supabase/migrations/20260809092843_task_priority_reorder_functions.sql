-- Priority values are written by complete-order RPCs. Each call locks its
-- project row before validating or updating anything, so two reorder requests
-- for the same project cannot interleave and leave a partial order behind.
--
-- The arrays contain every non-deleted, non-Done task in the affected category.
-- Done tasks are display-only in the Tasks page, so their existing priority is
-- deliberately left untouched. Category names are normalized the same way as
-- the priority indexes: trimmed empty text is Uncategorized (NULL).

create or replace function public.reorder_tasks_in_category (
  p_project_id   uuid,
  p_category_name text,
  p_task_ids     uuid[]
)
  returns void
  language plpgsql
  security invoker
  set search_path to 'public'
  as $function$
declare
  normalized_category text;
  expected_count bigint;
  project_locked boolean;
  task_ids uuid[] := coalesce(p_task_ids, '{}'::uuid[]);
begin
  normalized_category := nullif(btrim(p_category_name), '');

  select true
  into project_locked
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception 'project not found';
  end if;

  if coalesce(public.project_role(p_project_id), '') not in ('owner', 'editor') then
    raise exception 'forbidden';
  end if;

  if exists (
    select 1
    from unnest(task_ids) as requested(task_id)
    where requested.task_id is null
  ) then
    raise exception 'invalid task order';
  end if;

  if exists (
    select 1
    from unnest(task_ids) as requested(task_id)
    group by requested.task_id
    having count(*) > 1
  ) then
    raise exception 'invalid task order';
  end if;

  select count(*)
  into expected_count
  from public.tasks as task
  where task.project_id = p_project_id
    and task.deleted_at is null
    and task.status <> 'done'
    and nullif(btrim(task.category), '') is not distinct from normalized_category;

  if cardinality(task_ids) <> expected_count then
    raise exception 'invalid task order';
  end if;

  if exists (
    select 1
    from unnest(task_ids) as requested(task_id)
    where not exists (
      select 1
      from public.tasks as task
      where task.id = requested.task_id
        and task.project_id = p_project_id
        and task.deleted_at is null
        and task.status <> 'done'
        and nullif(btrim(task.category), '') is not distinct from normalized_category
    )
  ) then
    raise exception 'invalid task order';
  end if;

  update public.tasks as task
  set priority_position = ordered.position - 1
  from unnest(task_ids) with ordinality as ordered(task_id, position)
  where task.id = ordered.task_id;
end;
$function$;

create or replace function public.move_task_to_category (
  p_project_id            uuid,
  p_task_id               uuid,
  p_source_category       text,
  p_destination_category  text,
  p_source_task_ids       uuid[],
  p_destination_task_ids  uuid[]
)
  returns void
  language plpgsql
  security invoker
  set search_path to 'public'
  as $function$
declare
  normalized_source_category text;
  normalized_destination_category text;
  task_project_id uuid;
  task_category text;
  task_status text;
  task_deleted_at timestamptz;
  expected_source_count bigint;
  expected_destination_count bigint;
  source_task_ids uuid[] := coalesce(p_source_task_ids, '{}'::uuid[]);
  destination_task_ids uuid[] := coalesce(p_destination_task_ids, '{}'::uuid[]);
  project_locked boolean;
begin
  normalized_source_category := nullif(btrim(p_source_category), '');
  normalized_destination_category := nullif(btrim(p_destination_category), '');

  if (normalized_source_category is not null and char_length(normalized_source_category) > 100)
    or (normalized_destination_category is not null and char_length(normalized_destination_category) > 100) then
    raise exception 'invalid task move';
  end if;

  select true
  into project_locked
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception 'project not found';
  end if;

  if coalesce(public.project_role(p_project_id), '') not in ('owner', 'editor') then
    raise exception 'forbidden';
  end if;

  if normalized_source_category is not distinct from normalized_destination_category then
    raise exception 'source and destination categories must differ';
  end if;

  select task.project_id, nullif(btrim(task.category), ''), task.status, task.deleted_at
  into task_project_id, task_category, task_status, task_deleted_at
  from public.tasks as task
  where task.id = p_task_id
  for update;

  if not found
    or task_project_id is distinct from p_project_id
    or task_category is distinct from normalized_source_category then
    raise exception 'invalid task move';
  end if;

  if task_deleted_at is not null or task_status = 'done' then
    raise exception 'invalid task move';
  end if;

  if exists (
    select 1
    from unnest(source_task_ids) as requested(task_id)
    where requested.task_id is null
  )
  or exists (
    select 1
    from unnest(destination_task_ids) as requested(task_id)
    where requested.task_id is null
  ) then
    raise exception 'invalid task move';
  end if;

  if exists (
    select 1
    from unnest(source_task_ids) as requested(task_id)
    group by requested.task_id
    having count(*) > 1
  )
  or exists (
    select 1
    from unnest(destination_task_ids) as requested(task_id)
    group by requested.task_id
    having count(*) > 1
  ) then
    raise exception 'invalid task move';
  end if;

  if exists (
    select 1
    from unnest(source_task_ids) as source_task(task_id)
    join unnest(destination_task_ids) as destination_task(task_id)
      on destination_task.task_id = source_task.task_id
  )
  or p_task_id = any(source_task_ids)
  or not (p_task_id = any(destination_task_ids)) then
    raise exception 'invalid task move';
  end if;

  select count(*)
  into expected_source_count
  from public.tasks as task
  where task.project_id = p_project_id
    and task.id <> p_task_id
    and task.deleted_at is null
    and task.status <> 'done'
    and nullif(btrim(task.category), '') is not distinct from normalized_source_category;

  select count(*) + 1
  into expected_destination_count
  from public.tasks as task
  where task.project_id = p_project_id
    and task.deleted_at is null
    and task.status <> 'done'
    and nullif(btrim(task.category), '') is not distinct from normalized_destination_category;

  if cardinality(source_task_ids) <> expected_source_count
    or cardinality(destination_task_ids) <> expected_destination_count then
    raise exception 'invalid task move';
  end if;

  if exists (
    select 1
    from unnest(source_task_ids) as requested(task_id)
    where not exists (
      select 1
      from public.tasks as task
      where task.id = requested.task_id
        and task.project_id = p_project_id
        and task.id <> p_task_id
        and task.deleted_at is null
        and task.status <> 'done'
        and nullif(btrim(task.category), '') is not distinct from normalized_source_category
    )
  )
  or exists (
    select 1
    from unnest(destination_task_ids) as requested(task_id)
    where requested.task_id <> p_task_id
      and not exists (
        select 1
        from public.tasks as task
        where task.id = requested.task_id
          and task.project_id = p_project_id
          and task.deleted_at is null
          and task.status <> 'done'
          and nullif(btrim(task.category), '') is not distinct from normalized_destination_category
      )
  ) then
    raise exception 'invalid task move';
  end if;

  update public.tasks
  set category = normalized_destination_category
  where id = p_task_id;

  update public.tasks as task
  set priority_position = ordered.position - 1
  from unnest(source_task_ids) with ordinality as ordered(task_id, position)
  where task.id = ordered.task_id;

  update public.tasks as task
  set priority_position = ordered.position - 1
  from unnest(destination_task_ids) with ordinality as ordered(task_id, position)
  where task.id = ordered.task_id;
end;
$function$;

create or replace function public.reorder_task_categories (
  p_project_id      uuid,
  p_category_names  text[]
)
  returns void
  language plpgsql
  security invoker
  set search_path to 'public'
  as $function$
declare
  expected_count bigint;
  category_names text[] := coalesce(p_category_names, '{}'::text[]);
  project_locked boolean;
begin
  select true
  into project_locked
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception 'project not found';
  end if;

  if coalesce(public.project_role(p_project_id), '') not in ('owner', 'editor') then
    raise exception 'forbidden';
  end if;

  if exists (
    select 1
    from (
      select nullif(btrim(requested.category_name), '') as category_name
      from unnest(category_names) as requested(category_name)
    ) as normalized
    group by normalized.category_name
    having count(*) > 1
  ) then
    raise exception 'invalid category order';
  end if;

  if exists (
    select 1
    from unnest(category_names) as requested(category_name)
    where requested.category_name is not null
      and char_length(btrim(requested.category_name)) > 100
  ) then
    raise exception 'invalid category order';
  end if;

  select count(*)
  into expected_count
  from (
    select distinct nullif(btrim(task.category), '') as category_name
    from public.tasks as task
    where task.project_id = p_project_id
      and task.deleted_at is null
      and task.status <> 'done'
  ) as categories;

  if cardinality(category_names) <> expected_count then
    raise exception 'invalid category order';
  end if;

  if exists (
    select 1
    from (
      select nullif(btrim(requested.category_name), '') as category_name
      from unnest(category_names) as requested(category_name)
    ) as requested
    where not exists (
      select 1
      from public.tasks as task
      where task.project_id = p_project_id
        and task.deleted_at is null
        and task.status <> 'done'
        and nullif(btrim(task.category), '') is not distinct from requested.category_name
    )
  ) then
    raise exception 'invalid category order';
  end if;

  insert into public.task_category_positions (project_id, category_name, priority_position)
  select p_project_id, normalized.category_name, 0
  from (
    select distinct nullif(btrim(requested.category_name), '') as category_name
    from unnest(category_names) as requested(category_name)
  ) as normalized
  where not exists (
    select 1
    from public.task_category_positions as position
    where position.project_id = p_project_id
      and position.category_name is not distinct from normalized.category_name
  )
  on conflict do nothing;

  with ordered as (
    select
      nullif(btrim(requested.category_name), '') as category_name,
      requested.position
    from unnest(category_names) with ordinality as requested(category_name, position)
  )
  update public.task_category_positions as position
  set priority_position = ordered.position - 1
  from ordered
  where position.project_id = p_project_id
    and position.category_name is not distinct from ordered.category_name;
end;
$function$;

revoke execute on function public.reorder_tasks_in_category(uuid, text, uuid[]) from public;
revoke execute on function public.move_task_to_category(uuid, uuid, text, text, uuid[], uuid[]) from public;
revoke execute on function public.reorder_task_categories(uuid, text[]) from public;

grant execute on function public.reorder_tasks_in_category(uuid, text, uuid[]) to authenticated, service_role;
grant execute on function public.move_task_to_category(uuid, uuid, text, text, uuid[], uuid[]) to authenticated, service_role;
grant execute on function public.reorder_task_categories(uuid, text[]) to authenticated, service_role;
