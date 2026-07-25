import type { Transaction } from './transactions-store.svelte';

// Shared by TransactionsTable, MemberContributionsTable and MoneySummary. These
// rules used to be copy-pasted per component, which meant the summary strip could
// disagree with the table directly under it if only one copy was updated.

export function signedAmount(t: Transaction): number {
	const total = t.total_cost ?? 0;
	return t.type === 'discount' || t.type === 'refund' ? -total : total;
}

// Payments are transfers between members settling dues, not project costs — they
// shouldn't inflate or deflate the project's actual net spend.
export function netSpend(transactions: Transaction[]): number {
	return transactions.filter((t) => t.type !== 'payment').reduce((sum, t) => sum + signedAmount(t), 0);
}

// A payment isn't the payer's own project spend — it's money handed directly to
// another member, so it counts toward the payer's "paid" (reduces what they owe)
// and *against* the payee's "paid" (reduces what they're owed back), rather than
// being attributed to just one member_id like every other transaction type.
export function paidByMember(transactions: Transaction[], memberId: string): number {
	return transactions.reduce((sum, t) => {
		if (t.type === 'payment') {
			if (t.member_id === memberId) return sum + (t.total_cost ?? 0);
			if (t.related_member_id === memberId) return sum - (t.total_cost ?? 0);
			return sum;
		}
		return t.member_id === memberId ? sum + signedAmount(t) : sum;
	}, 0);
}

// Same member_id/related_member_id split as paidByMember — from the payee's side a
// payment is negative (it's money they received, not money they spent).
export function entryAmount(t: Transaction, viewingMemberId: string): number {
	if (t.type === 'payment') {
		return t.member_id === viewingMemberId ? (t.total_cost ?? 0) : -(t.total_cost ?? 0);
	}
	return signedAmount(t);
}
