-- Normal task mutations keep the persisted ordering usable without asking the
-- client to calculate ranks. Every create/edit locks the project row first;
-- reorder RPCs use the same lock, so appending and dragging cannot interleave.
--
-- Category text is normalized at the boundary (trimmed empty text is NULL for
-- Uncategorized). A newly used category gets a position row at the bottom of
-- the project's existing category order. A new or re-categorized non-deleted
-- task gets the next position after the visible tasks in its destination. Edits
-- that only change fields/status, soft deletion, and restoration leave the
-- existing priority untouched.

create or replace function public.create_task_with_assignees (
  p_project_id       uuid,
  p_name             text,
  p_category         text,
  p_description      text,
  p_start_date       date,
  p_start_time       time without time zone,
  p_deadline         date,
  p_deadline_time    time without time zone,
  p_status           text,
  p_user_ids         uuid[],
  p_ghost_member_ids uuid[]
)
  returns uuid
  language plpgsql
  security invoker
  set search_path to 'public'
  as $function$
declare
  created_task_id uuid;
  locked_project_id uuid;
  normalized_category text;
  next_task_position bigint;
  next_category_position bigint;
begin
  normalized_category := nullif(btrim(p_category), '');

  select id
  into locked_project_id
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception 'project not found';
  end if;

  if coalesce(public.project_role(p_project_id), '') not in ('owner', 'editor') then
    raise exception 'forbidden';
  end if;

  if normalized_category is not null and char_length(normalized_category) > 100 then
    raise exception 'invalid category';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) as requested(user_id)
    where not exists (
      select 1 from public.project_members pm
      where pm.project_id = p_project_id
      and pm.user_id = requested.user_id
    )
  ) then
    raise exception 'invalid task assignee';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_ghost_member_ids, '{}'::uuid[])) as requested(ghost_member_id)
    where not exists (
      select 1 from public.ghost_members gm
      where gm.project_id = p_project_id
      and gm.id = requested.ghost_member_id
    )
  ) then
    raise exception 'invalid task assignee';
  end if;

  select coalesce(max(task.priority_position) + 1, 0)
  into next_task_position
  from public.tasks as task
  where task.project_id = p_project_id
    and task.deleted_at is null
    and nullif(btrim(task.category), '') is not distinct from normalized_category;

  select coalesce(max(position.priority_position) + 1, 0)
  into next_category_position
  from public.task_category_positions as position
  where position.project_id = p_project_id;

  insert into public.task_category_positions (project_id, category_name, priority_position)
  values (p_project_id, normalized_category, next_category_position)
  on conflict do nothing;

  insert into public.tasks (
    project_id, name, category, priority_position, description,
    start_date, start_time, deadline, deadline_time, status
  )
  values (
    p_project_id, p_name, normalized_category, next_task_position, p_description,
    p_start_date, p_start_time, p_deadline, p_deadline_time, p_status
  )
  returning id into created_task_id;

  insert into public.task_assignees (task_id, user_id)
  select created_task_id, requested.user_id
  from unnest(coalesce(p_user_ids, '{}'::uuid[])) as requested(user_id);

  insert into public.task_assignees (task_id, ghost_member_id)
  select created_task_id, requested.ghost_member_id
  from unnest(coalesce(p_ghost_member_ids, '{}'::uuid[])) as requested(ghost_member_id);

  return created_task_id;
end;
$function$;

revoke all on function public.create_task_with_assignees(uuid, text, text, text, date, time without time zone, date, time without time zone, text, uuid[], uuid[]) from public;
grant all on function public.create_task_with_assignees(uuid, text, text, text, date, time without time zone, date, time without time zone, text, uuid[], uuid[]) to authenticated;
grant all on function public.create_task_with_assignees(uuid, text, text, text, date, time without time zone, date, time without time zone, text, uuid[], uuid[]) to service_role;

create or replace function public.update_task_with_assignees (
  p_task_id                   uuid,
  p_name                      text,
  p_category                  text,
  p_description               text,
  p_start_date                date,
  p_start_time                time without time zone,
  p_deadline                  date,
  p_deadline_time             time without time zone,
  p_status                    text,
  p_user_ids                  uuid[],
  p_ghost_member_ids          uuid[],
  p_kept_deleted_assignee_ids uuid[]
)
  returns void
  language plpgsql
  security invoker
  set search_path to 'public'
  as $function$
declare
  task_project_id uuid;
  locked_project_id uuid;
  current_category text;
  current_deleted_at timestamptz;
  normalized_category text;
  category_changed boolean;
  next_task_position bigint;
  next_category_position bigint;
