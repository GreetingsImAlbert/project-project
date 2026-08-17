-- Journal collections: protected storage folder, group/personal metadata,
-- journal-scoped drafts, and database-enforced mutation boundaries.

alter table public.folders
  add column if not exists is_journals_folder boolean not null default false;

alter table public.folders
  drop constraint if exists folders_journals_folder_root_check;
alter table public.folders
  add constraint folders_journals_folder_root_check
  check (not is_journals_folder or parent_folder_id is null);

create unique index if not exists folders_one_journals_folder_per_project
  on public.folders (project_id)
  where is_journals_folder;

alter table public.files
  add column if not exists journal_kind text,
  add column if not exists journal_visibility text;

insert into public.folders (project_id, name, parent_folder_id, is_journals_folder)
select distinct f.project_id, 'journals', null::uuid, true
from public.files f
where f.is_journal
on conflict do nothing;

update public.files f
set journal_kind = 'group',
    journal_visibility = null,
    filename = 'JOURNAL.md',
    is_public = false,
    folder_id = jf.id
from public.folders jf
where f.is_journal
  and f.project_id = jf.project_id
  and jf.is_journals_folder;

alter table public.files
  drop constraint if exists files_journal_metadata_check;
alter table public.files
  add constraint files_journal_metadata_check check (
    (not is_journal and journal_kind is null and journal_visibility is null)
    or (is_journal and journal_kind = 'group' and journal_visibility is null)
    or (is_journal and journal_kind = 'personal'
        and (uploaded_by is not null or uploader_deleted_at is not null)
        and journal_visibility in ('private', 'members', 'public'))
  );

drop index if exists public.journal_file_unique_per_project;
create unique index if not exists files_one_active_group_journal
  on public.files (project_id)
  where is_journal and journal_kind = 'group' and deleted_at is null;
create unique index if not exists files_one_active_personal_journal_per_creator
  on public.files (project_id, uploaded_by)
  where is_journal and journal_kind = 'personal' and deleted_at is null;

alter table public.files
  drop constraint if exists files_id_project_id_key;
alter table public.files
  add constraint files_id_project_id_key unique (id, project_id);

alter table public.journal_drafts
  add column if not exists journal_file_id uuid;

update public.journal_drafts jd
set journal_file_id = f.id
from public.files f
where jd.project_id = f.project_id
  and f.is_journal
  and f.journal_kind = 'group'
  and f.deleted_at is null
  and jd.journal_file_id is null;

do $$
begin
  if exists (select 1 from public.journal_drafts where journal_file_id is null) then
    raise exception 'journal overhaul aborted: draft without an active group journal';
  end if;
end;
$$;

alter table public.journal_drafts
  alter column journal_file_id set not null;
alter table public.journal_drafts
  drop constraint if exists journal_drafts_pkey;
alter table public.journal_drafts
  add constraint journal_drafts_pkey primary key (journal_file_id);
alter table public.journal_drafts
  drop constraint if exists journal_drafts_file_project_fkey;
alter table public.journal_drafts
  add constraint journal_drafts_file_project_fkey
  foreign key (journal_file_id, project_id)
  references public.files (id, project_id)
  on delete cascade;
create index if not exists journal_drafts_project_id_idx
  on public.journal_drafts (project_id);

drop policy if exists "project members can view files" on public.files;
create policy "project members can view permitted files" on public.files
  for select using (
    public.is_project_member(project_id)
    and (
      not is_journal
      or journal_kind = 'group'
      or uploaded_by = auth.uid()
      or journal_visibility in ('members', 'public')
    )
  );

drop policy if exists "editors and owners can upload files" on public.files;
create policy "editors and owners can upload normal files" on public.files
  for insert with check (
    uploaded_by = auth.uid()
    and public.project_role(project_id) in ('owner', 'editor')
    and not is_journal
    and journal_kind is null
    and journal_visibility is null
  );

