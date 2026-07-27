import { currentEpoch } from './nav-epoch';

// Shared across MemberContributionsTable and MoneySummary — the summary strip shows
// the viewing member's own share/dues, which change the instant the split is edited
// in the contributions table. Same cross-island pattern as transactions-store.
export const contributionsState = $state<{ percents: Record<string, number> }>({ percents: {} });

let initializedEpoch = -1;

// See initTransactions in transactions-store.svelte.ts — the once-only guard has to be
// skipped during SSR or one request's split leaks into the next request's HTML, and is
// scoped to a navigation rather than to the module on the client (see nav-epoch.ts).
export function initContributions(percents: Record<string, number>) {
	if (initializedEpoch === currentEpoch() && !import.meta.env.SSR) return;
	contributionsState.percents = percents;
	initializedEpoch = currentEpoch();
}

export function setContributionPercents(percents: Record<string, number>) {
	contributionsState.percents = { ...contributionsState.percents, ...percents };
}
