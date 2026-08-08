-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

SET check_function_bodies = false;

DROP EXTENSION IF EXISTS pg_net;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLES FROM anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE UPDATE ON SEQUENCES FROM anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLES FROM authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE UPDATE ON SEQUENCES FROM authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLES FROM service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE UPDATE ON SEQUENCES FROM service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO service_role;

CREATE FUNCTION public.can_edit_money (
  check_project_id uuid
)
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  select exists (
    select 1 from project_members
    where project_id = check_project_id
    and user_id = auth.uid()
    and (role = 'owner' or is_auditor)
  );
$function$;

CREATE FUNCTION public.create_bulk_transaction_with_lines (
  p_project_id       uuid,
  p_member_id        uuid,
  p_ghost_member_id  uuid,
  p_transaction_date date,
  p_label            text,
  p_total            numeric,
  p_supplier         text,
  p_item_url         text,
  p_lines            jsonb
)
  RETURNS uuid
  LANGUAGE plpgsql
  SET search_path TO 'public'
  AS $function$
declare
  parent_id uuid;
begin
  if not coalesce(public.can_edit_money(p_project_id), false) then
    raise exception 'forbidden';
  end if;

  if num_nonnulls(p_member_id, p_ghost_member_id) <> 1 then
    raise exception 'invalid transaction party';
  end if;

  if p_member_id is not null and not exists (
    select 1 from project_members
    where project_id = p_project_id and user_id = p_member_id
  ) then
    raise exception 'invalid transaction party';
  end if;

  if p_ghost_member_id is not null and not exists (
    select 1 from ghost_members
    where project_id = p_project_id and id = p_ghost_member_id
  ) then
    raise exception 'invalid transaction party';
  end if;

  if p_total is null or p_total < 0 then
    raise exception 'invalid transaction total';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid transaction items';
  end if;

  if jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 100 then
    raise exception 'invalid transaction items';
  end if;

  insert into transactions (
    project_id, member_id, ghost_member_id, related_member_id,
    related_ghost_member_id, group_id, transaction_date, type, item_name,
    quantity, unit, unit_cost, supplier, item_url
  )
  values (
    p_project_id, p_member_id, p_ghost_member_id, null,
    null, null, p_transaction_date, 'bulk', p_label,
    1, null, p_total, p_supplier, p_item_url
  )
  returning id into parent_id;

  insert into transactions (
    project_id, member_id, ghost_member_id, related_member_id,
    related_ghost_member_id, group_id, transaction_date, type, item_name,
    quantity, unit, unit_cost, supplier, item_url
  )
  select
    p_project_id, p_member_id, p_ghost_member_id, null,
    null, parent_id, p_transaction_date, line.type, line."itemName",
    line.quantity, line.unit, line."unitCost", line.supplier, line."itemUrl"
  from jsonb_to_recordset(p_lines) as line(
    type text,
    "itemName" text,
    quantity numeric,
    unit text,
    "unitCost" numeric,
    supplier text,
    "itemUrl" text
  );

  return parent_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.create_bulk_transaction_with_lines(uuid, uuid, uuid, date, text, numeric, text, text, jsonb) FROM PUBLIC;

GRANT ALL ON FUNCTION public.create_bulk_transaction_with_lines(uuid, uuid, uuid, date, text, numeric, text, text, jsonb) TO authenticated;

GRANT ALL ON FUNCTION public.create_bulk_transaction_with_lines(uuid, uuid, uuid, date, text, numeric, text, text, jsonb) TO service_role;

