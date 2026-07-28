import type { Transaction } from './transactions-store.svelte';
import { partyIdOf, relatedPartyIdOf } from './money-parties';

// Shared by TransactionsTable, MemberContributionsTable and MoneySummary. These
// rules used to be copy-pasted per component, which meant the summary strip could
// disagree with the table directly under it if only one copy was updated.
//
// Everything below keys on a *party* id rather than a user id: a transaction can be
// attributed to a ghost member as well as a real one, and the two are told apart by
// money-parties.ts, not here.

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

// A party with no explicit contribution_percent means one of two things: nobody has
// set a split yet (so everyone shares equally), or a split does exist and this party
// was added after it was saved. Defaulting to an equal share in that second case pushes
// the page's total past 100% — every party's "owes total" then overstates their real
// share — so an unset percent only counts as an equal share when *nobody* has one.
export function resolveContributionPercents(
	parties: { id: string; contributionPercent: number | null }[],
): Record<string, number> {
	const anyExplicit = parties.some((party) => party.contributionPercent != null);

	return Object.fromEntries(
		parties.map((party) => [
			party.id,
			party.contributionPercent ?? (anyExplicit ? 0 : 100 / parties.length),
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
// another party, so it counts toward the payer's "paid" (reduces what they owe)
// and *against* the payee's "paid" (reduces what they're owed back), rather than
// being attributed to just one party like every other transaction type.
export function paidByMember(transactions: Transaction[], partyId: string): number {
	return topLevel(transactions).reduce((sum, t) => {
		if (t.type === 'payment') {
			if (partyIdOf(t) === partyId) return sum + (t.total_cost ?? 0);
			if (relatedPartyIdOf(t) === partyId) return sum - (t.total_cost ?? 0);
			return sum;
		}
		return partyIdOf(t) === partyId ? sum + signedAmount(t) : sum;
	}, 0);
}

// What a party still owes the group: their share of the net spend, less what they
// have already paid. Negative means the group owes them. Shared by the summary strip,
// the contributions table and the payment form's "all dues" shortcut, so all three
// can't drift apart.
export function duesFor(
	transactions: Transaction[],
	percents: Record<string, number>,
	partyId: string,
): number {
	const share = (netSpend(transactions) * (percents[partyId] ?? 0)) / 100;
	return share - paidByMember(transactions, partyId);
}

// Same payer/payee split as paidByMember — from the payee's side a payment is
// negative (it's money they received, not money they spent).
export function entryAmount(t: Transaction, viewingPartyId: string): number {
	if (t.type === 'payment') {
		return partyIdOf(t) === viewingPartyId ? (t.total_cost ?? 0) : -(t.total_cost ?? 0);
	}
	return signedAmount(t);
}
