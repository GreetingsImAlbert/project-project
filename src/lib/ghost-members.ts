import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';
import { ghostIdOf } from './money-parties';

export const GHOST_COLUMNS = 'id, display_name, note, contribution_percent, is_deleted_account';

// Exactly the columns GHOST_COLUMNS selects, so the two can't drift apart.
export type GhostMemberRow = Pick<
	Database['public']['Tables']['ghost_members']['Row'],
	'id' | 'display_name' | 'note' | 'contribution_percent' | 'is_deleted_account'
>;

export const MAX_GHOST_NAME = 80;
export const MAX_GHOST_NOTE = 200;

// A project can't grow ghosts without bound — they're stand-ins for a handful of
// outside contributors, not a directory.
export const MAX_GHOSTS_PER_PROJECT = 20;

export async function listGhostMembers(
	supabase: SupabaseClient<Database>,
	projectId: string,
): Promise<GhostMemberRow[]> {
	const { data } = await supabase
		.from('ghost_members')
		.select(GHOST_COLUMNS)
		.eq('project_id', projectId)
		.order('created_at', { ascending: true });

	return data ?? [];
}

/**
 * Confirms a party id names somebody who actually belongs to this project and says
 * which column pair it writes to. Both transaction endpoints ran this check against
 * `project_members` inline; a party can now be a ghost, so the lookup has to pick its
 * table from the id. Returns null when the party isn't in the project — the caller
 * turns that into the same 400 it always did.
 */
export async function resolveParty(
	supabase: SupabaseClient<Database>,
	projectId: string,
	partyId: string,
): Promise<{ displayName: string | null } | null> {
	const ghostId = ghostIdOf(partyId);

	if (ghostId) {
		const { data: ghost } = await supabase
			.from('ghost_members')
			.select('id, display_name')
			.eq('project_id', projectId)
			.eq('id', ghostId)
			.maybeSingle();

		return ghost ? { displayName: ghost.display_name } : null;
	}

	const { data } = await supabase
		.from('project_members')
		.select('user_id, profiles(display_name)')
		.eq('project_id', projectId)
		.eq('user_id', partyId)
		.maybeSingle()
		.overrideTypes<{ user_id: string; profiles: { display_name: string } | null }>();

	return data ? { displayName: data.profiles?.display_name ?? null } : null;
}

// Shared by the create and update endpoints — same field rules either side.
export function ghostNameError(displayName: string | undefined): string | null {
	if (!displayName) return 'Name is required';
	if (displayName.length > MAX_GHOST_NAME) return `Name: max ${MAX_GHOST_NAME} characters`;
	return null;
}

export function ghostNoteError(note: string | null): string | null {
	if (note && note.length > MAX_GHOST_NOTE) return `Note: max ${MAX_GHOST_NOTE} characters`;
	return null;
}
