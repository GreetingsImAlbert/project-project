# Forum Page Plan

## Summary

- Keep `/` and the sidebar label as `Dashboard`.
- Replace the current Dashboard content with a global Forum feed for signed-in users.
- Support text posts, infinitely nestable replies, likes on posts/replies, and author-only soft deletion with placeholders.
- Use newest-first pagination with a stable cursor and 20 posts per page.
- Preserve storage/reminder components for future Dashboard sections.

## Implementation

### Database and security

- Add `forum_posts`, `forum_replies`, `forum_post_likes`, and `forum_reply_likes` tables.
- Add nullable self-referential `forum_replies.parent_reply_id` so replies can target any active reply in the same post.
- Store trimmed non-empty bodies up to 5,000 characters.
- Use nullable profile foreign keys with `on delete set null`, timestamps, and `deleted_at` soft-delete fields.
- Use composite primary keys for likes so each signed-in user can like an item once.
- Add indexes for newest-post pagination and reply/like lookups.
- Add authenticated RLS policies and explicit grants. Authors may create and soft-delete only their own content; users may create/delete only their own likes.
- Enrich author names and avatars server-side using only safe profile fields; do not broaden access to private profile columns.

### Server interfaces

- Add shared Forum query/DTO logic with a page size of 20 and a stable `(created_at, id)` cursor.
- Add authenticated endpoints:
  - `GET /api/forum/feed?before=<cursor>` → `{ posts, nextCursor }`
  - `POST /api/forum/posts` with `{ body }`
  - `POST /api/forum/posts/:postId/replies` with `{ body, parentReplyId? }`
  - `POST /api/forum/posts/:postId/delete`
  - `POST /api/forum/replies/:replyId/delete`
  - `POST /api/forum/posts/:postId/like`
  - `POST /api/forum/replies/:replyId/like`
- Serialize posts/replies with `id`, `parentReplyId`, `body`, `createdAt`, author display data, `deleted`, `likeCount`, `likedByMe`, and nested `children`.
- Reject unauthenticated requests, empty/overlong bodies, spoofed authors, unauthorized deletes, likes on deleted content, and replies to deleted posts.
- Use API routes plus the user-scoped Supabase client for mutations; never accept author identity from the browser.

### Dashboard UI

- Replace the current root-page storage/reminder query and rendering with a `ForumPage.svelte` island.
- Keep the page title and navigation as `Dashboard`; use Forum as the primary section heading.
- Add a composer, newest-first post cards, recursive reply forms, like toggles/counts, author-only delete controls, empty/loading/error states, and a Load more control.
- Keep replies under a soft-deleted post and show deleted-content placeholders. Disable new replies and likes for deleted content.
- Do not add editing, media uploads, project scoping, moderation tools, or a separate `/forum` route in v1.

### Documentation and generated types

- Document all table DDL, indexes, RLS policies, grants, and deletion behavior in `SCHEMA.md`.
- Regenerate `src/lib/supabase/database.types.ts` after applying the schema.
- Remove the completed Forum item from `CHECKLIST.md` and add a follow-up for future Dashboard sections.

## Verification

Run, in order:

```sh
npx astro check *
npx tsc --noEmit *
npx sv check
npm run build
npm run update-types
```

Verify authorization, visibility between users without shared projects, cursor pagination, body validation, ownership checks, nested reply creation across multiple levels, same-post parent validation, like idempotency, deleted placeholders, account deletion behavior, mobile layout, and light/dark themes.
