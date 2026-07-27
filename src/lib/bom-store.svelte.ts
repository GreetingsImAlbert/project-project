import { currentEpoch } from './nav-epoch';

export interface BomItem {
	id: string;
	part_name: string;
	category: string | null;
	description: string | null;
	quantity: number | null;
	unit: string | null;
	unit_cost: number | null;
	supplier: string | null;
	item_url: string | null;
	total_cost: number | null;
}

// Shared across BomTable and MoneySummary — both are independently hydrated
// `client:load` islands on the Money page, so the summary strip's BOM total would
// go stale the moment an item was added/edited/deleted if each kept its own copy.
export const bomState = $state<{ items: BomItem[] }>({ items: [] });

let initializedEpoch = -1;

// See initTransactions in transactions-store.svelte.ts — the once-only guard has to be
// skipped during SSR or one request's items leak into the next request's HTML, and is
// scoped to a navigation rather than to the module on the client (see nav-epoch.ts).
export function initBom(initial: BomItem[]) {
	if (initializedEpoch === currentEpoch() && !import.meta.env.SSR) return;
	bomState.items = initial;
	initializedEpoch = currentEpoch();
}

export function addBomItem(item: BomItem) {
	bomState.items = [...bomState.items, item];
}

export function updateBomItem(item: BomItem) {
	bomState.items = bomState.items.map((x) => (x.id === item.id ? item : x));
}

export function removeBomItem(id: string) {
	bomState.items = bomState.items.filter((x) => x.id !== id);
}
