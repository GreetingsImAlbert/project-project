// The Money page's SSR query and every transactions endpoint hand the same row shape
// to transactions-store's `Transaction` — kept in one string so a newly added column
// can't reach some of those responses and quietly miss the others.
//
// Both embeds need an explicit FK hint: each table is reached by two columns
// (member_id / related_member_id, ghost_member_id / related_ghost_member_id), which
// makes a bare `profiles(...)` or `ghost_members(...)` ambiguous to PostgREST. Only
// the payer's name is embedded — it's the one the tables render for a row whose party
// has since left the project's list.
export const TRANSACTION_COLUMNS =
	'id, transaction_date, type, item_name, quantity, unit, unit_cost, supplier, item_url, total_cost, member_id, related_member_id, ghost_member_id, related_ghost_member_id, group_id, profiles!transactions_member_id_fkey(display_name), ghost_members!transactions_ghost_member_id_fkey(display_name)';
