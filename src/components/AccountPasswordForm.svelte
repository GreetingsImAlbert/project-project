<script lang="ts">
	import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, passwordProblem } from '../lib/account-validation';

	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);
	let success = $state(false);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (saving) return;

		error = null;
		success = false;

		const problem = passwordProblem(newPassword);
		if (problem) {
			error = problem;
			return;
		}

		if (newPassword !== confirmPassword) {
			error = 'The two new passwords do not match';
			return;
		}

		saving = true;

		const formData = new FormData();
		formData.set('currentPassword', currentPassword);
		formData.set('newPassword', newPassword);

		const res = await fetch('/api/account/update-password', { method: 'POST', body: formData });

		if (!res.ok) {
			error = await res.text();
			saving = false;
			return;
		}

		currentPassword = '';
		newPassword = '';
		confirmPassword = '';
		success = true;
		saving = false;
	}
</script>

<form class="account-form" onsubmit={save}>
	<div class="field">
		<label for="account-current-password">Current password</label>
		<input
			id="account-current-password"
			type="password"
			bind:value={currentPassword}
			autocomplete="current-password"
			required
		/>
	</div>

	<div class="field">
		<label for="account-new-password">New password</label>
		<input
			id="account-new-password"
			type="password"
			bind:value={newPassword}
			minlength={MIN_PASSWORD_LENGTH}
			maxlength={MAX_PASSWORD_LENGTH}
			autocomplete="new-password"
			required
		/>
		<span class="field-hint">At least {MIN_PASSWORD_LENGTH} characters.</span>
	</div>

	<div class="field">
		<label for="account-confirm-password">Confirm new password</label>
		<input
			id="account-confirm-password"
			type="password"
			bind:value={confirmPassword}
			minlength={MIN_PASSWORD_LENGTH}
			maxlength={MAX_PASSWORD_LENGTH}
			autocomplete="new-password"
			required
		/>
	</div>

	<div class="form-actions">
		<button type="submit" disabled={saving}>{saving ? 'Changing…' : 'Change password'}</button>
	</div>

	<p class="form-note muted">Changing your password signs out every other device. This one stays signed in.</p>

	{#if error}<p class="form-note error">{error}</p>{/if}
	{#if success}<p class="form-note success" role="status">Password changed. All other sessions have been signed out.</p>{/if}
</form>
