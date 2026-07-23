export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'PHP'] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

export const currencyState = $state<{ code: CurrencyCode }>({ code: 'USD' });

const STORAGE_KEY = 'p2-currency';

export function setCurrency(code: CurrencyCode) {
	currencyState.code = code;
	localStorage.setItem(STORAGE_KEY, code);
}

export function initCurrency() {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored && (CURRENCIES as readonly string[]).includes(stored)) {
		currencyState.code = stored as CurrencyCode;
	}
}

export function formatCurrency(value: number): string {
	return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyState.code }).format(value);
}
