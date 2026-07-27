<script lang="ts">
	// Renders its own cell of the account details grid rather than sitting in a section
	// of its own: the name and the control that changes it belong in the same place.
	import { slide } from 'svelte/transition';
	import { MAX_DISPLAY_NAME_LENGTH, displayNameProblem } from '../lib/account-validation';

	let { initialDisplayName }: { initialDisplayName: string } = $props();

	let editing = $state(false);
	let draft = $state(initialDisplayName);
	let saving = $state(false);
	let error = $state<string | null>(null);

	const trimmed = $derived(draft.trim());

	function toggleEdit() {
		if (editing) {
			editing = false;
			return;
		}

		// Reopening always starts from the saved name, never from an abandoned draft.
		draft = initialDisplayName;
		error = null;
		editing = true;
	}

	// Same close-on-outside-click as the file/folder Actions popovers: match on the whole
	// composed path rather than e.target, since a button inside the panel can already be
	// detached by the time the click reaches the window. The marker sits on the toggle too,
	// or the click that opens the panel would immediately close it again.
	function handleWindowClick(e: MouseEvent) {
		if (!editing || saving) return;

		const inside = e
			.composedPath()
			.some((node) => node instanceof Element && node.hasAttribute('data-name-actions'));

		if (!inside) editing = false;
	}

	function handleWindowKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && editing && !saving) editing = false;
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (saving) return;

		if (trimmed === initialDisplayName) {
			editing = false;
			return;
		}

		const problem = displayNameProblem(trimmed);
		if (problem) {
			error = problem;
			return;
		}

		saving = true;
		error = null;

		const formData = new FormData();
		formData.set('displayName', trimmed);

		const res = await fetch('/api/account/update-display-name', { method: 'POST', body: formData });

		if (!res.ok) {
			error = await res.text();
			saving = false;
			return;
		}

		// The header is server-rendered from the JWT, not an island, so a real load is the
		// only way to get the name in the nav bar to agree with the one just saved — the
		// endpoint has already refreshed the session cookie for it to read.
		location.reload();
	}
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<div class="account-detail">
	<span class="detail-label">
		Display name
		<button
			type="button"
			class="edit-icon"
			data-name-actions
			aria-label="Edit display name"
			aria-expanded={editing}
			onclick={toggleEdit}
		>✎</button>
	</span>
	<span class="detail-value">{initialDisplayName || '—'}</span>

	{#if editing}
		<form class="edit-panel" data-name-actions transition:slide={{ duration: 150 }} onsubmit={save}>
			<label class="field">
				<span>New display name</span>
				<input
					type="text"
					bind:value={draft}
					maxlength={MAX_DISPLAY_NAME_LENGTH}
					autocomplete="nickname"
					required
				/>
			</label>

			{#if error}<p class="form-note error">{error}</p>{/if}

			<div class="panel-actions">
				<button type="submit" disabled={saving || !trimmed}>{saving ? 'Saving…' : 'Save'}</button>
				<button type="button" class="btn-plain" onclick={toggleEdit} disabled={saving}>Cancel</button>
			</div>
		</form>
	{/if}
</div>

<style>
	/* Anchors the overlay panel below the cell. */
	.account-detail {
		position: relative;
	}

	.edit-icon {
		flex: 0 0 auto;
		background: none;
		border: none;
		padding: 0;
		color: var(--color-fg);
		font-size: 0.9rem;
		line-height: 1;
		cursor: pointer;
	}

	.edit-icon:hover {
		opacity: 0.6;
	}

	/* An overlay, same as the file/folder Actions popover: laying it out in flow made the
	   details grid reflow mid-transition, which showed as a flash of half-built layout.
	   Also overrides the global form rules — inside the panel this is a column, not the
	   page-level flex row — and flex-wrap has to be reset along with the direction, since
	   slide animates the height from 0 and a wrapping column container with a constrained
	   height flows the overflow into a second column, which showed as Save/Cancel sitting
	   to the right of the field until the transition reached auto height. */
	.edit-panel {
		position: absolute;
		top: calc(100% + var(--space-1));
		left: 0;
		right: 0;
		z-index: 10;
		display: flex;
		flex-direction: column;
		flex-wrap: nowrap;
		gap: var(--space-2);
		margin: 0;
		background: var(--color-bg);
		border: 1px solid var(--color-border-strong);
		padding: var(--space-2);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}

	.field > span {
		color: var(--color-muted);
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.field input {
		width: 100%;
		min-width: 0;
	}

	.panel-actions {
		display: flex;
		gap: var(--space-2);
	}

	.panel-actions button {
		padding: var(--space-1) var(--space-3);
		font-size: 0.8rem;
	}
</style>
