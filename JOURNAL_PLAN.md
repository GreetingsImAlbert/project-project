# Journal overhaul implementation plan

## Goal

Replace the single project journal with a tabbed journal workspace containing:

- One shared group journal named `JOURNAL.md`.
- Personal journals whose default filename is `JOURNAL_<creator-name>.md`, with whitespace replaced by hyphens.
- One independent current-day draft and finalized-entry history per journal.
- Debounced draft autosave while typing and daily finalization at Manila midnight, matching the existing journal behavior.
- Personal-journal storage usage charged to its creator; group-journal storage usage charged to the current project owner.
- Journal-specific permissions enforced in the UI, API, database policies, file editor, and Trash.
- All journal files stored in a protected `journals` folder at the project file root.

## Confirmed product decisions

The repository has `profiles.display_name`, but no username field. This plan therefore uses a snapshot of `display_name` when creating the default personal filename. The filename remains stable if the display name later changes.

Access model:

| Journal/action | Personal journal creator | Project owner | Other project member | Public visitor |
| --- | ---: | ---: | ---: | ---: |
| View group journal | Yes | Yes | Yes | Finalized history only when Project Settings → Journal visibility is enabled |
| Edit group draft/history | Yes, if owner/editor | Yes | Yes, if editor | No |
| Delete group journal | No | No | No | No |
| View a Private personal journal | Yes | No content access | No | No |
| View a Project Members personal journal | Yes | Yes | Yes | No |
| View a Public personal journal | Yes | Yes | Yes | Finalized history only when Project Settings → Journal visibility is enabled |
| Edit a personal draft/history | Yes | No, unless also creator | No | No |
| Change personal visibility | Yes | No, unless also creator | No | No |
| Delete a personal journal | Yes | Yes | No | No |
| Create a personal journal | Yes, if owner/editor | Yes | Yes, if editor | No |

- `JOURNAL.md` is required and non-deletable by everyone.
- A member has zero or one active personal journal. It is optional and is created only when that member explicitly chooses “Create my journal”; adding a project member does not create one.
- Creating a journal while that member's prior journal is soft-deleted offers/restores the deleted journal instead of creating a second active journal.
- Personal-journal visibility defaults to `Private` and can only be changed by its creator:
  - `Private`: only the creator can read the current draft or finalized history. The project owner has no content access.
  - `Project Members`: all current project members can read it.
  - `Public`: all current project members can read it; outsiders can read finalized history only when the project's Journal visibility setting is also enabled.
- Project owners need minimal metadata/authority to delete a Private personal journal but must never receive its draft, finalized Markdown, preview, download, or rendered history. The management UI/API should expose no more than is required to identify and delete the file.
- Soft deletion remains the normal Files/Trash behavior. Deleting a personal journal removes its live draft immediately but retains the finalized Markdown file until Trash purge.

## Storage quota attribution

“Billing” means whose storage quota is consumed by a file's bytes. It is not a monetary charge: `files.uploaded_by` identifies the user whose storage allowance is reduced. A growing journal is blocked from finalizing if that user's quota is full.

The confirmed rules are:

- `JOURNAL.md` is charged to the current project owner. If ownership transfers, its existing and future storage attribution transfers to the new owner. This preserves the repository's current behavior.
- Each personal journal is charged to its creator and is never re-attributed during project ownership transfer.
- A quota-full personal-journal creator blocks only that personal journal's growth; it must not block other journals from finalizing.

## Current implementation constraints

- `files.is_journal` plus the partial `journal_file_unique_per_project` index permits exactly one journal file per project.
- `journal_drafts` is keyed only by `project_id`, so only one current-day draft exists per project.
- `ensureJournalFile`, `ensureJournalDraft`, the Journal page, the draft API, realtime subscription, and the cron finalizer all assume one journal.
- The current file is shown as `Journal.md`, not the required uppercase `JOURNAL.md`, and lives at the file root (`folder_id IS NULL`).
- Generic file APIs permit any project owner/editor to edit, move, copy, rename, or soft-delete normal files. Journal UI guards exist, but the new ownership rules require server-side authorization on every path.
- Root folder rename/delete can indirectly affect every child file, so the new `journals` folder must be a protected system folder.
- Public Journal loading, ownership transfer, account deletion, quota calculation, project export/import, and generated Supabase types all encode single-journal assumptions.

