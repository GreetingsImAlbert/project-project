// The Money page's SSR query and every transactions endpoint hand the same row shape
// to transactions-store's `Transaction` — kept in one string so a newly added column
// can't reach some of those responses and quietly miss the others.
//
// The two profiles FKs (member_id and related_member_id) make a bare `profiles(...)`
// embed ambiguous to PostgREST, hence the explicit hint.
export const TRANSACTION_COLUMNS =
	'id, transaction_date, type, item_name, quantity, unit, unit_cost, supplier, item_url, total_cost, member_id, related_member_id, group_id, profiles!transactions_member_id_fkey(display_name)';
