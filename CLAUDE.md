# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

P2 is a small collaborative engineering-project manager. The developer is a mechanical engineering student hoping to use this web app to aid in projects.

Refer to SCHEMA.md for the full Supabase schema

## Testing

```sh
npx astro check *        # Astro-aware type checks
npx tsc --noEmit *       # TypeScript type checks
npx sv check             # Svelte-aware type check 

# After success

npm run build
npm run update-types     # Only if there are changes to the Supabase schema
npx wrangler types       # Only after changing wrangler.jsonc bindings
```

Before concluding the response:

1. Run the aforementioned commands in order. If npm run build won't complete because of wrangler dev process, ask the user for permission to stop the process. If permitted, stop the wrangler dev process then npm run build.
2. Check the latest commit and give me the commit message for the latest changes. Never commit yourself.
3. Update SCHEMA.md for changes to the Supabase schema. Include the SQL queries to run in the response.
4. Update CHECKLIST.md. Remove finished tasks. Append new tasks you deem appropriate.

## Commits

Format:

"feat/fix/style/doc/etc.: brief one-line summary

- Add ...
- Remove ...
- [Any verb] ..."

Never use double-quotes or any characters that might prevent git commit from executing properly in the temrinal.