# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

P2 is a project-management web app for engineering students/hobbyists (CAD files, drawings, calculations, BOM, collaboration). Solo project, deployed at p2.albertmendoza.com.

## Task tracking

Every time you create a commit in this repo, first update `CHECKLIST.md` to reflect it — move finished items to Done, add newly-discovered follow-ups, and keep In progress/Next up current. Do this as part of the same commit, not a separate one.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Commands

```
npm run build             # astro build -> ./dist
npm run generate-types    # wrangler types -> worker-configuration.d.ts (Cloudflare bindings/env)
npm run update-types      # supabase gen types -> src/lib/supabase/database.types.ts (Supabase schema)
npx wrangler dev          # deploy locally to 127.0.0.1:8787 using the result of npm run build
```

There is no lint or test script configured in this project.

## Architecture

**Stack:** Astro 7 (SSR, `output: 'server'`) + Svelte 5 for interactive components, deployed to Cloudflare Workers via `@astrojs/cloudflare`. Supabase (Postgres + Auth) is the database/auth provider; Cloudflare R2 holds uploaded files, accessed via presigned S3-style URLs signed with `aws4fetch` (no AWS SDK).

**Request flow / auth:**
- `src/middleware.ts` runs on every request to an app path (`/`, `/login`, `/projects*`, `/api*` — see the allow-list at the top of the file). It builds a per-request Supabase client and calls `supabase.auth.getClaims()` (not `getUser()`/`getSession()` — this verifies the JWT locally against the asymmetric signing key instead of a network round trip), then populates `context.locals.user` (mapped from `claims.sub`/`claims.email`, shape differs from `getUser()`) and `context.locals.supabase`. Paths outside that allow-list skip Supabase entirely to avoid wasting Worker CPU on bot noise.
- `src/lib/supabase/server.ts` creates the session-aware, cookie-bound client used for basically all reads/writes — it respects Postgres RLS policies keyed off the authenticated user.
- `src/lib/supabase/admin.ts` creates a service-role client that bypasses RLS. Used narrowly and deliberately (currently only the email→user lookup in the add-member endpoint) — don't reach for it as a default; prefer `locals.supabase` so RLS stays the enforcement point.
- Every page under `src/pages/` sets `export const prerender = false` and does its own `if (!Astro.locals.user) return Astro.redirect('/login')` — there's no route-group-level guard, so new protected pages must repeat this check.