CREATE FUNCTION public.create_task_with_assignees (
  p_project_id       uuid,
  p_name             text,
  p_category         text,
  p_description      text,
  p_start_date       date,
  p_deadline         date,
  p_deadline_time    time without time zone,
  p_status           text,
  p_user_ids         uuid[],
  p_ghost_member_ids uuid[]
)
  RETURNS uuid
  LANGUAGE plpgsql
  SET search_path TO 'public'
  AS $function$
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
    project_id, name, category, description, start_date, deadline, deadline_time, status
  )
  values (
    p_project_id, p_name, p_category, p_description, p_start_date, p_deadline,
    p_deadline_time, p_status
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

REVOKE ALL ON FUNCTION public.create_task_with_assignees(uuid, text, text, text, date, date, time WITHOUT time zone, text, uuid[], uuid[]) FROM PUBLIC;

GRANT ALL ON FUNCTION public.create_task_with_assignees(uuid, text, text, text, date, date, time WITHOUT time zone, text, uuid[], uuid[]) TO authenticated;

GRANT ALL ON FUNCTION public.create_task_with_assignees(uuid, text, text, text, date, date, time WITHOUT time zone, text, uuid[], uuid[]) TO service_role;

CREATE FUNCTION public.forum_post_soft_delete_only()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $function$
begin
  if new.author_id is distinct from old.author_id
     or new.body is distinct from old.body
     or new.created_at is distinct from old.created_at
     or (old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at) then
    raise exception 'Forum posts can only be soft-deleted';
  end if;
  return new;
end;
$function$;

CREATE FUNCTION public.forum_reply_parent_is_valid()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $function$
begin
  if tg_op = 'INSERT' then
    if new.parent_reply_id is not null and not exists (
      select 1
      from public.forum_replies parent_reply
      where parent_reply.id = new.parent_reply_id
        and parent_reply.post_id = new.post_id
        and parent_reply.deleted_at is null
    ) then
      raise exception 'Forum reply parent must belong to the same active post';
    end if;
  elsif (
    new.parent_reply_id is distinct from old.parent_reply_id
    or new.post_id is distinct from old.post_id
  )
    and new.parent_reply_id is not null
    and not exists (
      select 1
      from public.forum_replies parent_reply
      where parent_reply.id = new.parent_reply_id
        and parent_reply.post_id = new.post_id
        and parent_reply.deleted_at is null
    ) then
    raise exception 'Forum reply parent must belong to the same active post';
  end if;

  return new;
end;
$function$;

CREATE FUNCTION public.forum_reply_soft_delete_only()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $function$
begin
  if new.post_id is distinct from old.post_id
     or new.parent_reply_id is distinct from old.parent_reply_id
     or new.author_id is distinct from old.author_id
     or new.body is distinct from old.body
     or new.created_at is distinct from old.created_at
     or (old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at) then
    raise exception 'Forum replies can only be soft-deleted';
  end if;
  return new;
end;
$function$;

CREATE FUNCTION public.global_storage_breakdown()
  RETURNS TABLE (
    uploaded_by uuid,
    project_id  uuid,
    total_bytes bigint
  )
  LANGUAGE sql
  STABLE
  SET search_path TO 'public'
  AS $function$
  select f.uploaded_by, f.project_id, coalesce(sum(f.size_bytes), 0)::bigint
  from files f
  group by f.uploaded_by, f.project_id;
$function$;

CREATE FUNCTION public.guard_member_role_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
begin
  if (new.role is distinct from old.role
      or new.is_auditor is distinct from old.is_auditor)
     and not exists (
       select 1 from public.projects
       where projects.id = new.project_id
       and projects.owner_id = auth.uid()
     )
  then
    raise exception 'Only the project owner can change member roles';
  end if;
  return new;
end;
$function$;

CREATE FUNCTION public.handle_new_project()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$function$;

CREATE FUNCTION public.handle_new_user()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  user_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('profiles_insert'));
  select count(*) into user_count from public.profiles;
  if user_count >= 10 then
    raise exception 'Signups are full';
  end if;
  insert into public.profiles (id, display_name, email)
  values (new.id, new.raw_user_meta_data->>'display_name', new.email);
  return new;
end;
$function$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

CREATE FUNCTION public.is_project_member (
  check_project_id uuid
)
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  select exists (
    select 1 from project_members
    where project_members.project_id = check_project_id
    and project_members.user_id = auth.uid()
  );
$function$;

CREATE FUNCTION public.project_role (
  check_project_id uuid
)
  RETURNS text
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  select role from project_members
  where project_id = check_project_id
  and user_id = auth.uid();
$function$;

CREATE FUNCTION public.project_storage_bytes (
  check_project_id uuid
)
  RETURNS bigint
  LANGUAGE sql
  STABLE
  SET search_path TO 'public'
  AS $function$
  select coalesce(sum(size_bytes), 0)::bigint
  from files where project_id = check_project_id;
$function$;

