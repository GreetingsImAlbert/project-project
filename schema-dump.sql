


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."can_edit_money"("check_project_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from project_members
    where project_id = check_project_id
    and user_id = auth.uid()
    and (role = 'owner' or is_auditor)
  );
$$;


ALTER FUNCTION "public"."can_edit_money"("check_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_bulk_transaction_with_lines"("p_project_id" "uuid", "p_member_id" "uuid", "p_ghost_member_id" "uuid", "p_transaction_date" "date", "p_label" "text", "p_total" numeric, "p_supplier" "text", "p_item_url" "text", "p_lines" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."create_bulk_transaction_with_lines"("p_project_id" "uuid", "p_member_id" "uuid", "p_ghost_member_id" "uuid", "p_transaction_date" "date", "p_label" "text", "p_total" numeric, "p_supplier" "text", "p_item_url" "text", "p_lines" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_task_with_assignees"("p_project_id" "uuid", "p_name" "text", "p_category" "text", "p_description" "text", "p_start_date" "date", "p_deadline" "date", "p_deadline_time" time without time zone, "p_status" "text", "p_user_ids" "uuid"[], "p_ghost_member_ids" "uuid"[]) RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."create_task_with_assignees"("p_project_id" "uuid", "p_name" "text", "p_category" "text", "p_description" "text", "p_start_date" "date", "p_deadline" "date", "p_deadline_time" time without time zone, "p_status" "text", "p_user_ids" "uuid"[], "p_ghost_member_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."forum_post_soft_delete_only"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.author_id is distinct from old.author_id
     or new.body is distinct from old.body
     or new.created_at is distinct from old.created_at
     or (old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at) then
    raise exception 'Forum posts can only be soft-deleted';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."forum_post_soft_delete_only"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."forum_reply_soft_delete_only"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.post_id is distinct from old.post_id
     or new.author_id is distinct from old.author_id
     or new.body is distinct from old.body
     or new.created_at is distinct from old.created_at
     or (old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at) then
    raise exception 'Forum replies can only be soft-deleted';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."forum_reply_soft_delete_only"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."global_storage_breakdown"() RETURNS TABLE("uploaded_by" "uuid", "project_id" "uuid", "total_bytes" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select f.uploaded_by, f.project_id, coalesce(sum(f.size_bytes), 0)::bigint
  from files f
  group by f.uploaded_by, f.project_id;
$$;


ALTER FUNCTION "public"."global_storage_breakdown"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_member_role_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."guard_member_role_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_project"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_project"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_project_member"("check_project_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from project_members
    where project_members.project_id = check_project_id
    and project_members.user_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."is_project_member"("check_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."project_role"("check_project_id" "uuid") RETURNS "text"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select role from project_members
  where project_id = check_project_id
  and user_id = auth.uid();
$$;


ALTER FUNCTION "public"."project_role"("check_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."project_storage_bytes"("check_project_id" "uuid") RETURNS bigint
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select coalesce(sum(size_bytes), 0)::bigint
  from files where project_id = check_project_id;
$$;


ALTER FUNCTION "public"."project_storage_bytes"("check_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."public_project_files"("p_id" "uuid") RETURNS TABLE("project_name" "text", "project_is_public" boolean, "public_files_enabled" boolean, "id" "uuid", "filename" "text", "size_bytes" bigint, "mime_type" "text", "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p.name, p.is_public, p.public_files_enabled, f.id, f.filename, f.size_bytes, f.mime_type, f.created_at
  from projects p
  left join files f on f.project_id = p.id and f.is_public and f.deleted_at is null and not f.is_journal
  where p.id = p_id and p.is_public and p.public_files_enabled
  order by f.created_at desc nulls last;
$$;


ALTER FUNCTION "public"."public_project_files"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."public_project_get"("p_id" "uuid") RETURNS TABLE("id" "uuid", "name" "text", "description" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p.id, p.name, p.description
  from projects p where p.id = p_id and p.is_public;
$$;


ALTER FUNCTION "public"."public_project_get"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."public_project_list"() RETURNS TABLE("id" "uuid", "name" "text", "description" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p.id, p.name, p.description
  from projects p
  where p.is_public
  order by p.created_at desc;
$$;


ALTER FUNCTION "public"."public_project_list"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_bulk_transaction_with_lines"("p_transaction_id" "uuid", "p_member_id" "uuid", "p_ghost_member_id" "uuid", "p_transaction_date" "date", "p_label" "text", "p_total" numeric, "p_supplier" "text", "p_item_url" "text", "p_lines" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."replace_bulk_transaction_with_lines"("p_transaction_id" "uuid", "p_member_id" "uuid", "p_ghost_member_id" "uuid", "p_transaction_date" "date", "p_label" "text", "p_total" numeric, "p_supplier" "text", "p_item_url" "text", "p_lines" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_transaction_deleted"("p_transaction_id" "uuid", "p_deleted_at" timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."set_transaction_deleted"("p_transaction_id" "uuid", "p_deleted_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."shares_project_with"("target_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from project_members pm1
    join project_members pm2 on pm1.project_id = pm2.project_id
    where pm1.user_id = auth.uid()
    and pm2.user_id = target_user_id
  );
$$;


ALTER FUNCTION "public"."shares_project_with"("target_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."soft_delete_folder_tree"("p_project_id" "uuid", "p_folder_id" "uuid", "p_deleted_at" timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."soft_delete_folder_tree"("p_project_id" "uuid", "p_folder_id" "uuid", "p_deleted_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."task_project_id"("check_task_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select project_id from tasks where id = check_task_id;
$$;


ALTER FUNCTION "public"."task_project_id"("check_task_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_task_with_assignees"("p_task_id" "uuid", "p_name" "text", "p_category" "text", "p_description" "text", "p_start_date" "date", "p_deadline" "date", "p_deadline_time" time without time zone, "p_status" "text", "p_user_ids" "uuid"[], "p_ghost_member_ids" "uuid"[], "p_kept_deleted_assignee_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."update_task_with_assignees"("p_task_id" "uuid", "p_name" "text", "p_category" "text", "p_description" "text", "p_start_date" "date", "p_deadline" "date", "p_deadline_time" time without time zone, "p_status" "text", "p_user_ids" "uuid"[], "p_ghost_member_ids" "uuid"[], "p_kept_deleted_assignee_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_storage_bytes"("target_user_id" "uuid") RETURNS TABLE("total_bytes" bigint, "row_count" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select coalesce(sum(size_bytes), 0)::bigint, count(*)::bigint
  from files where uploaded_by = target_user_id;
$$;


ALTER FUNCTION "public"."user_storage_bytes"("target_user_id" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."bom_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "part_name" "text" NOT NULL,
    "quantity" numeric,
    "unit_cost" numeric,
    "supplier" "text",
    "item_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "description" "text",
    "unit" "text",
    "total_cost" numeric GENERATED ALWAYS AS (("quantity" * "unit_cost")) STORED,
    "category" "text",
    "deleted_at" timestamp with time zone
);


ALTER TABLE "public"."bom_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."error_reports" (
    "id" "text" NOT NULL,
    "message" "text" NOT NULL,
    "stack" "text",
    "source" "text" NOT NULL,
    "method" "text",
    "path" "text",
    "url" "text",
    "user_id" "uuid",
    "context" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "error_reports_source_check" CHECK (("source" = ANY (ARRAY['server'::"text", 'client'::"text", 'feedback'::"text"])))
);


ALTER TABLE "public"."error_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "folder_id" "uuid",
    "uploaded_by" "uuid",
    "filename" "text" NOT NULL,
    "r2_key" "text" NOT NULL,
    "mime_type" "text",
    "size_bytes" bigint,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "storage_provider" "text" DEFAULT 'r2'::"text" NOT NULL,
    "is_journal" boolean DEFAULT false NOT NULL,
    "uploader_deleted_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "is_public" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."files" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."folders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "parent_folder_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "deleted_at" timestamp with time zone
);


ALTER TABLE "public"."folders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."forum_post_likes" (
    "post_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."forum_post_likes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."forum_posts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "author_id" "uuid",
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "forum_posts_body_check" CHECK ((("char_length"("btrim"("body")) >= 1) AND ("char_length"("btrim"("body")) <= 5000)))
);


ALTER TABLE "public"."forum_posts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."forum_replies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "author_id" "uuid",
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    "parent_reply_id" "uuid",
    CONSTRAINT "forum_replies_body_check" CHECK ((("char_length"("btrim"("body")) >= 1) AND ("char_length"("btrim"("body")) <= 5000)))
);


ALTER TABLE "public"."forum_replies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."forum_reply_likes" (
    "reply_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."forum_reply_likes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ghost_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "display_name" "text" NOT NULL,
    "note" "text",
    "contribution_percent" numeric,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "is_deleted_account" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."ghost_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."journal_drafts" (
    "project_id" "uuid" NOT NULL,
    "draft_date" "date" DEFAULT (("now"() AT TIME ZONE 'Asia/Manila'::"text"))::"date" NOT NULL,
    "content" "text" DEFAULT ''::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "uuid",
    CONSTRAINT "journal_drafts_content_check" CHECK (("char_length"("content") <= 50000))
);


ALTER TABLE "public"."journal_drafts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "display_name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "email" "text",
    "is_admin" boolean DEFAULT false NOT NULL,
    "pending_deletion_at" timestamp with time zone,
    "avatar" "text"
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_members" (
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"(),
    "contribution_percent" numeric,
    "is_auditor" boolean DEFAULT false NOT NULL,
    CONSTRAINT "project_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'editor'::"text", 'viewer'::"text"])))
);


ALTER TABLE "public"."project_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "owner_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "currency" "text" DEFAULT 'PHP'::"text" NOT NULL,
    "is_public" boolean DEFAULT false NOT NULL,
    "public_files_enabled" boolean DEFAULT false NOT NULL,
    CONSTRAINT "projects_currency_check" CHECK (("currency" = ANY (ARRAY['PHP'::"text", 'USD'::"text"])))
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_assignees" (
    "task_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deleted_display_name" "text",
    "ghost_member_id" "uuid",
    CONSTRAINT "task_assignees_member_xor_ghost" CHECK ((("user_id" IS NULL) OR ("ghost_member_id" IS NULL)))
);


ALTER TABLE "public"."task_assignees" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_categories" (
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "color_index" smallint NOT NULL,
    CONSTRAINT "task_categories_color_index_check" CHECK ((("color_index" >= 0) AND ("color_index" <= 9)))
);


ALTER TABLE "public"."task_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "category" "text",
    "description" "text",
    "deadline" "date",
    "status" "text" DEFAULT 'ongoing'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "deadline_time" time without time zone DEFAULT '23:59:00'::time without time zone NOT NULL,
    "deleted_at" timestamp with time zone,
    "start_date" "date",
    CONSTRAINT "tasks_status_check" CHECK (("status" = ANY (ARRAY['ongoing'::"text", 'done'::"text"])))
);


ALTER TABLE "public"."tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "member_id" "uuid",
    "transaction_date" "date" NOT NULL,
    "type" "text" NOT NULL,
    "item_name" "text",
    "quantity" numeric,
    "unit" "text",
    "unit_cost" numeric,
    "total_cost" numeric GENERATED ALWAYS AS (("quantity" * "unit_cost")) STORED,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "related_member_id" "uuid",
    "supplier" "text",
    "group_id" "uuid",
    "item_url" "text",
    "ghost_member_id" "uuid",
    "related_ghost_member_id" "uuid",
    "deleted_at" timestamp with time zone,
    CONSTRAINT "transactions_one_payee" CHECK (("num_nonnulls"("related_member_id", "related_ghost_member_id") <= 1)),
    CONSTRAINT "transactions_one_payer" CHECK (("num_nonnulls"("member_id", "ghost_member_id") = 1)),
    CONSTRAINT "transactions_type_check" CHECK (("type" = ANY (ARRAY['item'::"text", 'shipping'::"text", 'discount'::"text", 'refund'::"text", 'payment'::"text", 'bulk'::"text"])))
);


ALTER TABLE "public"."transactions" OWNER TO "postgres";


ALTER TABLE ONLY "public"."bom_items"
    ADD CONSTRAINT "bom_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."error_reports"
    ADD CONSTRAINT "error_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."files"
    ADD CONSTRAINT "files_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."files"
    ADD CONSTRAINT "files_r2_key_key" UNIQUE ("r2_key");



ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "folders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."forum_post_likes"
    ADD CONSTRAINT "forum_post_likes_pkey" PRIMARY KEY ("post_id", "user_id");



ALTER TABLE ONLY "public"."forum_posts"
    ADD CONSTRAINT "forum_posts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."forum_replies"
    ADD CONSTRAINT "forum_replies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."forum_reply_likes"
    ADD CONSTRAINT "forum_reply_likes_pkey" PRIMARY KEY ("reply_id", "user_id");



ALTER TABLE ONLY "public"."ghost_members"
    ADD CONSTRAINT "ghost_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."journal_drafts"
    ADD CONSTRAINT "journal_drafts_pkey" PRIMARY KEY ("project_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_pkey" PRIMARY KEY ("project_id", "user_id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_assignees"
    ADD CONSTRAINT "task_assignees_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_categories"
    ADD CONSTRAINT "task_categories_pkey" PRIMARY KEY ("project_id", "name");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_pkey" PRIMARY KEY ("id");



CREATE INDEX "bom_items_deleted_at_idx" ON "public"."bom_items" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE INDEX "error_reports_created_at_idx" ON "public"."error_reports" USING "btree" ("created_at" DESC);



CREATE INDEX "files_deleted_at_idx" ON "public"."files" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE INDEX "files_project_id_idx" ON "public"."files" USING "btree" ("project_id");



CREATE INDEX "files_public_project_id_idx" ON "public"."files" USING "btree" ("project_id") WHERE ("is_public" AND ("deleted_at" IS NULL) AND (NOT "is_journal"));



CREATE INDEX "files_uploaded_by_idx" ON "public"."files" USING "btree" ("uploaded_by");



CREATE INDEX "files_uploader_deleted_at_idx" ON "public"."files" USING "btree" ("uploader_deleted_at") WHERE ("uploader_deleted_at" IS NOT NULL);



CREATE INDEX "folders_deleted_at_idx" ON "public"."folders" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE INDEX "forum_posts_created_at_id_idx" ON "public"."forum_posts" USING "btree" ("created_at" DESC, "id" DESC);



CREATE INDEX "forum_replies_parent_created_at_id_idx" ON "public"."forum_replies" USING "btree" ("parent_reply_id", "created_at", "id");



CREATE INDEX "forum_replies_post_created_at_id_idx" ON "public"."forum_replies" USING "btree" ("post_id", "created_at", "id");



CREATE INDEX "ghost_members_project_id_idx" ON "public"."ghost_members" USING "btree" ("project_id");



CREATE UNIQUE INDEX "journal_file_unique_per_project" ON "public"."files" USING "btree" ("project_id") WHERE "is_journal";



CREATE INDEX "profiles_pending_deletion_at_idx" ON "public"."profiles" USING "btree" ("pending_deletion_at") WHERE ("pending_deletion_at" IS NOT NULL);



CREATE INDEX "projects_is_public_idx" ON "public"."projects" USING "btree" ("is_public") WHERE "is_public";



CREATE INDEX "task_assignees_ghost_member_id_idx" ON "public"."task_assignees" USING "btree" ("ghost_member_id");



CREATE UNIQUE INDEX "task_assignees_task_ghost_unique" ON "public"."task_assignees" USING "btree" ("task_id", "ghost_member_id") WHERE ("ghost_member_id" IS NOT NULL);



CREATE UNIQUE INDEX "task_assignees_task_user_unique" ON "public"."task_assignees" USING "btree" ("task_id", "user_id") WHERE ("user_id" IS NOT NULL);



CREATE INDEX "task_assignees_user_id_idx" ON "public"."task_assignees" USING "btree" ("user_id");



CREATE INDEX "tasks_deleted_at_idx" ON "public"."tasks" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE INDEX "tasks_project_id_idx" ON "public"."tasks" USING "btree" ("project_id");



CREATE INDEX "transactions_deleted_at_idx" ON "public"."transactions" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE INDEX "transactions_group_id_idx" ON "public"."transactions" USING "btree" ("group_id");



CREATE OR REPLACE TRIGGER "forum_posts_soft_delete_only" BEFORE UPDATE ON "public"."forum_posts" FOR EACH ROW EXECUTE FUNCTION "public"."forum_post_soft_delete_only"();



CREATE OR REPLACE TRIGGER "forum_replies_soft_delete_only" BEFORE UPDATE ON "public"."forum_replies" FOR EACH ROW EXECUTE FUNCTION "public"."forum_reply_soft_delete_only"();



CREATE OR REPLACE TRIGGER "guard_member_role_change_trigger" BEFORE UPDATE ON "public"."project_members" FOR EACH ROW EXECUTE FUNCTION "public"."guard_member_role_change"();



CREATE OR REPLACE TRIGGER "on_project_created" AFTER INSERT ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_project"();



ALTER TABLE ONLY "public"."bom_items"
    ADD CONSTRAINT "bom_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."error_reports"
    ADD CONSTRAINT "error_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."files"
    ADD CONSTRAINT "files_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."files"
    ADD CONSTRAINT "files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."files"
    ADD CONSTRAINT "files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "folders_parent_folder_id_fkey" FOREIGN KEY ("parent_folder_id") REFERENCES "public"."folders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "folders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."forum_post_likes"
    ADD CONSTRAINT "forum_post_likes_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."forum_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."forum_post_likes"
    ADD CONSTRAINT "forum_post_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."forum_posts"
    ADD CONSTRAINT "forum_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."forum_replies"
    ADD CONSTRAINT "forum_replies_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."forum_replies"
    ADD CONSTRAINT "forum_replies_parent_reply_id_fkey" FOREIGN KEY ("parent_reply_id") REFERENCES "public"."forum_replies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."forum_replies"
    ADD CONSTRAINT "forum_replies_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."forum_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."forum_reply_likes"
    ADD CONSTRAINT "forum_reply_likes_reply_id_fkey" FOREIGN KEY ("reply_id") REFERENCES "public"."forum_replies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."forum_reply_likes"
    ADD CONSTRAINT "forum_reply_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ghost_members"
    ADD CONSTRAINT "ghost_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."journal_drafts"
    ADD CONSTRAINT "journal_drafts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."journal_drafts"
    ADD CONSTRAINT "journal_drafts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."task_assignees"
    ADD CONSTRAINT "task_assignees_ghost_member_id_fkey" FOREIGN KEY ("ghost_member_id") REFERENCES "public"."ghost_members"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."task_assignees"
    ADD CONSTRAINT "task_assignees_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_assignees"
    ADD CONSTRAINT "task_assignees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."task_categories"
    ADD CONSTRAINT "task_categories_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_ghost_member_id_fkey" FOREIGN KEY ("ghost_member_id") REFERENCES "public"."ghost_members"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."transactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_related_ghost_member_id_fkey" FOREIGN KEY ("related_ghost_member_id") REFERENCES "public"."ghost_members"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_related_member_id_fkey" FOREIGN KEY ("related_member_id") REFERENCES "public"."profiles"("id");



CREATE POLICY "admins can view error reports" ON "public"."error_reports" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND "profiles"."is_admin"))));



CREATE POLICY "authenticated users can create projects" ON "public"."projects" FOR INSERT WITH CHECK (("owner_id" = "auth"."uid"()));



CREATE POLICY "authenticated users can view forum post likes" ON "public"."forum_post_likes" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "authenticated users can view forum posts" ON "public"."forum_posts" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated users can view forum replies" ON "public"."forum_replies" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated users can view forum reply likes" ON "public"."forum_reply_likes" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "authors can soft-delete their forum posts" ON "public"."forum_posts" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "author_id")) WITH CHECK (("auth"."uid"() = "author_id"));



CREATE POLICY "authors can soft-delete their forum replies" ON "public"."forum_replies" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "author_id")) WITH CHECK (("auth"."uid"() = "author_id"));



