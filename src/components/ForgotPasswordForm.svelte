<script lang="ts">
	import { onMount } from 'svelte';
	import { authToastError, authToastSuccess } from '../lib/toast.svelte';
	import { consumeQueryFlag, readAuthResponse, responseErrorMessage, withBusy } from '../lib/auth-client';

	const DEFAULT_SUCCESS_MESSAGE =
		'If an account exists for that address, a reset link is on its way. It is single-use and expires shortly — open the newest one if you asked more than once.';

	const { sent = false }: { sent?: boolean } = $props();
	let busy = $state(false);

	function clearSentNotice() {
		if (!sent) return;

		authToastSuccess(DEFAULT_SUCCESS_MESSAGE);
		const { cleanUrl } = consumeQueryFlag(window.location.href, 'sent');
		window.history.replaceState(window.history.state, '', cleanUrl);
	}

	onMount(clearSentNotice);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;

		await withBusy((value) => (busy = value), async () => {
			try {
				const form = event.currentTarget as HTMLFormElement;
				const response = await fetch(form.action, {
					method: 'POST',
					body: new FormData(form),
					headers: { Accept: 'application/json' },
				});
				const result = await readAuthResponse(response);

				if (!response.ok) {
					authToastError(responseErrorMessage(result, 'Could not send the reset link'));
					return;
				}

				authToastSuccess(result.message || DEFAULT_SUCCESS_MESSAGE);
				form.reset();
			} catch (error) {
				authToastError(error instanceof Error ? error.message : 'Could not send the reset link');
			}
		});
	}
</script>

<form method="POST" action="/api/auth/forgot-password" data-astro-reload onsubmit={submit}>
	<input type="email" name="email" placeholder="Email" autocomplete="email" required />
	<button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
</form>
