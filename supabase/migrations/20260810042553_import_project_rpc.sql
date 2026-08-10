-- Task 10: atomic insertion of an already validated, remapped project import.
-- The Worker stages R2 objects first, then calls this service-role-only RPC. Any
-- error aborts the function transaction, so no partial project rows can remain.

create or replace function public.import_project(
  p_importer_id uuid,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_project jsonb;
  v_member jsonb;
  v_project_id uuid;
  v_owner_id uuid;
  v_file_bytes bigint;
  v_inserted bigint;
  v_record_count bigint := 0;
  v_key text;
begin
  if p_importer_id is null then
    raise exception 'invalid importer';
  end if;

  -- Direct authenticated callers cannot choose a different owner. The import
  -- endpoint uses service_role, where auth.uid() is null, so it supplies the
  -- already authenticated user ID explicitly and checks it against the payload.
  if auth.uid() is not null and auth.uid() <> p_importer_id then
    raise exception 'forbidden';
  end if;

  if not exists (select 1 from public.profiles where id = p_importer_id) then
    raise exception 'importer profile not found';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'invalid import payload';
  end if;

  if (
    select count(*) from jsonb_object_keys(p_payload)
  ) <> 12 or not (
    p_payload ? 'project'
    and p_payload ? 'projectMember'
    and p_payload ? 'ghostMembers'
    and p_payload ? 'folders'
    and p_payload ? 'files'
    and p_payload ? 'bomItems'
    and p_payload ? 'transactions'
    and p_payload ? 'tasks'
    and p_payload ? 'taskAssignees'
    and p_payload ? 'taskCategories'
    and p_payload ? 'taskCategoryPositions'
    and p_payload ? 'journalDraft'
  ) then
    raise exception 'invalid import payload fields';
  end if;

  v_project := p_payload->'project';
  if jsonb_typeof(v_project) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(v_project)) <> 9
    or not (
      v_project ? 'id'
      and v_project ? 'name'
      and v_project ? 'description'
      and v_project ? 'owner_id'
      and v_project ? 'currency'
      and v_project ? 'is_public'
      and v_project ? 'public_files_enabled'
      and v_project ? 'created_at'
      and v_project ? 'updated_at'
    ) then
    raise exception 'invalid project payload';
  end if;

  v_project_id := (v_project->>'id')::uuid;
  v_owner_id := (v_project->>'owner_id')::uuid;

  if v_project_id is null then
    raise exception 'invalid project ID';
  end if;
  if v_owner_id is distinct from p_importer_id then
    raise exception 'import owner does not match authenticated importer';
  end if;
  if jsonb_typeof(v_project->'name') is distinct from 'string'
    or coalesce(length(v_project->>'name'), 0) = 0
    or length(v_project->>'name') > 200 then
    raise exception 'invalid project name';
  end if;
  if jsonb_typeof(v_project->'description') not in ('string', 'null')
    or length(coalesce(v_project->>'description', '')) > 2000 then
    raise exception 'invalid project description';
  end if;
  if jsonb_typeof(v_project->'currency') is distinct from 'string'
    or v_project->>'currency' not in ('PHP', 'USD') then
    raise exception 'invalid project currency';
  end if;
  if jsonb_typeof(v_project->'is_public') is distinct from 'boolean'
    or jsonb_typeof(v_project->'public_files_enabled') is distinct from 'boolean'
    or v_project->>'is_public' is distinct from 'false'
    or v_project->>'public_files_enabled' is distinct from 'false' then
    raise exception 'imported project must be private';
  end if;
  if jsonb_typeof(v_project->'created_at') not in ('string', 'null')
    or jsonb_typeof(v_project->'updated_at') not in ('string', 'null') then
    raise exception 'invalid project timestamps';
  end if;
  if exists (select 1 from public.projects where id = v_project_id) then
    raise exception 'project ID already exists';
  end if;

  v_member := p_payload->'projectMember';
  if jsonb_typeof(v_member) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(v_member)) <> 6
    or not (
      v_member ? 'project_id'
      and v_member ? 'user_id'
      and v_member ? 'role'
      and v_member ? 'is_auditor'
      and v_member ? 'contribution_percent'
      and v_member ? 'joined_at'
    ) then
    raise exception 'invalid importer membership payload';
  end if;
  if (v_member->>'project_id')::uuid is distinct from v_project_id
    or (v_member->>'user_id')::uuid is distinct from p_importer_id
    or jsonb_typeof(v_member->'role') is distinct from 'string'
    or v_member->>'role' <> 'owner'
    or jsonb_typeof(v_member->'is_auditor') is distinct from 'boolean'
    or v_member->>'is_auditor' is distinct from 'false'
    or v_member->'contribution_percent' is null
    or jsonb_typeof(v_member->'contribution_percent') is distinct from 'null' then
    raise exception 'invalid importer membership';
  end if;

  foreach v_key in array array[
    'ghostMembers', 'folders', 'files', 'bomItems', 'transactions',
    'tasks', 'taskAssignees', 'taskCategories', 'taskCategoryPositions'
  ]::text[] loop
    if jsonb_typeof(p_payload->v_key) is distinct from 'array' then
      raise exception 'invalid import array: %', v_key;
    end if;
    if jsonb_array_length(p_payload->v_key) > 50000 then
      raise exception 'import array is too large: %', v_key;
    end if;
    v_record_count := v_record_count + jsonb_array_length(p_payload->v_key);
  end loop;
  if v_record_count > 500000 then
    raise exception 'import contains too many records';
  end if;

  if jsonb_typeof(p_payload->'journalDraft') not in ('object', 'null') then
    raise exception 'invalid journal draft payload';
  end if;

  if jsonb_array_length(p_payload->'ghostMembers') > 20 then
    raise exception 'project ghost-member limit exceeded';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_payload->'ghostMembers') as g(
      id uuid, project_id uuid, display_name text, note text,
      contribution_percent numeric, is_deleted_account boolean, created_at timestamptz
    )
    where g.project_id is distinct from v_project_id
      or g.display_name is null
      or length(btrim(g.display_name)) = 0
      or length(g.display_name) > 80
      or length(coalesce(g.note, '')) > 200
      or g.is_deleted_account is null
  ) then
    raise exception 'invalid ghost-member payload';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_payload->'folders') as f(
      id uuid, project_id uuid, name text, parent_folder_id uuid,
      created_at timestamptz, deleted_at timestamptz
    )
    where f.project_id is distinct from v_project_id or f.name is null or length(f.name) > 255
  ) then
    raise exception 'invalid folder payload';
  end if;

  select coalesce(sum(f.size_bytes), 0)::bigint
    into v_file_bytes
  from jsonb_to_recordset(p_payload->'files') as f(
    id uuid, project_id uuid, folder_id uuid, uploaded_by uuid,
    filename text, mime_type text, size_bytes bigint, storage_provider text,
    uploader_deleted_at timestamptz, created_at timestamptz, deleted_at timestamptz,
    is_public boolean, is_journal boolean, r2_key text
  );
  if v_file_bytes > 80000000 then
    raise exception 'import file bytes exceed the project limit';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_payload->'files') as f(
      id uuid, project_id uuid, folder_id uuid, uploaded_by uuid,
      filename text, mime_type text, size_bytes bigint, storage_provider text,
      uploader_deleted_at timestamptz, created_at timestamptz, deleted_at timestamptz,
      is_public boolean, is_journal boolean, r2_key text
    )
    where f.project_id is distinct from v_project_id
      or f.uploaded_by is distinct from p_importer_id
      or f.filename is null
      or length(f.filename) > 255
      or f.size_bytes is null
      or f.size_bytes < 0
      or f.size_bytes > 80000000
      or f.storage_provider <> 'r2'
      or f.uploader_deleted_at is not null
      or f.is_public is distinct from false
      or f.r2_key is null
      or f.r2_key not like v_project_id::text || '/%'
  ) then
    raise exception 'invalid file payload';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_payload->'bomItems') as b(
      id uuid, project_id uuid, part_name text, category text, description text,
      quantity numeric, unit text, unit_cost numeric, supplier text,
      item_url text, created_at timestamptz, deleted_at timestamptz
    )
    where b.project_id is distinct from v_project_id or b.part_name is null
  ) then
    raise exception 'invalid BOM payload';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_payload->'tasks') as t(
      id uuid, project_id uuid, name text, category text, priority_position bigint,
      description text, start_date date, start_time time, deadline date,
      deadline_time time, status text, created_at timestamptz, deleted_at timestamptz
    )
    where t.project_id is distinct from v_project_id
      or t.name is null
      or t.priority_position < 0
      or t.status not in ('ongoing', 'done')
  ) then
    raise exception 'invalid task payload';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_payload->'taskCategories') as c(
      project_id uuid, name text, color_index smallint
    )
    where c.project_id is distinct from v_project_id
      or c.name is null
      or c.color_index < 0
      or c.color_index > 9
  ) then
    raise exception 'invalid task-category payload';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_payload->'taskCategoryPositions') as c(
      id uuid, project_id uuid, category_name text, priority_position bigint,
      created_at timestamptz
    )
    where c.project_id is distinct from v_project_id or c.priority_position < 0
  ) then
    raise exception 'invalid task-category-position payload';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_payload->'taskAssignees') as a(
      id uuid, task_id uuid, user_id uuid, ghost_member_id uuid,
      deleted_display_name text
    )
    where a.user_id is not null
  ) then
    raise exception 'imported task assignees cannot reference source users';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_payload->'transactions') as x(
      id uuid, project_id uuid, member_id uuid, related_member_id uuid,
      ghost_member_id uuid, related_ghost_member_id uuid, group_id uuid,
      transaction_date date, type text, item_name text, quantity numeric,
      unit text, unit_cost numeric, supplier text, item_url text,
      created_at timestamptz, deleted_at timestamptz
    )
    where x.project_id is distinct from v_project_id
      or num_nonnulls(x.member_id, x.ghost_member_id) <> 1
      or x.member_id is not null
      or x.related_member_id is not null
      or num_nonnulls(x.related_member_id, x.related_ghost_member_id) > 1
      or x.type not in ('item', 'shipping', 'discount', 'refund', 'payment', 'bulk')
  ) then
    raise exception 'invalid transaction payload';
  end if;

  if jsonb_typeof(p_payload->'journalDraft') = 'object' and exists (
    select 1
    from jsonb_to_record(p_payload->'journalDraft') as j(
      project_id uuid, draft_date date, content text, updated_at timestamptz,
      updated_by uuid
    )
    where j.project_id is distinct from v_project_id or j.updated_by is distinct from p_importer_id
  ) then
    raise exception 'invalid journal draft payload';
  end if;

  insert into public.projects (
    id, name, description, owner_id, currency, is_public, public_files_enabled,
    created_at, updated_at
  ) values (
    v_project_id,
    v_project->>'name',
    nullif(v_project->>'description', ''),
    p_importer_id,
    v_project->>'currency',
    false,
    false,
    (v_project->>'created_at')::timestamptz,
    (v_project->>'updated_at')::timestamptz
  );

  -- handle_new_project creates this row as well. The upsert keeps the import
  -- correct if a deployment ever omits that trigger while preserving the
  -- importer-only ownership rule.
  insert into public.project_members (
    project_id, user_id, role, is_auditor, contribution_percent, joined_at
  ) values (
    v_project_id,
    p_importer_id,
    'owner',
    false,
    null,
    (v_member->>'joined_at')::timestamptz
  )
  on conflict (project_id, user_id) do update set
    role = excluded.role,
    is_auditor = excluded.is_auditor,
    contribution_percent = excluded.contribution_percent,
    joined_at = excluded.joined_at;

  insert into public.ghost_members (
    id, project_id, display_name, note, contribution_percent,
    is_deleted_account, created_at
  )
  select g.id, g.project_id, g.display_name, g.note, g.contribution_percent,
         g.is_deleted_account, g.created_at
  from jsonb_to_recordset(p_payload->'ghostMembers') as g(
    id uuid, project_id uuid, display_name text, note text,
    contribution_percent numeric, is_deleted_account boolean, created_at timestamptz
  );

  -- Insert folder parents before children, while rejecting cycles or missing
  -- parents through the row-count check.
  with recursive raw as (
    select f.id, f.project_id, f.name, f.parent_folder_id, f.created_at, f.deleted_at
    from jsonb_to_recordset(p_payload->'folders') as f(
      id uuid, project_id uuid, name text, parent_folder_id uuid,
      created_at timestamptz, deleted_at timestamptz
    )
  ), ordered as (
    select raw.*, 0 as depth, array[raw.id] as path
    from raw
    where raw.parent_folder_id is null
    union all
    select child.*, parent.depth + 1, parent.path || child.id
    from raw child
    join ordered parent on parent.id = child.parent_folder_id
    where child.id <> all(parent.path)
  )
  insert into public.folders (
    id, project_id, name, parent_folder_id, created_at, deleted_at
  )
  select id, project_id, name, parent_folder_id, created_at, deleted_at
  from ordered
  order by depth, id;
  get diagnostics v_inserted = row_count;
  if v_inserted <> jsonb_array_length(p_payload->'folders') then
    raise exception 'folder hierarchy is incomplete';
  end if;

  insert into public.files (
    id, project_id, folder_id, uploaded_by, filename, mime_type, size_bytes,
    storage_provider, uploader_deleted_at, created_at, deleted_at, is_public,
    is_journal, r2_key
  )
  select f.id, f.project_id, f.folder_id, f.uploaded_by, f.filename, f.mime_type,
         f.size_bytes, f.storage_provider, f.uploader_deleted_at, f.created_at,
         f.deleted_at, f.is_public, f.is_journal, f.r2_key
  from jsonb_to_recordset(p_payload->'files') as f(
    id uuid, project_id uuid, folder_id uuid, uploaded_by uuid,
    filename text, mime_type text, size_bytes bigint, storage_provider text,
    uploader_deleted_at timestamptz, created_at timestamptz, deleted_at timestamptz,
    is_public boolean, is_journal boolean, r2_key text
  );

  insert into public.bom_items (
    id, project_id, part_name, category, description, quantity, unit, unit_cost,
    supplier, item_url, created_at, deleted_at
  )
  select b.id, b.project_id, b.part_name, b.category, b.description, b.quantity,
         b.unit, b.unit_cost, b.supplier, b.item_url, b.created_at, b.deleted_at
  from jsonb_to_recordset(p_payload->'bomItems') as b(
    id uuid, project_id uuid, part_name text, category text, description text,
    quantity numeric, unit text, unit_cost numeric, supplier text, item_url text,
    created_at timestamptz, deleted_at timestamptz
  );

  insert into public.task_categories (project_id, name, color_index)
  select c.project_id, c.name, c.color_index
  from jsonb_to_recordset(p_payload->'taskCategories') as c(
    project_id uuid, name text, color_index smallint
  );

  insert into public.task_category_positions (
    id, project_id, category_name, priority_position, created_at
  )
  select c.id, c.project_id, c.category_name, c.priority_position, c.created_at
  from jsonb_to_recordset(p_payload->'taskCategoryPositions') as c(
    id uuid, project_id uuid, category_name text, priority_position bigint,
    created_at timestamptz
  );

  insert into public.tasks (
    id, project_id, name, category, priority_position, description, start_date,
    start_time, deadline, deadline_time, status, created_at, deleted_at
  )
  select t.id, t.project_id, t.name, t.category, t.priority_position, t.description,
         t.start_date, t.start_time, t.deadline, t.deadline_time, t.status,
         t.created_at, t.deleted_at
  from jsonb_to_recordset(p_payload->'tasks') as t(
    id uuid, project_id uuid, name text, category text, priority_position bigint,
    description text, start_date date, start_time time, deadline date,
    deadline_time time, status text, created_at timestamptz, deleted_at timestamptz
  );

  insert into public.task_assignees (
    id, task_id, user_id, ghost_member_id, deleted_display_name
  )
  select a.id, a.task_id, a.user_id, a.ghost_member_id, a.deleted_display_name
  from jsonb_to_recordset(p_payload->'taskAssignees') as a(
    id uuid, task_id uuid, user_id uuid, ghost_member_id uuid,
    deleted_display_name text
  );

  -- Transaction group parents must precede their line items, just like folder
  -- parents above. The path prevents malformed cycles from recursing forever.
  with recursive raw as (
    select x.id, x.project_id, x.member_id, x.related_member_id,
           x.ghost_member_id, x.related_ghost_member_id, x.group_id,
           x.transaction_date, x.type, x.item_name, x.quantity, x.unit,
           x.unit_cost, x.supplier, x.item_url, x.created_at, x.deleted_at
    from jsonb_to_recordset(p_payload->'transactions') as x(
      id uuid, project_id uuid, member_id uuid, related_member_id uuid,
      ghost_member_id uuid, related_ghost_member_id uuid, group_id uuid,
      transaction_date date, type text, item_name text, quantity numeric,
      unit text, unit_cost numeric, supplier text, item_url text,
      created_at timestamptz, deleted_at timestamptz
    )
  ), ordered as (
    select raw.*, 0 as depth, array[raw.id] as path
    from raw
    where raw.group_id is null
    union all
    select child.*, parent.depth + 1, parent.path || child.id
    from raw child
    join ordered parent on parent.id = child.group_id
    where child.id <> all(parent.path)
  )
  insert into public.transactions (
    id, project_id, member_id, related_member_id, ghost_member_id,
    related_ghost_member_id, group_id, transaction_date, type, item_name,
    quantity, unit, unit_cost, supplier, item_url, created_at, deleted_at
  )
  select id, project_id, member_id, related_member_id, ghost_member_id,
         related_ghost_member_id, group_id, transaction_date, type, item_name,
         quantity, unit, unit_cost, supplier, item_url, created_at, deleted_at
  from ordered
  order by depth, id;
  get diagnostics v_inserted = row_count;
  if v_inserted <> jsonb_array_length(p_payload->'transactions') then
    raise exception 'transaction groups are incomplete';
  end if;

  if jsonb_typeof(p_payload->'journalDraft') = 'object' then
    insert into public.journal_drafts (
      project_id, draft_date, content, updated_at, updated_by
    )
    select j.project_id, j.draft_date, j.content, j.updated_at, j.updated_by
    from jsonb_to_record(p_payload->'journalDraft') as j(
      project_id uuid, draft_date date, content text, updated_at timestamptz,
      updated_by uuid
    );
  end if;

  return v_project_id;
end;
$function$;

revoke all on function public.import_project(uuid, jsonb) from public;
grant execute on function public.import_project(uuid, jsonb) to service_role;
