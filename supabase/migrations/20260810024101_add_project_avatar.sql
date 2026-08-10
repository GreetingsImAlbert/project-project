alter table public.projects
  add column if not exists avatar text;

comment on column public.projects.avatar is
  'Built-in avatar id or project-scoped object path in the public avatars bucket; NULL uses the owner profile avatar.';

-- The application validates the actual file signature and dimensions. Keep the
-- bucket MIME allow-list aligned with that parser for any direct Storage writes.
update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']::text[]
where id = 'avatars';
