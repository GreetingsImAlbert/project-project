import { currentEpoch } from './nav-epoch';

// The Money page's cast of parties — real members plus ghost members (see
// money-parties.ts). Shared for the same reason as transactions-store: adding,
// renaming or deleting a ghost happens in MemberContributionsTable, but the
// transaction forms two sections above it offer the same list, and without a shared
// store a ghost added at the bottom of the page wouldn't be selectable at the top
// until a reload.
export interface Party {
	// Real member: their user id. Ghost: 'ghost:' + ghost_members.id.
	id: string;
	displayName: string;
	isGhost: boolean;
	note: string | null;
	contributionPercent: number | null;
}

export const partiesState = $state<{ items: Party[] }>({ items: [] });

let initializedEpoch = -1;

// See initTransactions in transactions-store.svelte.ts for the epoch guard.
export function initParties(initial: Party[]) {
	if (initializedEpoch === currentEpoch() && !import.meta.env.SSR) return;
	partiesState.items = initial;
	initializedEpoch = currentEpoch();
}

// Ghosts land after the real members, which is also the order the SSR list arrives in.
export function addParty(party: Party) {
	partiesState.items = [...partiesState.items, party];
}

export function updateParty(id: string, patch: Partial<Party>) {
	partiesState.items = partiesState.items.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

export function removeParty(id: string) {
	partiesState.items = partiesState.items.filter((p) => p.id !== id);
}