drop policy if exists "editors and owners can update files" on public.files;
create policy "permitted users can update files" on public.files
  for update using (
    (not is_journal and public.project_role(project_id) in ('owner', 'editor'))
    or (is_journal and journal_kind = 'group' and public.project_role(project_id) in ('owner', 'editor'))
    or (is_journal and journal_kind = 'personal'
        and (uploaded_by = auth.uid() or public.project_role(project_id) = 'owner'))
  ) with check (
    (not is_journal and public.project_role(project_id) in ('owner', 'editor'))
    or (is_journal and journal_kind = 'group' and public.project_role(project_id) in ('owner', 'editor'))
    or (is_journal and journal_kind = 'personal'
        and (uploaded_by = auth.uid() or public.project_role(project_id) = 'owner'))
  );

drop policy if exists "editors and owners can delete files" on public.files;
create policy "permitted users can permanently delete files" on public.files
  for delete using (
    (not is_journal and public.project_role(project_id) in ('owner', 'editor'))
    or (is_journal and journal_kind = 'personal'
        and (uploaded_by = auth.uid() or public.project_role(project_id) = 'owner'))
  );

create or replace function public.protect_journal_file_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not old.is_journal or auth.role() = 'service_role' then
    return new;
  end if;

  if new.project_id is distinct from old.project_id
     or new.filename is distinct from old.filename
     or new.r2_key is distinct from old.r2_key
     or new.mime_type is distinct from old.mime_type
     or new.storage_provider is distinct from old.storage_provider
     or new.created_at is distinct from old.created_at
     or new.is_journal is distinct from old.is_journal
     or new.journal_kind is distinct from old.journal_kind
     or new.is_public is distinct from false then
    raise exception 'journal file structure is protected';
  end if;

  if old.journal_kind = 'group' then
    if new.deleted_at is distinct from old.deleted_at
       or new.journal_visibility is distinct from old.journal_visibility
       or new.folder_id is distinct from old.folder_id then
      raise exception 'group journal structure is protected';
    end if;
    if new.uploaded_by is distinct from old.uploaded_by
       and new.uploaded_by is distinct from (select owner_id from public.projects where id = old.project_id) then
      raise exception 'the group journal must be attributed to the project owner';
    end if;
    if new.uploader_deleted_at is distinct from old.uploader_deleted_at
       and not (new.uploaded_by is distinct from old.uploaded_by and new.uploader_deleted_at is null) then
      raise exception 'group journal deletion attribution is protected';
    end if;
  else
    if new.uploaded_by is distinct from old.uploaded_by
       or new.folder_id is distinct from old.folder_id
       or new.uploader_deleted_at is distinct from old.uploader_deleted_at then
      raise exception 'personal journal ownership and location are protected';
    end if;
    if new.journal_visibility is distinct from old.journal_visibility
       and old.uploaded_by is distinct from auth.uid() then
      raise exception 'only the creator may change journal visibility';
    end if;
    if new.size_bytes is distinct from old.size_bytes
       and old.uploaded_by is distinct from auth.uid() then
      raise exception 'only the creator may edit a personal journal';
    end if;
    if new.deleted_at is distinct from old.deleted_at
       and old.uploaded_by is distinct from auth.uid()
       and public.project_role(old.project_id) <> 'owner' then
      raise exception 'only the creator or project owner may delete a personal journal';
    end if;
  end if;

  return new;
end;
$$;

