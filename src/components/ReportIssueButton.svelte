<script lang="ts">
	import { onMount } from 'svelte';
	import { onSwapOrDestroy } from '../lib/island-teardown';

	let open = $state(false);
	let message = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let reportId = $state<string | null>(null);

	function openModal() {
		open = true;
		message = '';
		error = null;
		reportId = null;
	}

	function closeModal() {
		open = false;
	}

	async function submit() {
		const trimmed = message.trim();
		if (!trimmed || submitting) return;

		submitting = true;
		error = null;

		const res = await fetch('/api/feedback', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: trimmed, path: location.pathname }),
		});

		submitting = false;

		if (!res.ok) {
			error = await res.text();
			return;
		}

		const body = await res.json() as { reportId: string };
		reportId = body.reportId;
	}

	onMount(() => {
		function onKeydown(e: KeyboardEvent) {
			if (open && e.key === 'Escape') closeModal();
		}
		window.addEventListener('keydown', onKeydown);
		return onSwapOrDestroy(() => window.removeEventListener('keydown', onKeydown));
	});
</script>

<button type="button" class="report-issue-trigger" onclick={openModal}>
	<em>Report an issue</em><span aria-hidden="true">↗</span>
</button>

{#if open}
	<div class="modal-backdrop" onclick={closeModal}>
		<div class="modal-box" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
			{#if reportId}
				<p>Thanks — logged as <code>{reportId}</code>.</p>
				<div class="modal-actions">
					<button type="button" class="btn-plain" onclick={closeModal}>Close</button>
				</div>
			{:else}
				<label class="feedback-label">
					What happened?
					<!-- svelte-ignore a11y_autofocus -->
					<textarea bind:value={message} rows="4" autofocus disabled={submitting}></textarea>
				</label>

				{#if error}<p class="row-error">{error}</p>{/if}

				<div class="modal-actions">
					<button type="button" onclick={submit} disabled={submitting || !message.trim()}>
						{submitting ? 'Sending…' : 'Send'}
					</button>
					<button type="button" class="btn-plain" onclick={closeModal} disabled={submitting}>Cancel</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.report-issue-trigger {
		background: none;
		border: none;
		padding: 0;
		font-size: 0.78rem;
		color: var(--color-muted);
		cursor: pointer;
		display: inline-flex;
		align-items: baseline;
		gap: 2px;
	}

	.report-issue-trigger:hover {
		color: var(--color-fg);
	}

	.report-issue-trigger span {
		font-style: normal;
		font-size: 0.7rem;
	}

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

	.feedback-label {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: 0.85rem;
	}

	.feedback-label textarea {
		box-sizing: border-box;
		width: 100%;
		font-family: inherit;
		resize: vertical;
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