CREATE FUNCTION public.public_project_get (
  p_id uuid
)
  RETURNS TABLE (
    id                   uuid,
    name                 text,
    description          text,
    is_public            boolean,
    public_files_enabled boolean
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  select p.id, p.name, p.description, p.is_public, p.public_files_enabled
  from projects p
  where p.id = p_id
  and p.is_public;
$function$;

CREATE FUNCTION public.public_project_list()
  RETURNS TABLE (
    id          uuid,
    name        text,
    description text
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  select p.id, p.name, p.description
  from projects p
  where p.is_public or p.public_files_enabled
  order by p.created_at desc;
$function$;

REVOKE ALL ON FUNCTION public.public_project_list() FROM PUBLIC;

GRANT ALL ON FUNCTION public.public_project_list() TO anon;

GRANT ALL ON FUNCTION public.public_project_list() TO authenticated;

CREATE FUNCTION public.replace_bulk_transaction_with_lines (
  p_transaction_id   uuid,
  p_member_id        uuid,
  p_ghost_member_id  uuid,
  p_transaction_date date,
  p_label            text,
  p_total            numeric,
  p_supplier         text,
  p_item_url         text,
  p_lines            jsonb
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO 'public'
  AS $function$
declare
  transaction_project_id uuid;
begin
  select project_id into transaction_project_id
  from transactions
  where id = p_transaction_id
  and group_id is null
  and type = 'bulk'
  for update;

  if not found then
    raise exception 'bulk transaction not found';
  end if;

  if not coalesce(public.can_edit_money(transaction_project_id), false) then
    raise exception 'forbidden';
  end if;

  if num_nonnulls(p_member_id, p_ghost_member_id) <> 1 then
    raise exception 'invalid transaction party';
  end if;

  if p_member_id is not null and not exists (
    select 1 from project_members
    where project_id = transaction_project_id and user_id = p_member_id
  ) then
    raise exception 'invalid transaction party';
  end if;

  if p_ghost_member_id is not null and not exists (
    select 1 from ghost_members
    where project_id = transaction_project_id and id = p_ghost_member_id
  ) then
    raise exception 'invalid transaction party';
  end if;

  if p_total is null or p_total < 0 then
    raise exception 'invalid transaction total';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid transaction items';
  end if;

  if jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 100 then
    raise exception 'invalid transaction items';
  end if;

  update transactions
  set member_id = p_member_id,
      ghost_member_id = p_ghost_member_id,
      related_member_id = null,
      related_ghost_member_id = null,
      transaction_date = p_transaction_date,
      type = 'bulk',
      item_name = p_label,
      quantity = 1,
      unit = null,
      unit_cost = p_total,
      supplier = p_supplier,
      item_url = p_item_url
  where id = p_transaction_id;

  delete from transactions where group_id = p_transaction_id;

  insert into transactions (
    project_id, member_id, ghost_member_id, related_member_id,
    related_ghost_member_id, group_id, transaction_date, type, item_name,
    quantity, unit, unit_cost, supplier, item_url
  )
  select
    transaction_project_id, p_member_id, p_ghost_member_id, null,
    null, p_transaction_id, p_transaction_date, line.type, line."itemName",
    line.quantity, line.unit, line."unitCost", line.supplier, line."itemUrl"
  from jsonb_to_recordset(p_lines) as line(
    type text,
    "itemName" text,
    quantity numeric,
    unit text,
    "unitCost" numeric,
    supplier text,
    "itemUrl" text
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.replace_bulk_transaction_with_lines(uuid, uuid, uuid, date, text, numeric, text, text, jsonb) FROM PUBLIC;

GRANT ALL ON FUNCTION public.replace_bulk_transaction_with_lines(uuid, uuid, uuid, date, text, numeric, text, text, jsonb) TO authenticated;

GRANT ALL ON FUNCTION public.replace_bulk_transaction_with_lines(uuid, uuid, uuid, date, text, numeric, text, text, jsonb) TO service_role;

CREATE FUNCTION public.set_transaction_deleted (
  p_transaction_id uuid,
  p_deleted_at     timestamp with time zone
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO 'public'
  AS $function$
declare
  transaction_project_id uuid;
  transaction_group_id uuid;
begin
  select project_id, group_id
  into transaction_project_id, transaction_group_id
  from transactions
  where id = p_transaction_id
  for update;

  if not found then
    raise exception 'transaction not found';
  end if;

  if transaction_group_id is not null then
    raise exception 'bulk lines cannot be changed independently';
  end if;

  if not coalesce(public.can_edit_money(transaction_project_id), false) then
    raise exception 'forbidden';
  end if;

  if p_deleted_at is null then
    update transactions set deleted_at = null where id = p_transaction_id;
    update transactions set deleted_at = null where group_id = p_transaction_id;
  else
    update transactions set deleted_at = p_deleted_at where id = p_transaction_id;
    update transactions set deleted_at = p_deleted_at where group_id = p_transaction_id;
  end if;
end;
$function$;

REVOKE ALL ON FUNCTION public.set_transaction_deleted(uuid, timestamp WITH time zone) FROM PUBLIC;

GRANT ALL ON FUNCTION public.set_transaction_deleted(uuid, timestamp WITH time zone) TO authenticated;

GRANT ALL ON FUNCTION public.set_transaction_deleted(uuid, timestamp WITH time zone) TO service_role;

CREATE FUNCTION public.shares_project_with (
  target_user_id uuid
)
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  select exists (
    select 1
    from project_members pm1
    join project_members pm2 on pm1.project_id = pm2.project_id
    where pm1.user_id = auth.uid()
    and pm2.user_id = target_user_id
  );
$function$;

CREATE FUNCTION public.soft_delete_folder_tree (
  p_project_id uuid,
  p_folder_id  uuid,
  p_deleted_at timestamp with time zone
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO 'public'
  AS $function$
declare
  folder_ids uuid[];
begin
  if p_deleted_at is null then
    raise exception 'deleted timestamp is required';
  end if;

  if coalesce(public.project_role(p_project_id), '') not in ('owner', 'editor') then
    raise exception 'forbidden';
  end if;

  select coalesce(array_agg(id), '{}'::uuid[])
  into folder_ids
  from (
    with recursive folder_tree as (
      select id
      from folders
      where id = p_folder_id
      and project_id = p_project_id

      union

      select child.id
      from folders child
      join folder_tree parent on parent.id = child.parent_folder_id
      where child.project_id = p_project_id
    )
    select id from folder_tree
  ) tree;

  if cardinality(folder_ids) = 0 then
    raise exception 'folder not found';
  end if;

  update files
  set deleted_at = p_deleted_at
  where project_id = p_project_id
  and folder_id = any(folder_ids)
  and deleted_at is null;

  update folders
  set deleted_at = p_deleted_at
  where project_id = p_project_id
  and id = any(folder_ids)
  and deleted_at is null;
end;
$function$;

REVOKE ALL ON FUNCTION public.soft_delete_folder_tree(uuid, uuid, timestamp WITH time zone) FROM PUBLIC;

GRANT ALL ON FUNCTION public.soft_delete_folder_tree(uuid, uuid, timestamp WITH time zone) TO authenticated;

GRANT ALL ON FUNCTION public.soft_delete_folder_tree(uuid, uuid, timestamp WITH time zone) TO service_role;

CREATE FUNCTION public.task_project_id (
  check_task_id uuid
)
  RETURNS uuid
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  select project_id from tasks where id = check_task_id;
$function$;

CREATE FUNCTION public.update_task_with_assignees (
  p_task_id                   uuid,
  p_name                      text,
  p_category                  text,
  p_description               text,
  p_start_date                date,
  p_deadline                  date,
  p_deadline_time             time without time zone,
  p_status                    text,
  p_user_ids                  uuid[],
  p_ghost_member_ids          uuid[],
  p_kept_deleted_assignee_ids uuid[]
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO 'public'
  AS $function$
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

REVOKE ALL ON FUNCTION public.update_task_with_assignees(uuid, text, text, text, date, date, time WITHOUT time zone, text, uuid[], uuid[], uuid[]) FROM PUBLIC;

GRANT ALL ON FUNCTION public.update_task_with_assignees(uuid, text, text, text, date, date, time WITHOUT time zone, text, uuid[], uuid[], uuid[]) TO authenticated;

GRANT ALL ON FUNCTION public.update_task_with_assignees(uuid, text, text, text, date, date, time WITHOUT time zone, text, uuid[], uuid[], uuid[]) TO service_role;

CREATE FUNCTION public.user_storage_bytes (
  target_user_id uuid
)
  RETURNS TABLE (
    total_bytes bigint,
    row_count   bigint
  )
  LANGUAGE sql
  STABLE
  SET search_path TO 'public'
  AS $function$
  select coalesce(sum(size_bytes), 0)::bigint, count(*)::bigint
  from files where uploaded_by = target_user_id;
$function$;

CREATE TABLE public.bom_items (
  id          uuid                     DEFAULT gen_random_uuid() NOT NULL,
  project_id  uuid                     NOT NULL,
  part_name   text                     NOT NULL,
  quantity    numeric,
  unit_cost   numeric,
  supplier    text,
  item_url    text,
  created_at  timestamp with time zone DEFAULT now(),
  description text,
  unit        text,
  total_cost  numeric                  GENERATED ALWAYS AS ((quantity * unit_cost)) STORED,
  category    text,
  deleted_at  timestamp with time zone
);

ALTER TABLE public.bom_items
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.bom_items
  ADD CONSTRAINT bom_items_pkey PRIMARY KEY (id);

GRANT DELETE, INSERT, SELECT, UPDATE ON public.bom_items TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.bom_items TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.bom_items TO service_role;

CREATE INDEX bom_items_deleted_at_idx ON public.bom_items (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE POLICY "money editors can create bom items" ON public.bom_items
  FOR INSERT
  WITH CHECK (public.can_edit_money(project_id));

CREATE POLICY "money editors can delete bom items" ON public.bom_items
  FOR DELETE
  USING (public.can_edit_money(project_id));

CREATE POLICY "money editors can update bom items" ON public.bom_items
  FOR UPDATE
  USING (public.can_edit_money(project_id));

CREATE POLICY "project members can view bom items" ON public.bom_items
  FOR SELECT
  USING (public.is_project_member(project_id));

CREATE TABLE public.error_reports (
  id         text                     NOT NULL,
  message    text                     NOT NULL,
  stack      text,
  source     text                     NOT NULL,
  method     text,
  path       text,
  url        text,
  user_id    uuid,
  context    jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.error_reports
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.error_reports
  ADD CONSTRAINT error_reports_pkey PRIMARY KEY (id);

ALTER TABLE public.error_reports
  ADD CONSTRAINT error_reports_source_check CHECK (source = ANY (ARRAY['server'::text, 'client'::text, 'feedback'::text]));

GRANT DELETE, INSERT, SELECT, UPDATE ON public.error_reports TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.error_reports TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.error_reports TO service_role;

CREATE INDEX error_reports_created_at_idx ON public.error_reports (created_at DESC);

CREATE TABLE public.files (
  id                  uuid                     DEFAULT gen_random_uuid() NOT NULL,
  project_id          uuid                     NOT NULL,
  folder_id           uuid,
  uploaded_by         uuid,
  filename            text                     NOT NULL,
  r2_key              text                     NOT NULL,
  mime_type           text,
  size_bytes          bigint,
  created_at          timestamp with time zone DEFAULT now(),
  storage_provider    text                     DEFAULT 'r2'::text NOT NULL,
  is_journal          boolean                  DEFAULT false NOT NULL,
  uploader_deleted_at timestamp with time zone,
  deleted_at          timestamp with time zone,
  is_public           boolean                  DEFAULT false NOT NULL
);

ALTER TABLE public.files
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.files
  ADD CONSTRAINT files_pkey PRIMARY KEY (id);

ALTER TABLE public.files
  ADD CONSTRAINT files_r2_key_key UNIQUE (r2_key);

GRANT DELETE, INSERT, SELECT, UPDATE ON public.files TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.files TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.files TO service_role;

CREATE INDEX files_project_id_idx ON public.files (project_id);

CREATE INDEX files_uploader_deleted_at_idx ON public.files (uploader_deleted_at)
  WHERE uploader_deleted_at IS NOT NULL;

CREATE INDEX files_uploaded_by_idx ON public.files (uploaded_by);

CREATE INDEX files_public_project_id_idx ON public.files (project_id)
  WHERE is_public AND deleted_at IS NULL AND NOT is_journal;

CREATE INDEX files_deleted_at_idx ON public.files (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE UNIQUE INDEX journal_file_unique_per_project ON public.files (project_id)
  WHERE is_journal;

CREATE POLICY "editors and owners can delete files" ON public.files
  FOR DELETE
  USING (((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])) AND (NOT is_journal)));

CREATE POLICY "editors and owners can update files" ON public.files
  FOR UPDATE
  USING ((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "editors and owners can upload files" ON public.files
  FOR INSERT
  WITH CHECK (((uploaded_by = auth.uid()) AND (public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text]))));

CREATE POLICY "project members can view files" ON public.files
  FOR SELECT
  USING (public.is_project_member(project_id));

CREATE TABLE public.folders (
  id               uuid                     DEFAULT gen_random_uuid() NOT NULL,
  project_id       uuid                     NOT NULL,
  name             text                     NOT NULL,
  parent_folder_id uuid,
  created_at       timestamp with time zone DEFAULT now(),
  deleted_at       timestamp with time zone
);

ALTER TABLE public.folders
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.folders
  ADD CONSTRAINT folders_pkey PRIMARY KEY (id);

ALTER TABLE public.files
  ADD CONSTRAINT files_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.folders(id) ON DELETE SET NULL;

ALTER TABLE public.folders
  ADD CONSTRAINT folders_parent_folder_id_fkey FOREIGN KEY (parent_folder_id) REFERENCES public.folders(id) ON DELETE CASCADE;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.folders TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.folders TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.folders TO service_role;

CREATE INDEX folders_deleted_at_idx ON public.folders (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE POLICY "editors and owners can create folders" ON public.folders
  FOR INSERT
  WITH CHECK ((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "editors and owners can delete folders" ON public.folders
  FOR DELETE
  USING ((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "editors and owners can rename folders" ON public.folders
  FOR UPDATE
  USING ((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "project members can view folders" ON public.folders
  FOR SELECT
  USING (public.is_project_member(project_id));

CREATE TABLE public.forum_post_likes (
  post_id    uuid                     NOT NULL,
  user_id    uuid                     NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.forum_post_likes
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.forum_post_likes
  ADD CONSTRAINT forum_post_likes_pkey PRIMARY KEY (post_id, user_id);

GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_post_likes TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_post_likes TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_post_likes TO service_role;

CREATE POLICY "authenticated users can view forum post likes" ON public.forum_post_likes
  FOR SELECT
  TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "users can remove their forum post likes" ON public.forum_post_likes
  FOR DELETE
  TO authenticated
  USING ((auth.uid() = user_id));

CREATE TABLE public.forum_posts (
  id         uuid                     DEFAULT gen_random_uuid() NOT NULL,
  author_id  uuid,
  body       text                     NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone
);

CREATE POLICY "users can like active forum posts" ON public.forum_post_likes
  FOR INSERT
  TO authenticated
  WITH CHECK (((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM public.forum_posts
  WHERE ((forum_posts.id = forum_post_likes.post_id) AND (forum_posts.deleted_at IS NULL))))));

ALTER TABLE public.forum_posts
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.forum_posts
  ADD CONSTRAINT forum_posts_body_check CHECK (char_length(btrim(body)) >= 1 AND char_length(btrim(body)) <= 5000);

ALTER TABLE public.forum_posts
  ADD CONSTRAINT forum_posts_pkey PRIMARY KEY (id);

ALTER TABLE public.forum_post_likes
  ADD CONSTRAINT forum_post_likes_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.forum_posts(id) ON DELETE CASCADE;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_posts TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_posts TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_posts TO service_role;

CREATE INDEX forum_posts_created_at_id_idx ON public.forum_posts (created_at DESC, id DESC);

CREATE TRIGGER forum_posts_soft_delete_only
  BEFORE UPDATE ON public.forum_posts
  FOR EACH ROW
  EXECUTE FUNCTION public.forum_post_soft_delete_only();

CREATE POLICY "authenticated users can view forum posts" ON public.forum_posts
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "authors can soft-delete their forum posts" ON public.forum_posts
  FOR UPDATE
  TO authenticated
  USING ((auth.uid() = author_id))
  WITH CHECK ((auth.uid() = author_id));

CREATE POLICY "users can create their own forum posts" ON public.forum_posts
  FOR INSERT
  TO authenticated
  WITH CHECK ((auth.uid() = author_id));

CREATE TABLE public.forum_replies (
  id              uuid                     DEFAULT gen_random_uuid() NOT NULL,
  post_id         uuid                     NOT NULL,
  author_id       uuid,
  body            text                     NOT NULL,
  created_at      timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at      timestamp with time zone,
  parent_reply_id uuid
);

ALTER TABLE public.forum_replies
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.forum_replies
  ADD CONSTRAINT forum_replies_body_check CHECK (char_length(btrim(body)) >= 1 AND char_length(btrim(body)) <= 5000);

ALTER TABLE public.forum_replies
  ADD CONSTRAINT forum_replies_pkey PRIMARY KEY (id);

ALTER TABLE public.forum_replies
  ADD CONSTRAINT forum_replies_parent_reply_id_fkey FOREIGN KEY (parent_reply_id) REFERENCES public.forum_replies(id) ON DELETE CASCADE;

ALTER TABLE public.forum_replies
  ADD CONSTRAINT forum_replies_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.forum_posts(id) ON DELETE CASCADE;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_replies TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_replies TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_replies TO service_role;

CREATE INDEX forum_replies_post_created_at_id_idx ON public.forum_replies (post_id, created_at, id);

CREATE INDEX forum_replies_parent_created_at_id_idx ON public.forum_replies (parent_reply_id, created_at, id);

CREATE TRIGGER forum_replies_parent_is_valid
  BEFORE INSERT OR UPDATE ON public.forum_replies
  FOR EACH ROW
  EXECUTE FUNCTION public.forum_reply_parent_is_valid();

CREATE TRIGGER forum_replies_soft_delete_only
  BEFORE UPDATE ON public.forum_replies
  FOR EACH ROW
  EXECUTE FUNCTION public.forum_reply_soft_delete_only();

CREATE POLICY "authenticated users can view forum replies" ON public.forum_replies
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "authors can soft-delete their forum replies" ON public.forum_replies
  FOR UPDATE
  TO authenticated
  USING ((auth.uid() = author_id))
  WITH CHECK ((auth.uid() = author_id));

CREATE POLICY "users can create their own forum replies" ON public.forum_replies
  FOR INSERT
  TO authenticated
  WITH CHECK (((auth.uid() = author_id) AND (EXISTS ( SELECT 1
   FROM public.forum_posts
  WHERE ((forum_posts.id = forum_replies.post_id) AND (forum_posts.deleted_at IS NULL))))));

CREATE TABLE public.forum_reply_likes (
  reply_id   uuid                     NOT NULL,
  user_id    uuid                     NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.forum_reply_likes
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.forum_reply_likes
  ADD CONSTRAINT forum_reply_likes_pkey PRIMARY KEY (reply_id, user_id);

ALTER TABLE public.forum_reply_likes
  ADD CONSTRAINT forum_reply_likes_reply_id_fkey FOREIGN KEY (reply_id) REFERENCES public.forum_replies(id) ON DELETE CASCADE;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_reply_likes TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_reply_likes TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_reply_likes TO service_role;

CREATE POLICY "authenticated users can view forum reply likes" ON public.forum_reply_likes
  FOR SELECT
  TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "users can like active forum replies" ON public.forum_reply_likes
  FOR INSERT
  TO authenticated
  WITH CHECK (((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM (public.forum_replies
     JOIN public.forum_posts ON ((forum_posts.id = forum_replies.post_id)))
  WHERE ((forum_replies.id = forum_reply_likes.reply_id) AND (forum_replies.deleted_at IS NULL) AND (forum_posts.deleted_at IS NULL))))));

CREATE POLICY "users can remove their forum reply likes" ON public.forum_reply_likes
  FOR DELETE
  TO authenticated
  USING ((auth.uid() = user_id));

CREATE TABLE public.ghost_members (
  id                   uuid                     DEFAULT gen_random_uuid() NOT NULL,
  project_id           uuid                     NOT NULL,
  display_name         text                     NOT NULL,
  note                 text,
  contribution_percent numeric,
  created_at           timestamp with time zone DEFAULT now(),
  is_deleted_account   boolean                  DEFAULT false NOT NULL
);

ALTER TABLE public.ghost_members
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.ghost_members
  ADD CONSTRAINT ghost_members_pkey PRIMARY KEY (id);

GRANT DELETE, INSERT, SELECT, UPDATE ON public.ghost_members TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.ghost_members TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.ghost_members TO service_role;

CREATE INDEX ghost_members_project_id_idx ON public.ghost_members (project_id);

CREATE POLICY "money editors can create ghost members" ON public.ghost_members
  FOR INSERT
  WITH CHECK (public.can_edit_money(project_id));

CREATE POLICY "money editors can delete ghost members" ON public.ghost_members
  FOR DELETE
  USING (public.can_edit_money(project_id));

CREATE POLICY "money editors can update ghost members" ON public.ghost_members
  FOR UPDATE
  USING (public.can_edit_money(project_id));

CREATE POLICY "project members can view ghost members" ON public.ghost_members
  FOR SELECT
  USING (public.is_project_member(project_id));

CREATE TABLE public.journal_drafts (
  project_id uuid                     NOT NULL,
  draft_date date                     DEFAULT ((now() AT TIME ZONE 'Asia/Manila'::text))::date NOT NULL,
  content    text                     DEFAULT ''::text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

ALTER PUBLICATION supabase_realtime ADD TABLE public.journal_drafts;

ALTER TABLE public.journal_drafts
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.journal_drafts
  ADD CONSTRAINT journal_drafts_content_check CHECK (char_length(content) <= 50000);

ALTER TABLE public.journal_drafts
  ADD CONSTRAINT journal_drafts_pkey PRIMARY KEY (project_id);

GRANT DELETE, INSERT, SELECT, UPDATE ON public.journal_drafts TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.journal_drafts TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.journal_drafts TO service_role;

CREATE POLICY "editors and owners can create the journal draft" ON public.journal_drafts
  FOR INSERT
  WITH CHECK ((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "editors and owners can update the journal draft" ON public.journal_drafts
  FOR UPDATE
  USING ((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "editors and owners can view the journal draft" ON public.journal_drafts
  FOR SELECT
  USING ((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE TABLE public.profiles (
  id                  uuid                     NOT NULL,
  display_name        text                     NOT NULL,
  created_at          timestamp with time zone DEFAULT now(),
  email               text,
  is_admin            boolean                  DEFAULT false NOT NULL,
  pending_deletion_at timestamp with time zone,
  avatar              text
);

CREATE POLICY "admins can view error reports" ON public.error_reports
  FOR SELECT
  USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND profiles.is_admin))));

ALTER TABLE public.profiles
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

ALTER TABLE public.error_reports
  ADD CONSTRAINT error_reports_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.files
  ADD CONSTRAINT files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.forum_post_likes
  ADD CONSTRAINT forum_post_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.forum_posts
  ADD CONSTRAINT forum_posts_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.forum_replies
  ADD CONSTRAINT forum_replies_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.forum_reply_likes
  ADD CONSTRAINT forum_reply_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.journal_drafts
  ADD CONSTRAINT journal_drafts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.profiles TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.profiles TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.profiles TO service_role;

CREATE INDEX profiles_pending_deletion_at_idx ON public.profiles (pending_deletion_at)
  WHERE pending_deletion_at IS NOT NULL;

CREATE POLICY "members can view profiles of fellow project members" ON public.profiles
  FOR SELECT
  USING (public.shares_project_with(id));

CREATE POLICY "users can insert own profile" ON public.profiles
  FOR INSERT
  WITH CHECK ((auth.uid() = id));

CREATE POLICY "users can read own profile" ON public.profiles
  FOR SELECT
  USING ((auth.uid() = id));

CREATE TABLE public.project_members (
  project_id           uuid                     NOT NULL,
  user_id              uuid                     NOT NULL,
  role                 text                     NOT NULL,
  joined_at            timestamp with time zone DEFAULT now(),
  contribution_percent numeric,
  is_auditor           boolean                  DEFAULT false NOT NULL
);

ALTER TABLE public.project_members
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.project_members
  ADD CONSTRAINT project_members_pkey PRIMARY KEY (project_id, user_id);

ALTER TABLE public.project_members
  ADD CONSTRAINT project_members_role_check CHECK (role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text]));

ALTER TABLE public.project_members
  ADD CONSTRAINT project_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.project_members TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.project_members TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.project_members TO service_role;

CREATE TRIGGER guard_member_role_change_trigger
  BEFORE UPDATE ON public.project_members
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_member_role_change();

CREATE POLICY "members can view fellow project members" ON public.project_members
  FOR SELECT
  USING (public.is_project_member(project_id));

CREATE POLICY "money editors can update member contributions" ON public.project_members
  FOR UPDATE
  USING (public.can_edit_money(project_id));

CREATE TABLE public.projects (
  id                   uuid                     DEFAULT gen_random_uuid() NOT NULL,
  name                 text                     NOT NULL,
  description          text,
  owner_id             uuid                     NOT NULL,
  created_at           timestamp with time zone DEFAULT now(),
  updated_at           timestamp with time zone DEFAULT now(),
  currency             text                     DEFAULT 'PHP'::text NOT NULL,
  is_public            boolean                  DEFAULT false NOT NULL,
  public_files_enabled boolean                  DEFAULT false NOT NULL
);

CREATE POLICY "project owner can add members" ON public.project_members
  FOR INSERT
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.projects
  WHERE ((projects.id = project_members.project_id) AND (projects.owner_id = auth.uid())))));

CREATE POLICY "project owner can remove members" ON public.project_members
  FOR DELETE
  USING ((EXISTS ( SELECT 1
   FROM public.projects
  WHERE ((projects.id = project_members.project_id) AND (projects.owner_id = auth.uid())))));

ALTER TABLE public.projects
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.projects
  ADD CONSTRAINT projects_currency_check CHECK (currency = ANY (ARRAY['PHP'::text, 'USD'::text]));

ALTER TABLE public.projects
  ADD CONSTRAINT projects_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.profiles(id);

ALTER TABLE public.projects
  ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE public.bom_items
  ADD CONSTRAINT bom_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE public.files
  ADD CONSTRAINT files_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE public.folders
  ADD CONSTRAINT folders_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE public.ghost_members
  ADD CONSTRAINT ghost_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE public.journal_drafts
  ADD CONSTRAINT journal_drafts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE public.project_members
  ADD CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.projects TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.projects TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.projects TO service_role;

CREATE INDEX projects_public_files_enabled_idx ON public.projects (public_files_enabled)
  WHERE public_files_enabled;

CREATE INDEX projects_is_public_idx ON public.projects (is_public)
  WHERE is_public;

CREATE TRIGGER on_project_created
  AFTER INSERT ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_project();

CREATE POLICY "authenticated users can create projects" ON public.projects
  FOR INSERT
  WITH CHECK ((owner_id = auth.uid()));

CREATE POLICY "members can view their projects" ON public.projects
  FOR SELECT
  USING ((EXISTS ( SELECT 1
   FROM public.project_members
  WHERE ((project_members.project_id = projects.id) AND (project_members.user_id = auth.uid())))));

CREATE POLICY "owner can delete their project" ON public.projects
  FOR DELETE
  USING ((owner_id = auth.uid()));

CREATE POLICY "owner can update their project" ON public.projects
  FOR UPDATE
  USING ((owner_id = auth.uid()));

CREATE TABLE public.task_assignees (
  task_id              uuid NOT NULL,
  user_id              uuid,
  id                   uuid DEFAULT gen_random_uuid() NOT NULL,
  deleted_display_name text,
  ghost_member_id      uuid
);

ALTER TABLE public.task_assignees
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.task_assignees
  ADD CONSTRAINT task_assignees_ghost_member_id_fkey FOREIGN KEY (ghost_member_id) REFERENCES public.ghost_members(id) ON DELETE RESTRICT;

ALTER TABLE public.task_assignees
  ADD CONSTRAINT task_assignees_member_xor_ghost CHECK (user_id IS NULL OR ghost_member_id IS NULL);

ALTER TABLE public.task_assignees
  ADD CONSTRAINT task_assignees_pkey PRIMARY KEY (id);

ALTER TABLE public.task_assignees
  ADD CONSTRAINT task_assignees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_assignees TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_assignees TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_assignees TO service_role;

CREATE UNIQUE INDEX task_assignees_task_ghost_unique ON public.task_assignees (task_id, ghost_member_id)
  WHERE ghost_member_id IS NOT NULL;

CREATE INDEX task_assignees_user_id_idx ON public.task_assignees (user_id);

CREATE UNIQUE INDEX task_assignees_task_user_unique ON public.task_assignees (task_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX task_assignees_ghost_member_id_idx ON public.task_assignees (ghost_member_id);

CREATE POLICY "editors and owners can assign tasks" ON public.task_assignees
  FOR INSERT
  WITH CHECK ((public.project_role(public.task_project_id(task_id)) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "editors and owners can unassign tasks" ON public.task_assignees
  FOR DELETE
  USING ((public.project_role(public.task_project_id(task_id)) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "project members can view task assignees" ON public.task_assignees
  FOR SELECT
  USING (public.is_project_member(public.task_project_id(task_id)));

CREATE TABLE public.task_categories (
  project_id  uuid     NOT NULL,
  name        text     NOT NULL,
  color_index smallint NOT NULL
);

ALTER TABLE public.task_categories
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.task_categories
  ADD CONSTRAINT task_categories_color_index_check CHECK (color_index >= 0 AND color_index <= 9);

ALTER TABLE public.task_categories
  ADD CONSTRAINT task_categories_pkey PRIMARY KEY (project_id, name);

ALTER TABLE public.task_categories
  ADD CONSTRAINT task_categories_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_categories TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_categories TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_categories TO service_role;

CREATE POLICY "editors and owners can create task categories" ON public.task_categories
  FOR INSERT
  WITH CHECK ((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "editors and owners can delete task categories" ON public.task_categories
  FOR DELETE
  USING ((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "editors and owners can update task categories" ON public.task_categories
  FOR UPDATE
  USING ((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "project members can view task categories" ON public.task_categories
  FOR SELECT
  USING (public.is_project_member(project_id));

CREATE TABLE public.tasks (
  id            uuid                     DEFAULT gen_random_uuid() NOT NULL,
  project_id    uuid                     NOT NULL,
  name          text                     NOT NULL,
  category      text,
  description   text,
  deadline      date,
  status        text                     DEFAULT 'ongoing'::text NOT NULL,
  created_at    timestamp with time zone DEFAULT now(),
  deadline_time time without time zone   DEFAULT '23:59:00'::time WITHOUT time zone NOT NULL,
  deleted_at    timestamp with time zone,
  start_date    date
);

ALTER TABLE public.tasks
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);

ALTER TABLE public.task_assignees
  ADD CONSTRAINT task_assignees_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_status_check CHECK (status = ANY (ARRAY['ongoing'::text, 'done'::text]));

GRANT DELETE, INSERT, SELECT, UPDATE ON public.tasks TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.tasks TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.tasks TO service_role;

CREATE INDEX tasks_deleted_at_idx ON public.tasks (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX tasks_project_id_idx ON public.tasks (project_id);

CREATE POLICY "editors and owners can create tasks" ON public.tasks
  FOR INSERT
  WITH CHECK ((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "editors and owners can delete tasks" ON public.tasks
  FOR DELETE
  USING ((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "editors and owners can update tasks" ON public.tasks
  FOR UPDATE
  USING ((public.project_role(project_id) = ANY (ARRAY['owner'::text, 'editor'::text])));

CREATE POLICY "project members can view tasks" ON public.tasks
  FOR SELECT
  USING (public.is_project_member(project_id));

CREATE TABLE public.transactions (
  id                      uuid                     DEFAULT gen_random_uuid() NOT NULL,
  project_id              uuid                     NOT NULL,
  member_id               uuid,
  transaction_date        date                     NOT NULL,
  type                    text                     NOT NULL,
  item_name               text,
  quantity                numeric,
  unit                    text,
  unit_cost               numeric,
  total_cost              numeric                  GENERATED ALWAYS AS ((quantity * unit_cost)) STORED,
  created_at              timestamp with time zone DEFAULT now(),
  related_member_id       uuid,
  supplier                text,
  group_id                uuid,
  item_url                text,
  ghost_member_id         uuid,
  related_ghost_member_id uuid,
  deleted_at              timestamp with time zone
);

ALTER TABLE public.transactions
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_ghost_member_id_fkey FOREIGN KEY (ghost_member_id) REFERENCES public.ghost_members(id) ON DELETE RESTRICT;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.profiles(id);

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_one_payee CHECK (num_nonnulls(related_member_id, related_ghost_member_id) <= 1);

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_one_payer CHECK (num_nonnulls(member_id, ghost_member_id) = 1);

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.transactions(id) ON DELETE CASCADE;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_related_ghost_member_id_fkey FOREIGN KEY (related_ghost_member_id) REFERENCES public.ghost_members(id) ON DELETE RESTRICT;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_related_member_id_fkey FOREIGN KEY (related_member_id) REFERENCES public.profiles(id);

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_type_check CHECK (type = ANY (ARRAY['item'::text, 'shipping'::text, 'discount'::text, 'refund'::text, 'payment'::text, 'bulk'::text]));

GRANT DELETE, INSERT, SELECT, UPDATE ON public.transactions TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.transactions TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.transactions TO service_role;

CREATE INDEX transactions_deleted_at_idx ON public.transactions (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX transactions_group_id_idx ON public.transactions (group_id);

CREATE POLICY "money editors can create transactions" ON public.transactions
  FOR INSERT
  WITH CHECK (public.can_edit_money(project_id));

CREATE POLICY "money editors can delete transactions" ON public.transactions
  FOR DELETE
  USING (public.can_edit_money(project_id));

CREATE POLICY "money editors can update transactions" ON public.transactions
  FOR UPDATE
  USING (public.can_edit_money(project_id));

CREATE POLICY "project members can view transactions" ON public.transactions
  FOR SELECT
  USING (public.is_project_member(project_id));
