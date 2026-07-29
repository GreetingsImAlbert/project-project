import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

// `folders.parent_folder_id` cascades at the DB level, but that only fires on an
// actual DELETE — soft-delete (folders/[folderId]/delete.ts) and permanent delete
// (folders/[folderId]/purge.ts) both need the whole subtree walked explicitly so
// every folder (and, by extension, every file under it) gets touched in one pass.
export async function collectDescendantFolderIds(
	supabase: SupabaseClient<Database>,
	rootId: string,
): Promise<string[]> {
	const allIds = [rootId];
	let frontier = [rootId];

	while (frontier.length > 0) {
		const { data: children } = await supabase.from('folders').select('id').in('parent_folder_id', frontier);

		const childIds = (children ?? []).map((c) => c.id);
		if (childIds.length === 0) break;

		allIds.push(...childIds);
		frontier = childIds;
	}

	return allIds;
}