-- Ownership transfer changes only the group journal's quota attribution.
create or replace function public.transfer_project_ownership(
  p_project_id uuid,
  p_new_owner_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_owner_id uuid;
  v_new_owner_pending_deletion_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select owner_id into v_current_owner_id
  from public.projects
  where id = p_project_id
  for update;
  if not found then raise exception 'Project not found'; end if;
  if v_current_owner_id is distinct from auth.uid() then
    raise exception 'Only the current project owner can transfer ownership';
  end if;
  if p_new_owner_id = v_current_owner_id then
    raise exception 'Choose another project member as the new owner';
  end if;

  select profile.pending_deletion_at into v_new_owner_pending_deletion_at
  from public.project_members member
  join public.profiles profile on profile.id = member.user_id
  where member.project_id = p_project_id and member.user_id = p_new_owner_id;
  if not found then raise exception 'The new owner must be a current project member'; end if;
  if v_new_owner_pending_deletion_at is not null then
    raise exception 'The selected member has an account deletion pending';
  end if;

  update public.project_members set role = 'owner'
  where project_id = p_project_id and user_id = p_new_owner_id;
  update public.project_members set role = 'editor'
  where project_id = p_project_id and user_id = v_current_owner_id;
  update public.projects set owner_id = p_new_owner_id where id = p_project_id;
  update public.files
  set uploaded_by = p_new_owner_id, uploader_deleted_at = null
  where project_id = p_project_id and is_journal and journal_kind = 'group';
end;
$$;

drop trigger if exists protect_journal_file_update on public.files;
create trigger protect_journal_file_update
before update on public.files
for each row execute function public.protect_journal_file_update();

drop policy if exists "editors and owners can create folders" on public.folders;
create policy "editors and owners can create folders" on public.folders
  for insert with check (
    public.project_role(project_id) in ('owner', 'editor')
    and not is_journals_folder
  );
drop policy if exists "editors and owners can rename folders" on public.folders;
create policy "editors and owners can rename folders" on public.folders
  for update using (
    public.project_role(project_id) in ('owner', 'editor')
    and not is_journals_folder
  ) with check (not is_journals_folder);
drop policy if exists "editors and owners can delete folders" on public.folders;
create policy "editors and owners can delete folders" on public.folders
  for delete using (
    public.project_role(project_id) in ('owner', 'editor')
    and not is_journals_folder
  );

drop policy if exists "editors and owners can create the journal draft" on public.journal_drafts;
drop policy if exists "editors and owners can update the journal draft" on public.journal_drafts;
drop policy if exists "editors and owners can view the journal draft" on public.journal_drafts;

create policy "members can view permitted journal drafts" on public.journal_drafts
  for select using (exists (
    select 1 from public.files f
    where f.id = journal_file_id
      and f.project_id = journal_drafts.project_id
      and f.deleted_at is null
      and public.is_project_member(f.project_id)
      and (
        f.journal_kind = 'group'
        or f.uploaded_by = auth.uid()
        or f.journal_visibility in ('members', 'public')
      )
  ));

create policy "permitted users can create journal drafts" on public.journal_drafts
  for insert with check (exists (
    select 1 from public.files f
    where f.id = journal_file_id
      and f.project_id = journal_drafts.project_id
      and f.deleted_at is null
      and (
        (f.journal_kind = 'group' and public.project_role(f.project_id) in ('owner', 'editor'))
        or (f.journal_kind = 'personal' and f.uploaded_by = auth.uid()
            and public.is_project_member(f.project_id))
      )
  ));

create policy "permitted users can update journal drafts" on public.journal_drafts
  for update using (exists (
    select 1 from public.files f
    where f.id = journal_file_id
      and f.project_id = journal_drafts.project_id
      and f.deleted_at is null
      and (
        (f.journal_kind = 'group' and public.project_role(f.project_id) in ('owner', 'editor'))
        or (f.journal_kind = 'personal' and f.uploaded_by = auth.uid()
            and public.is_project_member(f.project_id))
      )
  ));

create policy "permitted users can delete journal drafts" on public.journal_drafts
  for delete using (exists (
    select 1 from public.files f
    where f.id = journal_file_id
      and f.journal_kind = 'personal'
      and (f.uploaded_by = auth.uid() or public.project_role(f.project_id) = 'owner')
  ));

create or replace function public.soft_delete_folder_tree(
  p_project_id uuid,
  p_folder_id uuid,
  p_deleted_at timestamp with time zone
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
      select id from public.folders
      where id = p_folder_id and project_id = p_project_id
      union
      select child.id
      from public.folders child
      join folder_tree parent on parent.id = child.parent_folder_id
      where child.project_id = p_project_id
    )
    select id from folder_tree
  ) tree;

  if cardinality(folder_ids) = 0 then
    raise exception 'folder not found';
  end if;
  if exists (
    select 1 from public.folders
    where id = any(folder_ids) and is_journals_folder
  ) or exists (
    select 1 from public.files
    where project_id = p_project_id and folder_id = any(folder_ids) and is_journal
  ) then
    raise exception 'the journals folder and journal files are protected';
  end if;

  update public.files
  set deleted_at = p_deleted_at
  where project_id = p_project_id
    and folder_id = any(folder_ids)
    and deleted_at is null
    and not is_journal;

  update public.folders
  set deleted_at = p_deleted_at
  where project_id = p_project_id
    and id = any(folder_ids)
    and deleted_at is null
    and not is_journals_folder;
end;
$$;
