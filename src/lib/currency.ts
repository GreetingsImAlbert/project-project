// Plain module (no runes) so server-side code — API routes, the projects.currency
// check constraint's TS-side mirror — can import the valid currency list without
// dragging Svelte's $state compilation into a non-component context.
export const CURRENCIES = ['PHP', 'USD'] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];
