-- Keep the start moment parallel to the deadline's separate date/time columns.
-- Existing rows begin at midnight, preserving the old date-only behaviour.
alter table public.tasks
  add column if not exists start_time time without time zone not null default '00:00:00'::time without time zone;

-- Adding an RPC argument creates a PostgreSQL overload, so remove the old
-- signatures first instead of leaving an outdated callable path behind.
drop function if exists public.create_task_with_assignees(uuid, text, text, text, date, date, time without time zone, text, uuid[], uuid[]);
drop function if exists public.update_task_with_assignees(uuid, text, text, text, date, date, time without time zone, text, uuid[], uuid[], uuid[]);

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
  set search_path to 'public'
  as $function$
declare
  created_task_id uuid;
begin
  if coalesce(public.project_role(p_project_id), '') not in ('owner', 'editor') then
    raise exception 'forbidden';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) as requested(user_id)
    where not exists (
      select 1 from project_members pm
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
      select 1 from ghost_members gm
      where gm.project_id = p_project_id
      and gm.id = requested.ghost_member_id
    )
  ) then
    raise exception 'invalid task assignee';
  end if;

  insert into tasks (
    project_id, name, category, description, start_date, start_time, deadline, deadline_time, status
  )
  values (
    p_project_id, p_name, p_category, p_description, p_start_date, p_start_time,
    p_deadline, p_deadline_time, p_status
  )
  returning id into created_task_id;

  insert into task_assignees (task_id, user_id)
  select created_task_id, requested.user_id
  from unnest(coalesce(p_user_ids, '{}'::uuid[])) as requested(user_id);

  insert into task_assignees (task_id, ghost_member_id)
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
  set search_path to 'public'
  as $function$
declare
  task_project_id uuid;
begin
  select project_id into task_project_id
  from tasks
  where id = p_task_id
  for update;

  if not found then
    raise exception 'task not found';
  end if;

  if coalesce(public.project_role(task_project_id), '') not in ('owner', 'editor') then
    raise exception 'forbidden';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) as requested(user_id)
    where not exists (
      select 1 from project_members pm
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
      select 1 from ghost_members gm
      where gm.project_id = task_project_id
      and gm.id = requested.ghost_member_id
    )
  ) then
    raise exception 'invalid task assignee';
  end if;

  update tasks
  set name = p_name,
      category = p_category,
      description = p_description,
      start_date = p_start_date,
      start_time = p_start_time,
      deadline = p_deadline,
      deadline_time = p_deadline_time,
      status = p_status
  where id = p_task_id;

  delete from task_assignees ta
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

  insert into task_assignees (task_id, user_id)
  select p_task_id, requested.user_id
  from unnest(coalesce(p_user_ids, '{}'::uuid[])) as requested(user_id)
  where not exists (
    select 1 from task_assignees ta
    where ta.task_id = p_task_id
    and ta.user_id = requested.user_id
  )
  on conflict do nothing;

  insert into task_assignees (task_id, ghost_member_id)
  select p_task_id, requested.ghost_member_id
  from unnest(coalesce(p_ghost_member_ids, '{}'::uuid[])) as requested(ghost_member_id)
  where not exists (
    select 1 from task_assignees ta
    where ta.task_id = p_task_id
    and ta.ghost_member_id = requested.ghost_member_id
  )
  on conflict do nothing;
end;
$function$;

revoke all on function public.update_task_with_assignees(uuid, text, text, text, date, time without time zone, date, time without time zone, text, uuid[], uuid[], uuid[]) from public;
grant all on function public.update_task_with_assignees(uuid, text, text, text, date, time without time zone, date, time without time zone, text, uuid[], uuid[], uuid[]) to authenticated;
grant all on function public.update_task_with_assignees(uuid, text, text, text, date, time without time zone, date, time without time zone, text, uuid[], uuid[], uuid[]) to service_role;
