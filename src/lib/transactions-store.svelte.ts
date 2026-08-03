import { currentEpoch } from './nav-epoch';

// 'bulk' is the parent row of a multi-item purchase — it carries the money and the
// label, its lines carry the breakdown. Lines themselves are never 'bulk'.
export type TransactionType = 'item' | 'shipping' | 'discount' | 'refund' | 'payment' | 'bulk';

export interface Transaction {
	id: string;
	transaction_date: string;
	type: TransactionType;
	item_name: string | null;
	quantity: number | null;
	unit: string | null;
	unit_cost: number | null;
	supplier: string | null;
	item_url: string | null;
	total_cost: number | null;
	// Exactly one of member_id / ghost_member_id is set, and at most one of the two
	// related_* columns — a transaction's two sides are each either a real member or a
	// ghost member. Read them through money-parties.ts rather than directly.
	member_id: string | null;
	related_member_id: string | null;
	ghost_member_id: string | null;
	related_ghost_member_id: string | null;
	// null on a standalone transaction and on a bulk parent; the parent's id on a line.
	group_id: string | null;
	profiles: { display_name: string } | null;
	ghost_members: { display_name: string } | null;
}

// Shared across TransactionsTable and MemberContributionsTable — both are independently
// hydrated `client:load` islands on the Money page, so without a shared store each kept
// its own private copy of `transactions` and edits made in one (add/edit/delete) never
// reached the other's derived totals (net total, dues, contribution amounts).
export const transactionsState = $state<{ items: Transaction[] }>({ items: [] });

let initializedEpoch = -1;

// The once-only guard is a client-side concern (keep the first island's data, don't
// let a later island's props clobber it). On the server the module lives for the
// whole Worker isolate, not one request, so honouring the guard there would render
// the *previous* request's transactions into this request's HTML — always reassign.
//
// On the client it's scoped to one navigation rather than to the module's lifetime:
// under <ClientRouter /> the module outlives the page, so a bare boolean would carry
// project A's transactions into project B's Money page. See nav-epoch.ts.
export function initTransactions(initial: Transaction[]) {
	if (initializedEpoch === currentEpoch() && !import.meta.env.SSR) return;
	transactionsState.items = initial;
	initializedEpoch = currentEpoch();
}

export function addTransaction(t: Transaction) {
	transactionsState.items = [...transactionsState.items, t];
}

export function updateTransaction(t: Transaction) {
	transactionsState.items = transactionsState.items.map((x) => (x.id === t.id ? t : x));
}

// Mirrors the `on delete cascade` on transactions.group_id — deleting a bulk parent
// drops its lines in the database, so they have to go from the store too.
export function removeTransaction(id: string) {
	transactionsState.items = transactionsState.items.filter((x) => x.id !== id && x.group_id !== id);
}

// A bulk transaction arrives as one parent row plus its lines.
export function addTransactionGroup(rows: Transaction[]) {
	transactionsState.items = [...transactionsState.items, ...rows];
}

// Editing a bulk transaction rewrites its lines wholesale (the endpoint deletes and
// reinserts them), so swap the whole group rather than patching row by row.
export function replaceTransactionGroup(parentId: string, rows: Transaction[]) {
	const rest = transactionsState.items.filter((x) => x.id !== parentId && x.group_id !== parentId);
	transactionsState.items = [...rest, ...rows];
}
