// A "party" is anything the Money page can attribute money to: a real project member
// (a profiles row, reached through project_members) or a ghost member — a stand-in for
// an outside contributor with no P2 account, like a commissioner or a sponsor.
//
// The two live in different tables, so a transaction points at one or the other, but
// every derived number on the page (shares, dues, paid totals, select values) needs a
// single id space to key by. Ghost ids carry a prefix so any party id can be routed
// back to its own table without a lookup; real members keep their bare user id, which
// is what MoneySummary and every page outside Money already hold.

export const GHOST_PREFIX = 'ghost:';

// The four columns a transaction identifies its two sides with. Typed structurally so
// this module stays free of both the store and the generated database types.
export interface PartyColumns {
	member_id: string | null;
	ghost_member_id: string | null;
	related_member_id: string | null;
	related_ghost_member_id: string | null;
}

export function ghostPartyId(ghostId: string): string {
	return `${GHOST_PREFIX}${ghostId}`;
}

export function isGhostParty(partyId: string): boolean {
	return partyId.startsWith(GHOST_PREFIX);
}

// The bare ghost_members.id behind a party id, or null when the id is a real member's.
export function ghostIdOf(partyId: string): string | null {
	return isGhostParty(partyId) ? partyId.slice(GHOST_PREFIX.length) : null;
}

// Whoever the transaction is attributed to: the payer on a payment, the recorder on
// everything else. Exactly one of the two columns is set (a check constraint enforces
// it), so the empty string is unreachable — it's there to keep the return type a
// plain string for the callers that compare it.
export function partyIdOf(t: PartyColumns): string {
	if (t.ghost_member_id) return ghostPartyId(t.ghost_member_id);
	return t.member_id ?? '';
}

// The other side of a payment; null on every other type.
export function relatedPartyIdOf(t: PartyColumns): string | null {
	if (t.related_ghost_member_id) return ghostPartyId(t.related_ghost_member_id);
	return t.related_member_id;
}

// Which pair of columns a party id writes to. Used by the transaction endpoints so a
// payer/payee is stored in the right table's column without branching at each call.
export function partyColumns(partyId: string): { member_id: string | null; ghost_member_id: string | null } {
	const ghostId = ghostIdOf(partyId);
	return ghostId ? { member_id: null, ghost_member_id: ghostId } : { member_id: partyId, ghost_member_id: null };
}

export function relatedPartyColumns(
	partyId: string | null,
): { related_member_id: string | null; related_ghost_member_id: string | null } {
	if (!partyId) return { related_member_id: null, related_ghost_member_id: null };
	const ghostId = ghostIdOf(partyId);
	return ghostId
		? { related_member_id: null, related_ghost_member_id: ghostId }
		: { related_member_id: partyId, related_ghost_member_id: null };
}
