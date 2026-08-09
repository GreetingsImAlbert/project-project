export const MOBILE_SIDEBAR_ATTR = 'data-sidebar-mobile-open';
export const MOBILE_SIDEBAR_EVENT = 'p2-sidebar-mobile-change';

export function mobileSidebarIsOpen(): boolean {
	return typeof document !== 'undefined' && document.documentElement.hasAttribute(MOBILE_SIDEBAR_ATTR);
}

export function setMobileSidebarOpen(open: boolean): void {
	if (typeof document === 'undefined') return;
	document.documentElement.toggleAttribute(MOBILE_SIDEBAR_ATTR, open);
	window.dispatchEvent(new CustomEvent<{ open: boolean }>(MOBILE_SIDEBAR_EVENT, { detail: { open } }));
}
