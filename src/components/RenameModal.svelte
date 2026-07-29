<script lang="ts">
	import { onMount } from 'svelte';
	import { onSwapOrDestroy } from '../lib/island-teardown';
	import { splitFilename } from '../lib/file-kind';

	let {
		kind,
		currentName,
		busy,
		error,
		onConfirm,
		onCancel,
	}: {
		kind: 'file' | 'folder';
		currentName: string;
		busy: boolean;
		error: string | null;
		onConfirm: (newName: string) => void;
		onCancel: () => void;
	} = $props();

	let newName = $state(currentName);

	// Only files carry a meaningful extension — a folder named `v2.1` isn't
	// changing file type by being renamed to `v2.2`.
	let extensionChanged = $derived(
		kind === 'file' && splitFilename(newName.trim()).ext.toLowerCase() !== splitFilename(currentName).ext.toLowerCase()
	);

	let trimmed = $derived(newName.trim());
	let canSubmit = $derived(trimmed !== '' && trimmed !== currentName);

	function submit() {
		if (!canSubmit || busy) return;
		onConfirm(trimmed);
	}

	onMount(() => {
		function onKeydown(e: KeyboardEvent) {
			if (e.key === 'Escape') onCancel();
		}
		window.addEventListener('keydown', onKeydown);
		return onSwapOrDestroy(() => window.removeEventListener('keydown', onKeydown));
	});
</script>

<div class="modal-backdrop" onclick={onCancel}>
	<div class="modal-box" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
		<label class="rename-label">
			New name
			<!-- svelte-ignore a11y_autofocus -->
			<input
				type="text"
				bind:value={newName}
				autofocus
				onkeydown={(e) => e.key === 'Enter' && submit()}
			/>
		</label>

		{#if extensionChanged}
			<p class="warning">
				Changing the extension may make this file unreadable to apps that expect
				{splitFilename(currentName).ext || 'the original extension'}.
			</p>
		{/if}

		{#if error}<p class="row-error">{error}</p>{/if}

		<div class="modal-actions">
			<button type="button" onclick={submit} disabled={busy || !canSubmit}>
				{busy ? 'Renaming…' : 'Rename'}
			</button>
			<button type="button" class="btn-plain" onclick={onCancel} disabled={busy}>Cancel</button>
		</div>
	</div>
</div>

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		z-index: 100;
	}

	.modal-box {
		background: var(--color-bg);
		border: 1px solid var(--color-border-strong);
		padding: var(--space-5);
		width: 100%;
		max-width: 420px;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.rename-label {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: 0.85rem;
	}

	.rename-label input {
		box-sizing: border-box;
		width: 100%;
	}

	.warning {
		color: var(--color-danger);
		font-size: 0.8rem;
		margin: 0;
	}

	.modal-actions {
		display: flex;
		gap: var(--space-2);
	}

	.modal-actions button {
		flex: 1;
	}

	.row-error {
		color: var(--color-danger);
		margin: 0;
	}
</style>
