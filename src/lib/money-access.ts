import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

// Money-page edit rights (BOM / transactions / member contributions) are the
// mirror of the `can_edit_money` RLS helper in SCHEMA.md: a member can edit the
// Money page if they are the project owner OR they carry the orthogonal
// `is_auditor` flag. A plain editor (no flag) can edit Files/Overview but NOT
// the Money page. RLS enforces this at the DB level too; this app-level check
// just lets endpoints return a clean 403 before attempting a write.
//
// `is_auditor` may not be in the generated Database types until
// `npm run update-types` runs against the live schema, so the row is cast rather
// than relying on the inferred column set (see the note in CLAUDE.md).
export async function canEditMoney(
	supabase: SupabaseClient<Database>,
	projectId: string,
	userId: string,
): Promise<boolean> {
	const { data } = await supabase
		.from('project_members')
		.select('role, is_auditor')
		.eq('project_id', projectId)
		.eq('user_id', userId)
		.single();

	const membership = data as unknown as { role: string; is_auditor: boolean } | null;
	return !!membership && (membership.role === 'owner' || membership.is_auditor === true);
}