ALTER TABLE "public"."bom_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "editors and owners can assign tasks" ON "public"."task_assignees" FOR INSERT WITH CHECK (("public"."project_role"("public"."task_project_id"("task_id")) = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can create folders" ON "public"."folders" FOR INSERT WITH CHECK (("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can create task categories" ON "public"."task_categories" FOR INSERT WITH CHECK (("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can create tasks" ON "public"."tasks" FOR INSERT WITH CHECK (("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can create the journal draft" ON "public"."journal_drafts" FOR INSERT WITH CHECK (("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can delete files" ON "public"."files" FOR DELETE USING ((("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])) AND (NOT "is_journal")));



CREATE POLICY "editors and owners can delete folders" ON "public"."folders" FOR DELETE USING (("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can delete task categories" ON "public"."task_categories" FOR DELETE USING (("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can delete tasks" ON "public"."tasks" FOR DELETE USING (("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can rename folders" ON "public"."folders" FOR UPDATE USING (("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can unassign tasks" ON "public"."task_assignees" FOR DELETE USING (("public"."project_role"("public"."task_project_id"("task_id")) = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can update files" ON "public"."files" FOR UPDATE USING (("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can update task categories" ON "public"."task_categories" FOR UPDATE USING (("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can update tasks" ON "public"."tasks" FOR UPDATE USING (("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can update the journal draft" ON "public"."journal_drafts" FOR UPDATE USING (("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



CREATE POLICY "editors and owners can upload files" ON "public"."files" FOR INSERT WITH CHECK ((("uploaded_by" = "auth"."uid"()) AND ("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"]))));



CREATE POLICY "editors and owners can view the journal draft" ON "public"."journal_drafts" FOR SELECT USING (("public"."project_role"("project_id") = ANY (ARRAY['owner'::"text", 'editor'::"text"])));



ALTER TABLE "public"."error_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."files" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."folders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."forum_post_likes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."forum_posts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."forum_replies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."forum_reply_likes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ghost_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."journal_drafts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "members can view fellow project members" ON "public"."project_members" FOR SELECT USING ("public"."is_project_member"("project_id"));



CREATE POLICY "members can view profiles of fellow project members" ON "public"."profiles" FOR SELECT USING ("public"."shares_project_with"("id"));



CREATE POLICY "members can view their projects" ON "public"."projects" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."project_members"
  WHERE (("project_members"."project_id" = "projects"."id") AND ("project_members"."user_id" = "auth"."uid"())))));



CREATE POLICY "money editors can create bom items" ON "public"."bom_items" FOR INSERT WITH CHECK ("public"."can_edit_money"("project_id"));



CREATE POLICY "money editors can create ghost members" ON "public"."ghost_members" FOR INSERT WITH CHECK ("public"."can_edit_money"("project_id"));



CREATE POLICY "money editors can create transactions" ON "public"."transactions" FOR INSERT WITH CHECK ("public"."can_edit_money"("project_id"));



CREATE POLICY "money editors can delete bom items" ON "public"."bom_items" FOR DELETE USING ("public"."can_edit_money"("project_id"));



CREATE POLICY "money editors can delete ghost members" ON "public"."ghost_members" FOR DELETE USING ("public"."can_edit_money"("project_id"));



CREATE POLICY "money editors can delete transactions" ON "public"."transactions" FOR DELETE USING ("public"."can_edit_money"("project_id"));



CREATE POLICY "money editors can update bom items" ON "public"."bom_items" FOR UPDATE USING ("public"."can_edit_money"("project_id"));



CREATE POLICY "money editors can update ghost members" ON "public"."ghost_members" FOR UPDATE USING ("public"."can_edit_money"("project_id"));



CREATE POLICY "money editors can update member contributions" ON "public"."project_members" FOR UPDATE USING ("public"."can_edit_money"("project_id"));



CREATE POLICY "money editors can update transactions" ON "public"."transactions" FOR UPDATE USING ("public"."can_edit_money"("project_id"));



CREATE POLICY "owner can delete their project" ON "public"."projects" FOR DELETE USING (("owner_id" = "auth"."uid"()));



CREATE POLICY "owner can update their project" ON "public"."projects" FOR UPDATE USING (("owner_id" = "auth"."uid"()));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project members can view bom items" ON "public"."bom_items" FOR SELECT USING ("public"."is_project_member"("project_id"));



CREATE POLICY "project members can view files" ON "public"."files" FOR SELECT USING ("public"."is_project_member"("project_id"));



CREATE POLICY "project members can view folders" ON "public"."folders" FOR SELECT USING ("public"."is_project_member"("project_id"));



CREATE POLICY "project members can view ghost members" ON "public"."ghost_members" FOR SELECT USING ("public"."is_project_member"("project_id"));



CREATE POLICY "project members can view task assignees" ON "public"."task_assignees" FOR SELECT USING ("public"."is_project_member"("public"."task_project_id"("task_id")));



CREATE POLICY "project members can view task categories" ON "public"."task_categories" FOR SELECT USING ("public"."is_project_member"("project_id"));



CREATE POLICY "project members can view tasks" ON "public"."tasks" FOR SELECT USING ("public"."is_project_member"("project_id"));



CREATE POLICY "project members can view transactions" ON "public"."transactions" FOR SELECT USING ("public"."is_project_member"("project_id"));



CREATE POLICY "project owner can add members" ON "public"."project_members" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."projects"
  WHERE (("projects"."id" = "project_members"."project_id") AND ("projects"."owner_id" = "auth"."uid"())))));



CREATE POLICY "project owner can remove members" ON "public"."project_members" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."projects"
  WHERE (("projects"."id" = "project_members"."project_id") AND ("projects"."owner_id" = "auth"."uid"())))));



ALTER TABLE "public"."project_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."task_assignees" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."task_categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users can create their own forum posts" ON "public"."forum_posts" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "author_id"));



CREATE POLICY "users can create their own forum replies" ON "public"."forum_replies" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "author_id") AND (EXISTS ( SELECT 1
   FROM "public"."forum_posts"
  WHERE (("forum_posts"."id" = "forum_replies"."post_id") AND ("forum_posts"."deleted_at" IS NULL))))));



CREATE POLICY "users can insert own profile" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "users can like active forum posts" ON "public"."forum_post_likes" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM "public"."forum_posts"
  WHERE (("forum_posts"."id" = "forum_post_likes"."post_id") AND ("forum_posts"."deleted_at" IS NULL))))));



CREATE POLICY "users can like active forum replies" ON "public"."forum_reply_likes" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM ("public"."forum_replies"
     JOIN "public"."forum_posts" ON (("forum_posts"."id" = "forum_replies"."post_id")))
  WHERE (("forum_replies"."id" = "forum_reply_likes"."reply_id") AND ("forum_replies"."deleted_at" IS NULL) AND ("forum_posts"."deleted_at" IS NULL))))));



