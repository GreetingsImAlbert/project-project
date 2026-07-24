export type TransactionType = 'item' | 'shipping' | 'discount' | 'refund';

export interface Transaction {
	id: string;
	transaction_date: string;
	type: TransactionType;
	item_name: string | null;
	quantity: number | null;
	unit: string | null;
	unit_cost: number | null;
	total_cost: number | null;
	member_id: string;
	profiles: { display_name: string } | null;
}

// Shared across TransactionsTable and MemberContributionsTable — both are independently
// hydrated `client:load` islands on the Money page, so without a shared store each kept
// its own private copy of `transactions` and edits made in one (add/edit/delete) never
// reached the other's derived totals (net total, dues, contribution amounts).
export const transactionsState = $state<{ items: Transaction[] }>({ items: [] });

let initialized = false;

export function initTransactions(initial: Transaction[]) {
	if (initialized) return;
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