## Target data model and migration

Create a Supabase migration with `npx supabase migration new journal_overhaul`. Treat `supabase/migrations` as schema source of truth.

### 1. Mark the protected journals folder

- Add `folders.is_journals_folder boolean NOT NULL DEFAULT false`.
- Add a check requiring a journals folder to have `parent_folder_id IS NULL`.
- Add a partial unique index allowing one protected journals folder per project.
- Create a protected root-level folder named `journals` for each project that already has a journal file, then move that journal file into it.
- Lazily create the folder for projects that have never opened Journal.
- Do not rely on the folder name for identity; users may already have a normal folder named `journals`.

### 2. Distinguish group and personal journal files

- Retain `files.is_journal` for compatibility with existing file/public filters.
- Add a nullable `files.journal_kind` constrained to `group` or `personal`.
- Add nullable `files.journal_visibility`, constrained to `private`, `members`, or `public` for personal journals and null for the group journal.
- Add consistency constraints: non-journal files have no journal metadata; group journals have no per-file visibility; personal journals have a valid visibility.
- Backfill the existing journal row as `group`, set its visible filename to `JOURNAL.md`, and retain its R2 key because the object key is internal.
- Replace `journal_file_unique_per_project` with:
  - one active group journal per project;
  - one active personal journal per `(project_id, uploaded_by)` for the first release.
- Continue using `files.uploaded_by` as the active file owner and quota attribution identity. Personal journal creation must set it to the creator and never change it during project ownership transfer.
- Keep journal files private at the generic Files layer (`is_public = false`). Journal publication is resolved by `journal_visibility` plus `projects.public_journal_enabled`, preventing generic public-file endpoints from bypassing Journal rules.

### 3. Make drafts journal-specific

- Add `journal_drafts.journal_file_id uuid` referencing `files(id)`.
- Backfill each existing draft with its project's group journal file.
- Change the primary key/conflict target from `project_id` to `journal_file_id` while retaining/indexing `project_id` for membership checks, cron scans, incident context, and efficient page loading.
- Enforce that the draft and file belong to the same project, preferably with a composite foreign key or a validation trigger rather than application convention alone.
- Cascade draft deletion when a journal file row is permanently removed. Explicitly delete the draft when a journal is soft-deleted.
- Keep the 50,000-character constraint per journal per day and keep the table in `supabase_realtime`.

### 4. Replace RLS policies

- Group draft `SELECT`: any current project member.
- Personal draft `SELECT`: creator always; other current members only for `members`/`public`; never public visitors.
- Group draft `INSERT`/`UPDATE`: project owner/editor.
- Personal draft `INSERT`/`UPDATE`: the journal's `uploaded_by` user, provided they remain a project member.
- File metadata update/content authorization:
  - group journal: project owner/editor;
  - personal journal: creator only;
  - normal file: existing owner/editor behavior.
- Personal journal soft-delete/purge: creator or current project owner.
- Group journal delete: nobody through user-scoped operations.
- Personal visibility update: creator only, with the three allowed values.
- Private personal journal content must remain unreadable to the project owner even though a narrow delete operation is available to them.
- Use small SQL authorization helpers where they make the policies and API checks consistent. Do not depend on client-side action visibility.

### 5. Migration safety

- Make folder creation, journal backfill, and indexes idempotent within the migration.
- Audit for orphan `journal_drafts`, duplicate `is_journal` rows, missing R2 keys, and deleted legacy journals before adding non-null/unique constraints.
- Preserve existing finalized Markdown bytes and current draft text.
- Preserve `transfer_project_ownership` behavior that re-attributes only the group journal to the new project owner; personal journal ownership remains unchanged.
- Do not edit `src/lib/supabase/database.types.ts` manually. After applying the migration, have the user run `npm run update-types` as required by repository instructions.

## Implementation steps

### [DONE] Step 1: Add shared journal domain helpers

Refactor `src/lib/journal.ts` into journal-file-aware operations:

- `ensureJournalsFolder(projectId)`
- `ensureGroupJournal(projectId, projectOwnerId)`
- `createPersonalJournal(projectId, creatorId, creatorDisplayName)`
- `ensureJournalDraft(projectId, journalFileId)`
- `loadProjectJournals(projectId, viewerId)`
- `canReadJournal`, `canEditJournal`, and `canDeleteJournal`

Return only journal metadata/content visible to the caller, plus calculated capabilities: file ID, kind, filename, creator ID/name, visibility, draft, history, and read/edit/delete/change-visibility flags. Keep R2 creation compensating behavior: if the database insert fails, remove the just-created empty object.

Add a deterministic filename helper:

- Trim the display name.
- Replace one or more whitespace characters with `-`.
- Remove path separators/control characters and enforce the existing maximum filename length.
- Fall back to a stable safe label if the display name produces an empty filename.
- Use `JOURNAL_<slug>.md`; do not automatically rename it after profile changes.

### [DONE] Step 2: Add journal collection/create/delete APIs

- Add a journal collection endpoint under `/api/projects/[id]/journals` for idempotent personal journal creation.
- If the caller has a soft-deleted personal journal, return a restore-required result and restore it after explicit confirmation instead of inserting a duplicate.
- Change draft saving to address a journal file ID, for example `/api/projects/[id]/journals/[journalFileId]/draft`.
- Validate project membership and journal ownership before reading or writing.
- Add a creator-only endpoint for personal visibility changes.
- Return `403` for a real but unauthorized journal and `404` where revealing cross-project existence would leak data.
- Keep the 500 ms browser debounce and upsert on `journal_file_id`.
- Add a dedicated personal journal delete operation, or route journal deletion through the existing file delete endpoint with centralized capability checks. Delete the live draft and soft-delete the file atomically where possible.
- Ensure retries are idempotent and cannot create duplicate personal/group journals.

### [DONE] Step 3: Make realtime journal-specific

- Keep the realtime token endpoint membership-scoped, but allow every member who may view Journal to subscribe.
- Subscribe by `journal_file_id` for the active tab, or subscribe once by `project_id` and route updates into state keyed by journal ID.
- Include the journal ID in payload handling so an update can never overwrite the wrong tab.
- Flush or await a pending debounced save before switching tabs; guard against a late response from the previous tab changing the active tab's state.
- On teardown, save pending content when feasible, clear timers, and remove channels.
- Preserve the existing last-writer-wins behavior within one shared group draft and document that simultaneous editing has no merge engine.

### [DONE] Step 4: Rebuild the Journal page and tabs

Update `src/pages/projects/[id]/journal.astro` to load the journal list, draft rows, creator profiles, and finalized contents. Default to the group journal; optionally support `?journal=<file-id>` so refresh/deep links retain the active tab.

Update `src/components/JournalPage.svelte`:

- Render an accessible tablist above the existing editor/history layout.
- Put `Group`/`JOURNAL.md` first, followed by personal journals in deterministic creator/name order.
- Keep a draft, history, save status, and last-saved value per journal ID.
- For an editable tab, show the existing large textarea and save status.
- For a readable but non-editable personal tab, show the current-day content read-only plus finalized history and an ownership explanation.
- Do not render a tab or leak content for a Private personal journal to other members. If the project owner needs to exercise delete authority, use a separate minimal management row/action rather than the journal reader.
- Show “Create my journal” only when the caller is eligible and has no active personal journal.
- Show a creator-only visibility control with Private, Project Members, and Public options. Explain that Public is effective externally only while Project Settings → Journal visibility is enabled.
- Show Delete only to the personal journal creator and project owner, with clear confirmation; never show it for the group journal.
- Preserve keyboard tab navigation, focus behavior, responsive overflow/scrolling, empty states, and screen-reader labels.
- After the midnight realtime reset, refresh or locally add the finalized entry so the history updates without requiring a full page reload.

`JournalHistory.svelte` can remain the shared history renderer, with only minor prop/empty-state changes if needed.

### [DONE] Step 5: Update public and member visibility behavior

