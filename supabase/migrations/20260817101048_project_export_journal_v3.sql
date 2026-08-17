-- Project export V3 carries the journal collection as first-class metadata:
-- one protected folder, one group journal, any number of personal history files,
-- and drafts keyed by their journal file ID. Keep the existing row inserter as a
-- private compatibility implementation, then normalize V3 rows in this wrapper
-- inside the same transaction.

alter function public.import_project(uuid, jsonb) rename to import_project_legacy;
revoke all on function public.import_project_legacy(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.import_project_legacy(uuid, jsonb) to service_role;

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
  v_project_id uuid;
  v_journals_folder_id uuid;
  v_folder_count bigint;
  v_group_count bigint;
  v_legacy_folders jsonb;
  v_legacy_files jsonb;
  v_legacy_payload jsonb;
  v_imported_project_id uuid;
begin
  -- Older callers may still provide the V1/V2 remapped payload. Let the
  -- compatibility inserter validate that shape unchanged; the application
  -- remapper emits journalDrafts for all new imports.
  if not (p_payload ? 'journalDrafts') then
    return public.import_project_legacy(p_importer_id, p_payload);
  end if;

  if p_payload is null or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'invalid import payload';
  end if;
  if (select count(*) from jsonb_object_keys(p_payload)) not in (13, 14)
    or not (
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
      and p_payload ? 'journalDrafts'
    ) then
    raise exception 'invalid version 3 import payload fields';
  end if;

  v_project := p_payload->'project';
  v_project_id := (v_project->>'id')::uuid;

  if jsonb_typeof(p_payload->'folders') is distinct from 'array'
    or jsonb_typeof(p_payload->'files') is distinct from 'array'
    or jsonb_typeof(p_payload->'journalDrafts') is distinct from 'array' then
    raise exception 'invalid version 3 journal arrays';
  end if;

  select count(*)
    into v_folder_count
  from jsonb_to_recordset(p_payload->'folders') as f(
    id uuid, project_id uuid, name text, parent_folder_id uuid,
    created_at timestamptz, deleted_at timestamptz, is_journals_folder boolean
  )
  where f.is_journals_folder;
  if v_folder_count <> 1 then
    raise exception 'version 3 import requires exactly one protected journals folder';
  end if;

  select f.id
    into v_journals_folder_id
  from jsonb_to_recordset(p_payload->'folders') as f(
    id uuid, project_id uuid, name text, parent_folder_id uuid,
    created_at timestamptz, deleted_at timestamptz, is_journals_folder boolean
  )
  where f.is_journals_folder;

  if exists (
    select 1
    from jsonb_to_recordset(p_payload->'folders') as f(
      id uuid, project_id uuid, name text, parent_folder_id uuid,
      created_at timestamptz, deleted_at timestamptz, is_journals_folder boolean
    )
    where f.is_journals_folder
      and (f.project_id is distinct from v_project_id
        or f.parent_folder_id is not null
        or f.deleted_at is not null)
  ) then
    raise exception 'invalid protected journals folder';
  end if;

  select count(*)
    into v_group_count
  from jsonb_to_recordset(p_payload->'files') as f(
    id uuid, project_id uuid, folder_id uuid, uploaded_by uuid,
    filename text, mime_type text, size_bytes bigint, storage_provider text,
    uploader_deleted_at timestamptz, created_at timestamptz, deleted_at timestamptz,
    is_public boolean, is_journal boolean, journal_kind text,
    journal_visibility text, r2_key text
  )
  where f.is_journal and f.journal_kind = 'group' and f.deleted_at is null;
  if v_group_count <> 1 then
    raise exception 'version 3 import requires exactly one group journal';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_payload->'files') as f(
      id uuid, project_id uuid, folder_id uuid, uploaded_by uuid,
      filename text, mime_type text, size_bytes bigint, storage_provider text,
      uploader_deleted_at timestamptz, created_at timestamptz, deleted_at timestamptz,
      is_public boolean, is_journal boolean, journal_kind text,
      journal_visibility text, r2_key text
    )
    where f.project_id is distinct from v_project_id
      or f.uploaded_by is distinct from p_importer_id
      or f.uploader_deleted_at is not null
      or f.is_public is distinct from false
      or (not f.is_journal and (f.journal_kind is not null or f.journal_visibility is not null))
      or (f.is_journal and (
        f.folder_id is distinct from v_journals_folder_id
        or f.journal_kind not in ('group', 'personal')
        or (f.journal_kind = 'group' and (f.deleted_at is not null or f.filename <> 'JOURNAL.md' or f.journal_visibility is not null))
        or (f.journal_kind = 'personal' and f.journal_visibility not in ('private', 'members', 'public'))
      ))
  ) then
    raise exception 'invalid version 3 journal file metadata';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_payload->'journalDrafts') as j(
      journal_file_id uuid, project_id uuid, draft_date date, content text,
      updated_at timestamptz, updated_by uuid
    )
    where j.project_id is distinct from v_project_id
      or j.updated_by is distinct from p_importer_id
      or not exists (
        select 1
        from jsonb_to_recordset(p_payload->'files') as f(
          id uuid, project_id uuid, folder_id uuid, uploaded_by uuid,
          filename text, mime_type text, size_bytes bigint, storage_provider text,
          uploader_deleted_at timestamptz, created_at timestamptz, deleted_at timestamptz,
          is_public boolean, is_journal boolean, journal_kind text,
          journal_visibility text, r2_key text
        )
        where f.id = j.journal_file_id
          and f.project_id = v_project_id
          and f.is_journal
          and f.deleted_at is null
      )
  ) then
    raise exception 'invalid version 3 journal draft relationship';
  end if;

  if (
    select count(*) from jsonb_to_recordset(p_payload->'journalDrafts') as j(
      journal_file_id uuid, project_id uuid, draft_date date, content text,
      updated_at timestamptz, updated_by uuid
    )
  ) <> (
    select count(distinct j.journal_file_id)
    from jsonb_to_recordset(p_payload->'journalDrafts') as j(
      journal_file_id uuid, project_id uuid, draft_date date,
      content text, updated_at timestamptz, updated_by uuid
    )
  ) then
    raise exception 'duplicate version 3 journal draft';
  end if;

  -- Feed the established atomic inserter a legacy-shaped payload with journal
  -- metadata temporarily disabled. The follow-up updates and draft insert are
  -- in this function's transaction, so a malformed V3 row cannot leave partial
  -- projects behind.
  select coalesce(jsonb_agg(value - 'is_journals_folder'), '[]'::jsonb)
    into v_legacy_folders
  from jsonb_array_elements(p_payload->'folders') as item(value);

  select coalesce(jsonb_agg(
    (value - 'journal_kind' - 'journal_visibility')
      || jsonb_build_object('is_journal', false)
  ), '[]'::jsonb)
    into v_legacy_files
  from jsonb_array_elements(p_payload->'files') as item(value);

  v_legacy_payload := jsonb_build_object(
    'project', p_payload->'project',
    'projectMember', p_payload->'projectMember',
    'ghostMembers', p_payload->'ghostMembers',
    'folders', v_legacy_folders,
    'files', v_legacy_files,
    'bomItems', p_payload->'bomItems',
    'transactions', p_payload->'transactions',
    'tasks', p_payload->'tasks',
    'taskAssignees', p_payload->'taskAssignees',
    'taskCategories', p_payload->'taskCategories',
    'taskCategoryPositions', p_payload->'taskCategoryPositions',
    'journalDraft', null
  );

  v_imported_project_id := public.import_project_legacy(p_importer_id, v_legacy_payload);

  update public.folders target
  set is_journals_folder = source.is_journals_folder
  from jsonb_to_recordset(p_payload->'folders') as source(
    id uuid, project_id uuid, is_journals_folder boolean
  )
  where target.id = source.id
    and target.project_id = source.project_id
    and source.is_journals_folder;

  update public.files target
  set is_journal = source.is_journal,
      journal_kind = source.journal_kind,
      journal_visibility = source.journal_visibility
  from jsonb_to_recordset(p_payload->'files') as source(
    id uuid, project_id uuid, folder_id uuid, uploaded_by uuid,
    filename text, mime_type text, size_bytes bigint, storage_provider text,
    uploader_deleted_at timestamptz, created_at timestamptz, deleted_at timestamptz,
    is_public boolean, is_journal boolean, journal_kind text,
    journal_visibility text, r2_key text
  )
  where target.id = source.id
    and target.project_id = source.project_id;

  insert into public.journal_drafts (
    journal_file_id, project_id, draft_date, content, updated_at, updated_by
  )
  select j.journal_file_id, j.project_id, j.draft_date, j.content,
         j.updated_at, j.updated_by
  from jsonb_to_recordset(p_payload->'journalDrafts') as j(
    journal_file_id uuid, project_id uuid, draft_date date, content text,
    updated_at timestamptz, updated_by uuid
  );

  return v_imported_project_id;
end;
$function$;

revoke all on function public.import_project(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.import_project(uuid, jsonb) to service_role;

-- Recreate the idempotency wrapper after the rename so its cached call resolves
-- to the V3-aware import_project function rather than the legacy inserter.
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

revoke all on function public.import_project_once(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.import_project_once(uuid, text, jsonb) to service_role;
