// Astro's <ClientRouter /> replaces <body> on a client-side navigation but never
// unmounts the framework islands it discards — the DOM nodes go, the component objects
// stay. So a component's own `onMount` cleanup never runs and anything it bound to
// `window` or `document` (which are *not* replaced) stays bound forever, pointing at a
// component whose markup is gone. Navigate away and back and you have two of them.
//
// Register cleanup here instead of returning it straight from `onMount`: it runs on the
// swap as well as on an ordinary component destroy, whichever comes first.
//
//   onMount(() => {
//     window.addEventListener('popstate', onPopState);
//     return onSwapOrDestroy(() => window.removeEventListener('popstate', onPopState));
//   });

type Teardown = () => void;
interface PendingTeardown {
	fn: Teardown;
	persistSelector?: string;
}

const pending = new Set<PendingTeardown>();

if (!import.meta.env.SSR) {
	document.addEventListener('astro:before-swap', (event) => {
		// Copy first: a teardown that itself calls the returned disposer would otherwise
		// mutate the set mid-iteration.
		const entries = [...pending];
		for (const entry of entries) {
			if (entry.persistSelector && event.newDocument.querySelector(entry.persistSelector)) continue;
			pending.delete(entry);
			entry.fn();
		}
	});
}

// Returns a disposer safe to use as an `onMount` cleanup — running it de-registers the
// teardown as well as performing it, so it can never run twice.
export function onSwapOrDestroy(fn: Teardown, persistSelector?: string): Teardown {
	const entry = { fn, persistSelector };
	pending.add(entry);
	return () => {
		if (!pending.delete(entry)) return;
		fn();
	};
}
