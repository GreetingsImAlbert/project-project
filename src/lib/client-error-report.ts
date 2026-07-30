// Global safety net for uncaught browser-side errors — the client-side
// counterpart to middleware.ts's catch-all. Attached once to `window`, which
// (unlike DOM inside <main>) survives every ClientRouter swap, so this only
// needs to run once per page load. Silent by design: there's no app-wide
// toast host mounted (see toast.svelte.ts — only FileBrowser.svelte mounts
// Toasts), so this is purely "so the developer can see it happened," not a
// user-facing notice.
function report(message: string, stack?: string | null) {
	try {
		const body = JSON.stringify({
			message: message.slice(0, 2000),
			stack: stack ? stack.slice(0, 8000) : null,
			url: location.href,
		});
		fetch('/api/log-error', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
			keepalive: true,
		}).catch(() => {});
	} catch {
		// Reporting must never itself throw.
	}
}

window.addEventListener('error', (event) => {
	report(event.message, event.error instanceof Error ? event.error.stack : undefined);
});

window.addEventListener('unhandledrejection', (event) => {
	const reason = event.reason;
	if (reason instanceof Error) {
		report(reason.message, reason.stack);
	} else {
		report(String(reason));
	}
});