begin
  select project_id
  into task_project_id
  from public.tasks
  where id = p_task_id;

  if not found then
    raise exception 'task not found';
  end if;

  select id
  into locked_project_id
  from public.projects
  where id = task_project_id
  for update;

  if not found then
    raise exception 'project not found';
  end if;

  if coalesce(public.project_role(task_project_id), '') not in ('owner', 'editor') then
    raise exception 'forbidden';
  end if;

  normalized_category := nullif(btrim(p_category), '');
  if normalized_category is not null and char_length(normalized_category) > 100 then
    raise exception 'invalid category';
  end if;

  select nullif(btrim(task.category), ''), task.deleted_at
  into current_category, current_deleted_at
  from public.tasks as task
  where task.id = p_task_id
  for update;

  if not found then
    raise exception 'task not found';
  end if;

  category_changed := current_category is distinct from normalized_category;

  if category_changed and current_deleted_at is null then
    select coalesce(max(task.priority_position) + 1, 0)
    into next_task_position
    from public.tasks as task
    where task.project_id = task_project_id
      and task.id <> p_task_id
      and task.deleted_at is null
      and nullif(btrim(task.category), '') is not distinct from normalized_category;

    select coalesce(max(position.priority_position) + 1, 0)
    into next_category_position
    from public.task_category_positions as position
    where position.project_id = task_project_id;

    insert into public.task_category_positions (project_id, category_name, priority_position)
    values (task_project_id, normalized_category, next_category_position)
    on conflict do nothing;
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) as requested(user_id)
    where not exists (
      select 1 from public.project_members pm
      where pm.project_id = task_project_id
      and pm.user_id = requested.user_id
    )
  ) then
    raise exception 'invalid task assignee';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_ghost_member_ids, '{}'::uuid[])) as requested(ghost_member_id)
    where not exists (
      select 1 from public.ghost_members gm
      where gm.project_id = task_project_id
      and gm.id = requested.ghost_member_id
    )
  ) then
    raise exception 'invalid task assignee';
  end if;

  if category_changed and current_deleted_at is null then
    update public.tasks
    set name = p_name,
        category = normalized_category,
        priority_position = next_task_position,
        description = p_description,
        start_date = p_start_date,
        start_time = p_start_time,
        deadline = p_deadline,
        deadline_time = p_deadline_time,
        status = p_status
    where id = p_task_id;
  else
    update public.tasks
    set name = p_name,
        category = normalized_category,
        description = p_description,
        start_date = p_start_date,
        start_time = p_start_time,
        deadline = p_deadline,
        deadline_time = p_deadline_time,
        status = p_status
    where id = p_task_id;
  end if;

  delete from public.task_assignees as ta
  where ta.task_id = p_task_id
  and (
    (
      ta.user_id is not null
      and not (ta.user_id = any(coalesce(p_user_ids, '{}'::uuid[])))
    )
    or (
      ta.ghost_member_id is not null
      and not (ta.ghost_member_id = any(coalesce(p_ghost_member_ids, '{}'::uuid[])))
    )
    or (
      ta.user_id is null
      and ta.ghost_member_id is null
      and not (ta.id = any(coalesce(p_kept_deleted_assignee_ids, '{}'::uuid[])))
    )
  );

  insert into public.task_assignees (task_id, user_id)
  select p_task_id, requested.user_id
  from unnest(coalesce(p_user_ids, '{}'::uuid[])) as requested(user_id)
  where not exists (
    select 1 from public.task_assignees as ta
    where ta.task_id = p_task_id
    and ta.user_id = requested.user_id
  )
  on conflict do nothing;

  insert into public.task_assignees (task_id, ghost_member_id)
  select p_task_id, requested.ghost_member_id
  from unnest(coalesce(p_ghost_member_ids, '{}'::uuid[])) as requested(ghost_member_id)
  where not exists (
    select 1 from public.task_assignees as ta
    where ta.task_id = p_task_id
    and ta.ghost_member_id = requested.ghost_member_id
  )
  on conflict do nothing;
end;
$function$;

revoke all on function public.update_task_with_assignees(uuid, text, text, text, date, time without time zone, date, time without time zone, text, uuid[], uuid[], uuid[]) from public;
grant all on function public.update_task_with_assignees(uuid, text, text, text, date, time without time zone, date, time without time zone, text, uuid[], uuid[], uuid[]) to authenticated;
grant all on function public.update_task_with_assignees(uuid, text, text, text, date, time without time zone, date, time without time zone, text, uuid[], uuid[], uuid[]) to service_role;