**Data model** (`src/lib/supabase/database.types.ts`, generated — don't hand-edit): `profiles`, `projects` (`owner_id`), `project_members` (`role`: owner/editor/viewer, composite key on `project_id`+`user_id`), `folders` (self-referential via `parent_folder_id`, not yet browsable in the UI), `files` (`r2_key`, `project_id`, `uploaded_by`), `bom_items` (schema exists, no UI yet). Two `security definer` Postgres functions, `is_project_member` and `shares_project_with`, back RLS policies that would otherwise self-reference their own table and recurse infinitely.

RLS policies and migrations live in Supabase directly, not in this repo (`supabase/` only has a linked-project pointer, no local migration files) — schema changes have to be made/checked against the live project or its dashboard, not by grepping this repo.

**File upload/download flow** (see `src/pages/projects/[id].astro` inline script + the API routes it calls): client asks `POST /api/projects/[id]/files/upload-url` for a presigned R2 PUT URL, `PUT`s the file directly to R2 from the browser, then calls `POST /api/projects/[id]/files/confirm` to insert the `files` row; if that insert fails, the endpoint compensates by deleting the just-uploaded R2 object (no real transaction across R2 + Postgres). Downloads go through `GET /api/files/[fileId]/download-url` for a presigned GET. When touching presigned URLs: don't sign/send `Content-Type`; add query params like `response-content-disposition` before signing, not after.

**Type surface gotchas:**
- `src/env.d.ts` declares `App.Locals` (`supabase`, `user`) — it imports types, so it must stay wrapped in `declare global { ... } / export {}` or it stops being treated as ambient.
- Supabase's generated types can't express one-to-one cardinality through the `project_members` junction table; call sites use `.overrideTypes<...>()` as a manual workaround (see `src/pages/projects/[id].astro`). Don't "fix" this with a unique constraint on `user_id` alone — that would break multi-project membership.

## Supabase Schema / Functions and Triggers / RLS Policies

Current state of tables, functions, triggers, RLS policies, and grants.

## Tables

```sql
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  email text,
  created_at timestamptz default now()
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  owner_id uuid not null references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  joined_at timestamptz default now(),
  primary key (project_id, user_id)
);

create table if not exists folders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  parent_folder_id uuid references folders(id) on delete cascade,
  created_at timestamptz default now()
);

create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  folder_id uuid references folders(id) on delete set null,
  uploaded_by uuid not null references profiles(id),
  filename text not null,
  r2_key text not null unique,
  mime_type text,
  size_bytes bigint,
  storage_provider text not null default 'r2',
  created_at timestamptz default now()
);

create table if not exists bom_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  part_name text not null,
  part_number text,
  quantity numeric,
  unit_cost numeric,
  supplier text,
  link text,
  notes text,
  created_at timestamptz default now()
);
```

## Helper functions

`security definer` — bypass RLS internally to avoid recursion when a policy needs to check membership on the same or a related table.

```sql
create or replace function public.is_project_member(check_project_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from project_members
    where project_id = check_project_id
    and user_id = auth.uid()
  );
$$;

create or replace function public.project_role(check_project_id uuid)
returns text
language sql
security definer
set search_path = public
as $$
  select role from project_members
  where project_id = check_project_id
  and user_id = auth.uid();
$$;

create or replace function public.shares_project_with(target_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from project_members pm1
    join project_members pm2 on pm1.project_id = pm2.project_id
    where pm1.user_id = auth.uid()
    and pm2.user_id = target_user_id
  );
$$;
```

## Triggers

```sql
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, new.raw_user_meta_data->>'display_name', new.email);
  return new;
end;
$$;

create or replace trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.handle_new_project()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;

create or replace trigger on_project_created
after insert on projects
for each row execute function public.handle_new_project();
```

## RLS — profiles

```sql
alter table profiles enable row level security;

drop policy if exists "users can read own profile" on profiles;
create policy "users can read own profile"
on profiles for select
using (auth.uid() = id);

drop policy if exists "users can insert own profile" on profiles;
create policy "users can insert own profile"
on profiles for insert
with check (auth.uid() = id);

drop policy if exists "members can view profiles of fellow project members" on profiles;
create policy "members can view profiles of fellow project members"
on profiles for select
using (public.shares_project_with(id));
```

## RLS — projects

```sql
alter table projects enable row level security;

drop policy if exists "members can view their projects" on projects;
create policy "members can view their projects"
on projects for select
using (public.is_project_member(id));

drop policy if exists "authenticated users can create projects" on projects;
create policy "authenticated users can create projects"
on projects for insert
with check (owner_id = auth.uid());

drop policy if exists "owner can update their project" on projects;
create policy "owner can update their project"
on projects for update
using (owner_id = auth.uid());

drop policy if exists "owner can delete their project" on projects;
create policy "owner can delete their project"
on projects for delete
using (owner_id = auth.uid());
```

## RLS — project_members

```sql
alter table project_members enable row level security;

drop policy if exists "members can view fellow project members" on project_members;
create policy "members can view fellow project members"
on project_members for select
using (public.is_project_member(project_id));

drop policy if exists "project owner can add members" on project_members;
create policy "project owner can add members"
on project_members for insert
with check (
  exists (
    select 1 from projects
    where projects.id = project_members.project_id
    and projects.owner_id = auth.uid()
  )
);
```

## RLS — folders

```sql
alter table folders enable row level security;

drop policy if exists "project members can view folders" on folders;
create policy "project members can view folders"
on folders for select
using (public.is_project_member(project_id));

drop policy if exists "editors and owners can create folders" on folders;
create policy "editors and owners can create folders"
on folders for insert
with check (public.project_role(project_id) in ('owner', 'editor'));

drop policy if exists "editors and owners can rename folders" on folders;
create policy "editors and owners can rename folders"
on folders for update
using (public.project_role(project_id) in ('owner', 'editor'));

drop policy if exists "editors and owners can delete folders" on folders;
create policy "editors and owners can delete folders"
on folders for delete
using (public.project_role(project_id) in ('owner', 'editor'));
```

## RLS — files

```sql
alter table files enable row level security;

drop policy if exists "project members can view files" on files;
create policy "project members can view files"
on files for select
using (public.is_project_member(project_id));

drop policy if exists "editors and owners can upload files" on files;
create policy "editors and owners can upload files"
on files for insert
with check (
  uploaded_by = auth.uid()
  and public.project_role(project_id) in ('owner', 'editor')
);

drop policy if exists "editors and owners can update files" on files;
create policy "editors and owners can update files"
on files for update
using (public.project_role(project_id) in ('owner', 'editor'));

drop policy if exists "editors and owners can delete files" on files;
create policy "editors and owners can delete files"
on files for delete
using (public.project_role(project_id) in ('owner', 'editor'));
```

## ⚠️ bom_items — pending

RLS **not yet enabled**. Table is currently reachable via broad authenticated GRANTs with zero row-level filtering. No UI touches it yet, but this is the first thing to fix when the BOM feature starts — same `is_project_member` / `project_role` pattern as `files` and `folders`.

## Grants

```sql
grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on all tables in schema public
to anon, authenticated, service_role;

alter default privileges in schema public
grant select, insert, update, delete on tables to anon, authenticated, service_role;
```

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)