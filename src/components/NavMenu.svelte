<script lang="ts">
	import { onMount } from 'svelte';
	import { onSwapOrDestroy } from '../lib/island-teardown';

	let open = $state(false);
	let reportOpen = $state(false);
	let message = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let reportId = $state<string | null>(null);

	function toggleMenu() {
		open = !open;
	}

	function closeMenu() {
		open = false;
	}

	function openReport() {
		reportOpen = true;
		message = '';
		error = null;
		reportId = null;
		open = false;
	}

	function closeReport() {
		reportOpen = false;
	}

	async function submitReport() {
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
		function onClick(e: MouseEvent) {
			const target = e.target as HTMLElement;
			if (open && !target.closest('.nav-menu')) closeMenu();
		}
		function onKeydown(e: KeyboardEvent) {
			if (e.key === 'Escape') {
				if (reportOpen) closeReport();
				else if (open) closeMenu();
			}
		}
		window.addEventListener('click', onClick);
		window.addEventListener('keydown', onKeydown);
		return onSwapOrDestroy(() => {
			window.removeEventListener('click', onClick);
			window.removeEventListener('keydown', onKeydown);
		});
	});
</script>

<div class="nav-menu">
	<button type="button" class="menu-trigger" onclick={toggleMenu} aria-label="Menu" aria-expanded={open}>
		<span class="hamburger-line"></span>
		<span class="hamburger-line"></span>
		<span class="hamburger-line"></span>
	</button>

	{#if open}
		<div class="menu-dropdown">
			<a href="/account" class="menu-item" onclick={closeMenu}>Account</a>
			<button type="button" class="menu-item" onclick={openReport}>Help</button>
			<form method="POST" action="/api/auth/logout" data-astro-reload>
				<button type="submit" class="menu-item menu-logout">Log out</button>
			</form>
		</div>
	{/if}
</div>

{#if reportOpen}
	<div class="modal-backdrop" onclick={closeReport}>
		<div class="modal-box" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
			{#if reportId}
				<p>Thanks — logged as <code>{reportId}</code>.</p>
				<div class="modal-actions">
					<button type="button" class="btn-plain" onclick={closeReport}>Close</button>
				</div>
			{:else}
				<label class="feedback-label">
					What happened?
					<!-- svelte-ignore a11y_autofocus -->
					<textarea bind:value={message} rows="4" autofocus disabled={submitting}></textarea>
				</label>

				{#if error}<p class="row-error">{error}</p>{/if}

				<div class="modal-actions">
					<button type="button" onclick={submitReport} disabled={submitting || !message.trim()}>
						{submitting ? 'Sending…' : 'Send'}
					</button>
					<button type="button" class="btn-plain" onclick={closeReport} disabled={submitting}>Cancel</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.nav-menu {
		position: relative;
	}

	.menu-trigger {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 4px;
		width: 32px;
		height: 32px;
		padding: 6px;
		background: none;
		border: 1px solid var(--color-border);
		cursor: pointer;
	}

	.menu-trigger:hover {
		border-color: var(--color-border-strong);
	}

	.hamburger-line {
		display: block;
		width: 100%;
		height: 1.5px;
		background: var(--color-fg);
	}

	.menu-dropdown {
		position: absolute;
		top: calc(100% + var(--space-1));
		right: 0;
		min-width: 160px;
		background: var(--color-bg);
		border: 1px solid var(--color-border-strong);
		z-index: 50;
		display: flex;
		flex-direction: column;
	}

	.menu-item {
		display: block;
		width: 100%;
		text-align: left;
		padding: var(--space-2) var(--space-3);
		background: none;
		border: none;
		border-bottom: none;
		color: var(--color-fg);
		font-family: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.menu-item:hover {
		background: var(--color-highlight);
		border-bottom: none;
	}

	.menu-dropdown form {
		margin: 0;
		display: contents;
	}

	.menu-logout {
		border-top: 1px solid var(--color-border);
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
