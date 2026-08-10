import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

// Money-page edit rights (BOM / transactions / member contributions) are the
// mirror of the database's `can_edit_money` RLS helper: a member can edit the
// Money page if they are the project owner OR they carry the orthogonal
// `is_auditor` flag. A plain editor (no flag) can edit Files/Overview but NOT
// the Money page. RLS enforces this at the DB level too; this app-level check
// just lets endpoints return a clean 403 before attempting a write.
export async function canEditMoney(
	supabase: SupabaseClient<Database>,
	projectId: string,
	userId: string,
): Promise<boolean> {
	const { data: membership } = await supabase
		.from('project_members')
		.select('role, is_auditor')
		.eq('project_id', projectId)
		.eq('user_id', userId)
		.single();

	return !!membership && (membership.role === 'owner' || membership.is_auditor === true);
}
