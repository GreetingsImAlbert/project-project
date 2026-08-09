// Transient page-level notices, rendered top-right by Toasts.svelte. Buttons stay
// enabled even when their preconditions aren't met, so the reason a click did nothing
// has to be said out loud somewhere — this is that somewhere.
//
// Module-level state, same pattern as the other *.svelte.ts stores, but with no init()
// to guard: nothing pushes a toast during SSR, so a Worker isolate shared across
// requests can never leak one request's notice into another's HTML.

export type ToastKind = 'error' | 'success';

export interface Toast {
	id: number;
	kind: ToastKind;
	message: string;
}

const DISMISS_AFTER_MS = 3000;
const AUTH_DISMISS_AFTER_MS = 8000;

let nextId = 0;

export const toastState = $state<{ toasts: Toast[] }>({ toasts: [] });

export function dismissToast(id: number) {
	toastState.toasts = toastState.toasts.filter((t) => t.id !== id);
}

export function pushToast(message: string, kind: ToastKind = 'error', dismissAfterMs = DISMISS_AFTER_MS) {
	const trimmed = message.trim();
	if (!trimmed) return;

	const id = ++nextId;
	toastState.toasts = [...toastState.toasts, { id, kind, message: trimmed }];
	setTimeout(() => dismissToast(id), dismissAfterMs);
}

export function toastError(message: string) {
	pushToast(message, 'error');
}

export function toastSuccess(message: string) {
	pushToast(message, 'success');
}

export function authToastError(message: string) {
	pushToast(message, 'error', AUTH_DISMISS_AFTER_MS);
}

export function authToastSuccess(message: string) {
	pushToast(message, 'success', AUTH_DISMISS_AFTER_MS);
}