- Public and authenticated non-member requests may load finalized group history plus finalized personal journals marked `public`, but only when `public_journal_enabled` is true.
- Never expose any current-day draft publicly, including a `public` personal journal's draft.
- Member requests list the group journal, the caller's own personal journal, and other personal journals marked `members`/`public`; omit other members' Private journals.
- Public responses include only the minimum display metadata and finalized history needed for public tabs; never expose creator IDs, draft rows, quota ownership, or private/member-only journal IDs and content.
- Do not lazily create files or drafts in the public branch.
- Change every single-row `is_journal = true` lookup to an explicit `journal_kind = group` lookup.

### [DONE] Step 6: Harden Files and Trash integration

Journal files must physically appear inside the protected `journals` folder, but Files actions must respect journal rules.

- Include `journal_kind`, `journal_visibility`, `uploaded_by`, and calculated capabilities only where the caller may see that metadata.
- `content.ts` GET must report `canEdit` using journal ownership rules; PUT must repeat the authorization before touching R2.
- Reject rename, move, copy, and visibility changes for all journal files in server routes.
- Allow soft-delete only for personal journals and only to creator/project owner.
- Update FileList actions so creators/project owners see only valid journal actions; do not treat the global Files `canEdit` flag as sufficient.
- Protect the system `journals` folder from rename, move, delete, purge, and restore conflicts in both UI and APIs/RPCs.
- Audit folder-tree deletion so it cannot indirectly delete journal files.
- Update Trash restore/purge authorization for personal journals. Restoring must reattach the file to the protected folder and recreate a blank current-day draft; reject an active-journal uniqueness conflict with a useful message.
- Keep journals excluded from per-file public sharing.
- Ensure generic file preview/download endpoints apply journal visibility rules; `files.is_public` must never make a journal public.

### [DONE] Step 7: Finalize every journal at end of day

Refactor `finalizeStaleDrafts` and `finalizeOneDraft` to process rows by `journal_file_id`, not by project:

- Read every stale active journal draft (`draft_date < appToday()`).
- Load the exact non-deleted journal file and its `uploaded_by` quota owner.
- Skip empty content but advance only that journal's draft.
- Read the exact R2 object, replace/append that date idempotently, write it, update that file's `size_bytes`, then reset only that draft.
- Calculate quota growth from the complete encoded before/after Markdown size, including headings and separators, rather than only the raw draft body.
- Charge personal growth to the personal journal creator and group growth to the current group attribution owner.
- Leave only the failing journal queued when quota/R2/database work fails; continue processing other journals in the same project and other projects.
- Add `journalFileId` and `journalKind` to retry logs/error-report context so incidents are actionable.
- Preserve safe retries when R2 succeeds but a later database operation fails.

No new cron trigger is needed; `src/worker.ts` continues calling the refactored finalizer once daily.

### [DONE] Step 8: Handle ownership changes and account deletion

- Keep group-journal attribution on the current project owner during ownership transfer; personal journals always remain charged to their creators.
- When a personal journal creator's account is hard-deleted, soft-delete/freeze that journal, remove its live draft, and let the existing orphan-file grace/purge policy handle the Markdown object.
- Exclude the required group journal from accidental orphan purge and ensure ownership-transfer attribution is complete before the former owner can be hard-deleted.
- If a member is merely removed from a project, retain the finalized file under its existing visibility, remove/freeze its live draft, and let the project owner delete it without gaining content access. Define separately whether a former member should keep access; the safe default is no, because they are no longer a project member.
- Ensure quota aggregates continue counting each active file under its actual `uploaded_by` value.

### [DONE] Step 9: Version project export/import

The export manifest currently stores one `journalDraft`. Introduce a new manifest version that:

- Exports `journal_kind`, `journal_visibility`, folder marker metadata, and a `journalDrafts` array keyed by journal file ID.
- Includes every journal Markdown object through the existing file archive mechanism.
- Imports the protected folder and group journal exactly once.
- Maps legacy V1/V2 single journal + draft data to the new group journal model.
- Reassigns imported file ownership/quota according to the existing import identity policy. If multiple imported personal journals collapse onto the importer, preserve their files but select one active personal draft and treat the others as finalized/history-only until renamed/custom journals are supported.
- Rejects malformed cross-project journal/draft relationships, duplicate group journals, unsafe filenames, and journal files outside the protected folder.
- Updates record counts, validation limits, remapping, import RPC SQL, fixtures, and compatibility tests.

