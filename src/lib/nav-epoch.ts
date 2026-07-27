// Astro's <ClientRouter /> swaps the DOM on a client-side navigation but leaves every
// module loaded, so a module-scoped `initialized = true` survives from one page to the
// next and the second page keeps the first page's data — the client-side twin of the
// SSR isolate leak the stores already guard against with `import.meta.env.SSR`.
//
// Stores record the epoch they seeded in rather than a bare boolean. The epoch changes
// on every swap, so the first init after a navigation always re-seeds while later
// islands on the same page still no-op.
let epoch = 0;

export function currentEpoch(): number {
	return epoch;
}

// `astro:before-swap`, not `astro:after-swap`: an island hydrates when its <astro-island>
// element is inserted into the document, which happens *during* the swap. Bumping
// afterwards would land after those islands had already read the stale epoch.
if (!import.meta.env.SSR) {
	document.addEventListener('astro:before-swap', () => {
		epoch += 1;
	});
}
