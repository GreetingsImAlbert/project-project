import { currentEpoch } from './nav-epoch';
import { CURRENCIES, type CurrencyCode } from './currency';

export { CURRENCIES, type CurrencyCode };

export const currencyState = $state<{ code: CurrencyCode }>({ code: 'PHP' });

let initializedEpoch = -1;

// Currency is a project property, not a per-user preference, so it comes down
// from the server with the rest of the project's data — same once-per-navigation
// guard as bomState/transactionsState (see initBom in bom-store.svelte.ts):
// whichever currency-consuming island on the page hydrates first seeds it, the
// rest no-op.
export function initCurrency(code: CurrencyCode) {
	if (initializedEpoch === currentEpoch() && !import.meta.env.SSR) return;
	currencyState.code = code;
	initializedEpoch = currentEpoch();
}

// Used after a successful save in the project settings picker, to reflect the
// new currency immediately without a full reload.
export function setCurrency(code: CurrencyCode) {
	currencyState.code = code;
}

export function formatCurrency(value: number): string {
	return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyState.code }).format(value);
}
