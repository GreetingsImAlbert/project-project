import type { Transaction } from './transactions-store.svelte';

// Shared by TransactionsTable, MemberContributionsTable and MoneySummary. These
// rules used to be copy-pasted per component, which meant the summary strip could
// disagree with the table directly under it if only one copy was updated.

export function signedAmount(t: Transaction): number {
	const total = t.total_cost ?? 0;
	return t.type === 'discount' || t.type === 'refund' ? -total : total;
}

// The lines of a bulk transaction are its parent's itemised breakdown, not money in
// their own right — the parent row carries the whole amount. Counting both would
// double the purchase, so every aggregate below runs on parents/standalones only.
// (Pre-bulk rows all have group_id null, so this changes nothing for them.)
export function isLine(t: Transaction): boolean {
	return t.group_id != null;
}

export function topLevel(transactions: Transaction[]): Transaction[] {
	return transactions.filter((t) => !isLine(t));
}

// A member with no explicit contribution_percent means one of two things: nobody has
// set a split yet (so everyone shares equally), or a split does exist and this member
// joined after it was saved. Defaulting to an equal share in that second case pushes
// the page's total past 100% — every member's "owes total" then overstates their real
// share — so an unset percent only counts as an equal share when *no* member has one.
export function resolveContributionPercents(
	members: { id: string; contributionPercent: number | null }[],
): Record<string, number> {
	const anyExplicit = members.some((member) => member.contributionPercent != null);

	return Object.fromEntries(
		members.map((member) => [
			member.id,
			member.contributionPercent ?? (anyExplicit ? 0 : 100 / members.length),
		]),
	);
}

// Payments are transfers between members settling dues, not project costs — they
// shouldn't inflate or deflate the project's actual net spend.
export function netSpend(transactions: Transaction[]): number {
	return topLevel(transactions)
		.filter((t) => t.type !== 'payment')
		.reduce((sum, t) => sum + signedAmount(t), 0);
}

// A payment isn't the payer's own project spend — it's money handed directly to
// another member, so it counts toward the payer's "paid" (reduces what they owe)
// and *against* the payee's "paid" (reduces what they're owed back), rather than
// being attributed to just one member_id like every other transaction type.
export function paidByMember(transactions: Transaction[], memberId: string): number {
	return topLevel(transactions).reduce((sum, t) => {
		if (t.type === 'payment') {
			if (t.member_id === memberId) return sum + (t.total_cost ?? 0);
			if (t.related_member_id === memberId) return sum - (t.total_cost ?? 0);
			return sum;
		}
		return t.member_id === memberId ? sum + signedAmount(t) : sum;
	}, 0);
}

// What a member still owes the group: their share of the net spend, less what they
// have already paid. Negative means the group owes them. Shared by the summary strip,
// the contributions table and the payment form's "all dues" shortcut, so all three
// can't drift apart.
export function duesFor(
	transactions: Transaction[],
	percents: Record<string, number>,
	memberId: string,
): number {
	const share = (netSpend(transactions) * (percents[memberId] ?? 0)) / 100;
	return share - paidByMember(transactions, memberId);
}

// Same member_id/related_member_id split as paidByMember — from the payee's side a
// payment is negative (it's money they received, not money they spent).
export function entryAmount(t: Transaction, viewingMemberId: string): number {
	if (t.type === 'payment') {
		return t.member_id === viewingMemberId ? (t.total_cost ?? 0) : -(t.total_cost ?? 0);
	}
	return signedAmount(t);
}
