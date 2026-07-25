// Shared across MemberContributionsTable and MoneySummary — the summary strip shows
// the viewing member's own share/dues, which change the instant the split is edited
// in the contributions table. Same cross-island pattern as transactions-store.
export const contributionsState = $state<{ percents: Record<string, number> }>({ percents: {} });

let initialized = false;

// See initTransactions in transactions-store.svelte.ts — the once-only guard has to
// be skipped during SSR or one request's split leaks into the next request's HTML.
export function initContributions(percents: Record<string, number>) {
	if (initialized && !import.meta.env.SSR) return;
	contributionsState.percents = percents;
	initialized = true;
}

export function setContributionPercents(percents: Record<string, number>) {
	contributionsState.percents = { ...contributionsState.percents, ...percents };
}