CREATE POLICY "users can read own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "users can remove their forum post likes" ON "public"."forum_post_likes" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "users can remove their forum reply likes" ON "public"."forum_reply_likes" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_bulk_transaction_with_lines"("p_project_id" "uuid", "p_member_id" "uuid", "p_ghost_member_id" "uuid", "p_transaction_date" "date", "p_label" "text", "p_total" numeric, "p_supplier" "text", "p_item_url" "text", "p_lines" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_bulk_transaction_with_lines"("p_project_id" "uuid", "p_member_id" "uuid", "p_ghost_member_id" "uuid", "p_transaction_date" "date", "p_label" "text", "p_total" numeric, "p_supplier" "text", "p_item_url" "text", "p_lines" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_bulk_transaction_with_lines"("p_project_id" "uuid", "p_member_id" "uuid", "p_ghost_member_id" "uuid", "p_transaction_date" "date", "p_label" "text", "p_total" numeric, "p_supplier" "text", "p_item_url" "text", "p_lines" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_task_with_assignees"("p_project_id" "uuid", "p_name" "text", "p_category" "text", "p_description" "text", "p_start_date" "date", "p_deadline" "date", "p_deadline_time" time without time zone, "p_status" "text", "p_user_ids" "uuid"[], "p_ghost_member_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_task_with_assignees"("p_project_id" "uuid", "p_name" "text", "p_category" "text", "p_description" "text", "p_start_date" "date", "p_deadline" "date", "p_deadline_time" time without time zone, "p_status" "text", "p_user_ids" "uuid"[], "p_ghost_member_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_task_with_assignees"("p_project_id" "uuid", "p_name" "text", "p_category" "text", "p_description" "text", "p_start_date" "date", "p_deadline" "date", "p_deadline_time" time without time zone, "p_status" "text", "p_user_ids" "uuid"[], "p_ghost_member_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."public_project_files"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."public_project_files"("p_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."public_project_files"("p_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."public_project_get"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."public_project_get"("p_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."public_project_get"("p_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."public_project_list"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."public_project_list"() TO "anon";
GRANT ALL ON FUNCTION "public"."public_project_list"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."replace_bulk_transaction_with_lines"("p_transaction_id" "uuid", "p_member_id" "uuid", "p_ghost_member_id" "uuid", "p_transaction_date" "date", "p_label" "text", "p_total" numeric, "p_supplier" "text", "p_item_url" "text", "p_lines" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_bulk_transaction_with_lines"("p_transaction_id" "uuid", "p_member_id" "uuid", "p_ghost_member_id" "uuid", "p_transaction_date" "date", "p_label" "text", "p_total" numeric, "p_supplier" "text", "p_item_url" "text", "p_lines" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_bulk_transaction_with_lines"("p_transaction_id" "uuid", "p_member_id" "uuid", "p_ghost_member_id" "uuid", "p_transaction_date" "date", "p_label" "text", "p_total" numeric, "p_supplier" "text", "p_item_url" "text", "p_lines" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_transaction_deleted"("p_transaction_id" "uuid", "p_deleted_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_transaction_deleted"("p_transaction_id" "uuid", "p_deleted_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_transaction_deleted"("p_transaction_id" "uuid", "p_deleted_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."soft_delete_folder_tree"("p_project_id" "uuid", "p_folder_id" "uuid", "p_deleted_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."soft_delete_folder_tree"("p_project_id" "uuid", "p_folder_id" "uuid", "p_deleted_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."soft_delete_folder_tree"("p_project_id" "uuid", "p_folder_id" "uuid", "p_deleted_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_task_with_assignees"("p_task_id" "uuid", "p_name" "text", "p_category" "text", "p_description" "text", "p_start_date" "date", "p_deadline" "date", "p_deadline_time" time without time zone, "p_status" "text", "p_user_ids" "uuid"[], "p_ghost_member_ids" "uuid"[], "p_kept_deleted_assignee_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_task_with_assignees"("p_task_id" "uuid", "p_name" "text", "p_category" "text", "p_description" "text", "p_start_date" "date", "p_deadline" "date", "p_deadline_time" time without time zone, "p_status" "text", "p_user_ids" "uuid"[], "p_ghost_member_ids" "uuid"[], "p_kept_deleted_assignee_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_task_with_assignees"("p_task_id" "uuid", "p_name" "text", "p_category" "text", "p_description" "text", "p_start_date" "date", "p_deadline" "date", "p_deadline_time" time without time zone, "p_status" "text", "p_user_ids" "uuid"[], "p_ghost_member_ids" "uuid"[], "p_kept_deleted_assignee_ids" "uuid"[]) TO "service_role";



GRANT ALL ON TABLE "public"."bom_items" TO "anon";
GRANT ALL ON TABLE "public"."bom_items" TO "authenticated";
GRANT ALL ON TABLE "public"."bom_items" TO "service_role";



GRANT ALL ON TABLE "public"."error_reports" TO "anon";
GRANT ALL ON TABLE "public"."error_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."error_reports" TO "service_role";



GRANT ALL ON TABLE "public"."files" TO "anon";
GRANT ALL ON TABLE "public"."files" TO "authenticated";
GRANT ALL ON TABLE "public"."files" TO "service_role";



GRANT ALL ON TABLE "public"."folders" TO "anon";
GRANT ALL ON TABLE "public"."folders" TO "authenticated";
GRANT ALL ON TABLE "public"."folders" TO "service_role";



GRANT ALL ON TABLE "public"."forum_post_likes" TO "anon";
GRANT ALL ON TABLE "public"."forum_post_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."forum_post_likes" TO "service_role";



GRANT ALL ON TABLE "public"."forum_posts" TO "anon";
GRANT ALL ON TABLE "public"."forum_posts" TO "authenticated";
GRANT ALL ON TABLE "public"."forum_posts" TO "service_role";



GRANT ALL ON TABLE "public"."forum_replies" TO "anon";
GRANT ALL ON TABLE "public"."forum_replies" TO "authenticated";
GRANT ALL ON TABLE "public"."forum_replies" TO "service_role";



GRANT ALL ON TABLE "public"."forum_reply_likes" TO "anon";
GRANT ALL ON TABLE "public"."forum_reply_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."forum_reply_likes" TO "service_role";



GRANT ALL ON TABLE "public"."ghost_members" TO "anon";
GRANT ALL ON TABLE "public"."ghost_members" TO "authenticated";
GRANT ALL ON TABLE "public"."ghost_members" TO "service_role";



GRANT ALL ON TABLE "public"."journal_drafts" TO "anon";
GRANT ALL ON TABLE "public"."journal_drafts" TO "authenticated";
GRANT ALL ON TABLE "public"."journal_drafts" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."project_members" TO "anon";
GRANT ALL ON TABLE "public"."project_members" TO "authenticated";
GRANT ALL ON TABLE "public"."project_members" TO "service_role";



GRANT ALL ON TABLE "public"."projects" TO "anon";
GRANT ALL ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



GRANT ALL ON TABLE "public"."task_assignees" TO "anon";
GRANT ALL ON TABLE "public"."task_assignees" TO "authenticated";
GRANT ALL ON TABLE "public"."task_assignees" TO "service_role";



GRANT ALL ON TABLE "public"."task_categories" TO "anon";
GRANT ALL ON TABLE "public"."task_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."task_categories" TO "service_role";



GRANT ALL ON TABLE "public"."tasks" TO "anon";
GRANT ALL ON TABLE "public"."tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."tasks" TO "service_role";



GRANT ALL ON TABLE "public"."transactions" TO "anon";
GRANT ALL ON TABLE "public"."transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."transactions" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







