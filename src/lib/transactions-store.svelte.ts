export type TransactionType = 'item' | 'shipping' | 'discount' | 'refund' | 'payment';

export interface Transaction {
	id: string;
	transaction_date: string;
	type: TransactionType;
	item_name: string | null;
	quantity: number | null;
	unit: string | null;
	unit_cost: number | null;
	supplier: string | null;
	total_cost: number | null;
	member_id: string;
	related_member_id: string | null;
	profiles: { display_name: string } | null;
}

// Shared across TransactionsTable and MemberContributionsTable — both are independently
// hydrated `client:load` islands on the Money page, so without a shared store each kept
// its own private copy of `transactions` and edits made in one (add/edit/delete) never
// reached the other's derived totals (net total, dues, contribution amounts).
export const transactionsState = $state<{ items: Transaction[] }>({ items: [] });

let initialized = false;

// The once-only guard is a client-side concern (keep the first island's data, don't
// let a later island's props clobber it). On the server the module lives for the
// whole Worker isolate, not one request, so honouring the guard there would render
// the *previous* request's transactions into this request's HTML — always reassign.
export function initTransactions(initial: Transaction[]) {
	if (initialized && !import.meta.env.SSR) return;
	transactionsState.items = initial;
	initialized = true;
}

export function addTransaction(t: Transaction) {
	transactionsState.items = [...transactionsState.items, t];
}

export function updateTransaction(t: Transaction) {
	transactionsState.items = transactionsState.items.map((x) => (x.id === t.id ? t : x));
}

export function removeTransaction(id: string) {
	transactionsState.items = transactionsState.items.filter((x) => x.id !== id);
}
