-- Keep the canonical owner id, both membership roles, and the system-owned
-- journal file attribution in one transaction. Direct table updates cannot do
-- this safely: the projects update policy correctly prevents an owner from
-- changing owner_id to somebody else.
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
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Locks serialize two transfer attempts and keep the membership checks valid
  -- until every related row has changed.
  select owner_id
  into v_current_owner_id
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception 'Project not found';
  end if;

  if v_current_owner_id is distinct from auth.uid() then
    raise exception 'Only the current project owner can transfer ownership';
  end if;

  if p_new_owner_id = v_current_owner_id then
    raise exception 'Choose another project member as the new owner';
  end if;

  select profile.pending_deletion_at
  into v_new_owner_pending_deletion_at
  from public.project_members member
  join public.profiles profile on profile.id = member.user_id
  where member.project_id = p_project_id
    and member.user_id = p_new_owner_id;

  if not found then
    raise exception 'The new owner must be a current project member';
  end if;

  if v_new_owner_pending_deletion_at is not null then
    raise exception 'The selected member has an account deletion pending';
  end if;

  -- These updates run while the caller is still the canonical owner, so the
  -- member-role guard accepts both changes. The function transaction rolls all
  -- three rows back together if any later statement fails.
  update public.project_members
  set role = 'owner'
  where project_id = p_project_id
    and user_id = p_new_owner_id;

  update public.project_members
  set role = 'editor'
  where project_id = p_project_id
    and user_id = v_current_owner_id;

  update public.projects
  set owner_id = p_new_owner_id
  where id = p_project_id;

  -- Journal files are deliberately attributed to the project owner rather than
  -- the editor who first opened the journal. Move that system attribution too,
  -- or deleting the former owner's account would eventually purge the journal.
  update public.files
  set uploaded_by = p_new_owner_id,
      uploader_deleted_at = null
  where project_id = p_project_id
    and is_journal;
end;
$$;

revoke all on function public.transfer_project_ownership(uuid, uuid) from public;
grant execute on function public.transfer_project_ownership(uuid, uuid) to authenticated;

comment on function public.transfer_project_ownership(uuid, uuid) is
  'Atomically transfers a project to an existing member; callable only by its current owner.';