### Step 10: Update types, tests, and documentation

Add or update tests for:

- Personal filename slugging, fallback, length, Unicode, and unsafe characters.
- Legacy journal/draft migration and uppercase filename preservation.
- One group journal and one active personal journal per member.
- Visibility/access matrix, including Private content hidden from the project owner, members-only reads, two-gate public reads, creator-only visibility changes, and project-owner delete-without-read.
- Generic content/delete/rename/move/copy/visibility APIs cannot bypass journal rules.
- Protected folder cannot be renamed/deleted and folder-tree deletion cannot remove journals.
- Tab switching flushes pending saves and late save/realtime events do not cross journals.
- Multiple stale drafts in one project finalize independently and idempotently.
- Correct per-creator quota attribution and failure isolation.
- Empty draft rollover, missing/deleted file behavior, and midnight history refresh.
- Public Journal exposes finalized group history and finalized `public` personal journals only when the project Journal gate is enabled.
- Account deletion, ownership transfer, Trash restore/purge, and orphan cleanup.
- New export/import round trip plus legacy V1/V2 import compatibility.

Update comments and user-facing copy that currently say “the Journal file” or imply one project-level draft. Update `README.md` if its Journal description remains user-facing.

## Suggested implementation order

1. Add migration, constraints, policies, and compatibility backfill.
2. Regenerate Supabase types after user approval/instruction.
3. Refactor journal domain helpers and permission checks.
4. Update finalizer/realtime/draft endpoints.
5. Build SSR loading and tabbed Journal UI.
6. Harden Files, protected-folder, and Trash paths.
7. Update ownership/account-deletion behavior.
8. Version export/import and retain legacy compatibility.
9. Add tests, run checks, and perform manual multi-user verification.

This order keeps the old group journal usable through the schema transition, then moves writers to journal IDs before exposing personal-journal creation.

## Verification checklist

Automated checks, as applicable:

```text
npx astro check
npx tsc --noEmit
npx sv check
npm test
npm run build:staging
```

Manual staging scenarios:

1. Existing project opens with its original Markdown/history and draft under the Group tab.
2. Two different members create personal journals; filenames, folder placement, tabs, and storage attribution are correct.
3. Each creator can type/save/edit their file; the project owner can delete another member's journal but cannot edit it.
4. Private journals are absent for other members and unreadable by the project owner; Members/Public journals are readable without edit controls.
5. Group collaborators receive realtime draft updates; personal journal updates never overwrite another tab.
6. A pending save survives tab switching/navigation.
7. Manila-midnight finalization produces one dated entry per non-empty journal, clears each draft independently, and updates history.
8. One quota-full creator does not block other journals from finalizing.
9. Files and Trash cannot bypass ownership rules or move journals outside `/journals`.
10. With the project Journal gate off, no journal is public. With it on, public visitors see finalized Group and `public` personal histories, but no drafts or Private/Members journals.
11. Project ownership transfer and creator account deletion preserve the required group journal and apply the chosen personal-journal lifecycle.
12. New exports round-trip all journals; legacy exports import their single journal as Group.

## Completion criteria

- Existing journal content and current drafts migrate without loss.
- Every project has at most one active group journal, located in its protected root `journals` folder and displayed as `JOURNAL.md`.
- Eligible members can create a creator-owned personal journal with the required default filename.
- Tabs switch isolated drafts and histories without losing pending input.
- Daily finalization processes every journal independently and charges growth to the correct quota owner.
- Personal journal edit/delete rules and project-owner delete-only authority are enforced server-side across Journal, Files, folders, and Trash.
- Public users can discover only personal journals marked `public`, and only while the project Journal gate is enabled; Private and Members journals never leak.
- Ownership transfer, account deletion, export/import, and retry/error reporting no longer assume one journal per project.
- Type checks, tests, staging build, and manual multi-user scenarios pass.
