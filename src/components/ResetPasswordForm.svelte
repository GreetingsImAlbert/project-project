<script lang="ts">
	// Everything token-related happens client-side on purpose. The recovery link lands
	// here with its tokens in the URL fragment, and a fragment is never sent to the
	// server — so the page this component lives on renders with no session, sets no
	// cookie, and cannot sign anyone in. The tokens are handed to the server only when
	// the new password is actually submitted, and even then the endpoint holds them in
	// a cookie-less client (see api/auth/reset-password.ts).
	import { onMount } from 'svelte';
	import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, passwordProblem } from '../lib/account-validation';
	import { authToastError, authToastSuccess } from '../lib/toast.svelte';

	let tokens = $state<{ accessToken: string; refreshToken: string } | null>(null);
	let linkUnavailable = $state(false);
	let ready = $state(false);

	let password = $state('');
	let confirmPassword = $state('');
	let saving = $state(false);
	let done = $state(false);

	onMount(() => {
		const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
		const query = new URLSearchParams(location.search);

		const accessToken = fragment.get('access_token');
		const refreshToken = fragment.get('refresh_token');
		// Supabase reports a dead or already-spent link as an error on the way back
		// rather than as a missing token, and puts it in whichever half of the URL the
		// flow was using.
		const reported = fragment.get('error_description') ?? query.get('error_description');

		// Strip the tokens out of the address bar first. They never reach the server, but
		// they do survive in history and in whatever a user pastes when asking for help.
		if (location.hash) {
			history.replaceState(null, '', location.pathname + location.search);
		}
		if (query.has('error_description')) {
			query.delete('error_description');
			const cleanSearch = query.toString();
			history.replaceState(null, '', `${location.pathname}${cleanSearch ? `?${cleanSearch}` : ''}`);
		}

		if (reported) {
			authToastError(reported);
			linkUnavailable = true;
		} else if (accessToken && refreshToken) {
			tokens = { accessToken, refreshToken };
		} else {
			authToastError('This page needs to be opened from the link in the reset email.');
			linkUnavailable = true;
		}

		ready = true;
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (saving || !tokens) return;

		const problem = passwordProblem(password);
		if (problem) {
			authToastError(problem);
			return;
		}

		if (password !== confirmPassword) {
			authToastError('The two passwords do not match');
			return;
		}

		saving = true;

		const formData = new FormData();
		formData.set('accessToken', tokens.accessToken);
		formData.set('refreshToken', tokens.refreshToken);
		formData.set('password', password);

		try {
			const res = await fetch('/api/auth/reset-password', { method: 'POST', body: formData });

			if (!res.ok) {
				authToastError(await res.text());
				return;
			}

			// The link is spent and every session is revoked — hold on to nothing.
			tokens = null;
			password = '';
			confirmPassword = '';
			done = true;
			authToastSuccess('Your password has been changed, and every session signed in with the old one has been revoked.');
		} catch (error) {
			authToastError(error instanceof Error ? error.message : 'Could not set the new password');
		} finally {
			saving = false;
		}
	}
</script>

{#if !ready}
	<p class="muted">Checking your reset link…</p>
{:else if done}
	<!-- data-astro-reload: an identity change wants a real document load, same reason as
	     the login and logout forms. -->
	<p><a href="/login" data-astro-reload>Log in with your new password →</a></p>
{:else if linkUnavailable}
	<p><a href="/forgot-password">Request a new reset link →</a></p>
{:else}
	<p class="muted">Choose a new password. You are not signed in yet — you will log in with it once it is set.</p>

	<form class="account-form" onsubmit={save}>
		<div class="field">
			<label for="reset-new-password">New password</label>
			<input
				id="reset-new-password"
				type="password"
				bind:value={password}
				minlength={MIN_PASSWORD_LENGTH}
				maxlength={MAX_PASSWORD_LENGTH}
				autocomplete="new-password"
				required
			/>
			<span class="field-hint">At least {MIN_PASSWORD_LENGTH} characters.</span>
		</div>

		<div class="field">
			<label for="reset-confirm-password">Confirm new password</label>
			<input
				id="reset-confirm-password"
				type="password"
				bind:value={confirmPassword}
				minlength={MIN_PASSWORD_LENGTH}
				maxlength={MAX_PASSWORD_LENGTH}
				autocomplete="new-password"
				required
			/>
		</div>

		<div class="form-actions">
			<button type="submit" disabled={saving}>{saving ? 'Setting…' : 'Set new password'}</button>
		</div>
	</form>
{/if}
