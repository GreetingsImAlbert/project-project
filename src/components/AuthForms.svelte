<script lang="ts">
	import { onMount } from 'svelte';
	import { authToastError, authToastSuccess } from '../lib/toast.svelte';
	import { consumeQueryFlag, readAuthResponse, responseErrorMessage, withBusy } from '../lib/auth-client';

	const EMAIL_CONFIRMATION_MESSAGE =
		'Account created! Check your email for a confirmation link before logging in.';

	const { checkEmail = false }: { checkEmail?: boolean } = $props();
	let loginBusy = $state(false);
	let signupBusy = $state(false);

	function clearCheckEmailNotice() {
		if (!checkEmail) return;

		authToastSuccess(EMAIL_CONFIRMATION_MESSAGE);

		const { cleanUrl } = consumeQueryFlag(window.location.href, 'checkEmail');
		window.history.replaceState(window.history.state, '', cleanUrl);
	}

	onMount(clearCheckEmailNotice);

	async function submitAuthForm(event: SubmitEvent, kind: 'login' | 'signup') {
		event.preventDefault();

		const form = event.currentTarget as HTMLFormElement;
		const setBusy = kind === 'login' ? (value: boolean) => (loginBusy = value) : (value: boolean) => (signupBusy = value);
		if (kind === 'login' ? loginBusy : signupBusy) return;

		await withBusy(setBusy, async () => {
			try {
				const response = await fetch(form.action, {
					method: 'POST',
					body: new FormData(form),
					headers: { Accept: 'application/json' },
				});
				const result = await readAuthResponse(response);

				if (!response.ok) {
					authToastError(responseErrorMessage(result, 'Could not complete the request'));
					return;
				}

				if (result.redirect) {
					// Auth changes need a document load so Astro renders the new identity.
					window.location.assign(result.redirect);
					return;
				}

				if (result.requiresEmailConfirmation || result.message) {
					authToastSuccess(result.message || EMAIL_CONFIRMATION_MESSAGE);
					form.reset();
					return;
				}

				authToastError('The server returned an unexpected response');
			} catch (error) {
				authToastError(error instanceof Error ? error.message : 'Could not complete the request');
			}
		});
	}
</script>

<h2>Log in</h2>
<form method="POST" action="/api/auth/login" data-astro-reload onsubmit={(event) => submitAuthForm(event, 'login')}>
	<input type="email" name="email" placeholder="Email" autocomplete="email" required />
	<input type="password" name="password" placeholder="Password" autocomplete="current-password" required />
	<label class="remember-me">
		<input type="checkbox" name="rememberMe" />
		Stay signed in for 30 days
	</label>
	<button type="submit" disabled={loginBusy}>{loginBusy ? 'Logging in…' : 'Log in'}</button>
</form>
<p class="auth-aside muted"><a href="/forgot-password">Forgot your password?</a></p>

<style>
	/* Keep the original login page layout after moving the forms into this hydrated island. */
	form {
		flex-direction: column;
		align-items: stretch;
	}

	.auth-aside {
		font-size: 0.85rem;
	}

	.remember-me {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9rem;
	}

	.remember-me input {
		width: auto;
	}
</style>

<h2>Sign up</h2>
<form method="POST" action="/api/auth/signup" data-astro-reload onsubmit={(event) => submitAuthForm(event, 'signup')}>
	<input type="email" name="email" placeholder="Email" autocomplete="email" required />
	<input type="password" name="password" placeholder="Password" autocomplete="new-password" required />
	<input type="text" name="displayName" placeholder="Display name" autocomplete="name" required />
	<button type="submit" disabled={signupBusy}>{signupBusy ? 'Creating…' : 'Sign up'}</button>
</form>
