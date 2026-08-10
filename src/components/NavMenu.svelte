<script lang="ts">
	import { onMount } from 'svelte';
	import { onSwapOrDestroy } from '../lib/island-teardown';
	import Avatar from './Avatar.svelte';

	let {
		avatar = null,
		displayName = '',
		guest = false,
	}: { avatar?: string | null; displayName?: string; guest?: boolean } = $props();

	let open = $state(false);
	type FeedbackMode = 'help' | 'suggest';
	let feedbackMode = $state<FeedbackMode | null>(null);
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

	function openReport(mode: FeedbackMode) {
		feedbackMode = mode;
		message = '';
		error = null;
		reportId = null;
		open = false;
	}

	function closeReport() {
		feedbackMode = null;
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
				if (feedbackMode) closeReport();
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
	<button type="button" class="menu-trigger" onclick={toggleMenu} aria-label="Account menu" aria-expanded={open}>
		<Avatar {avatar} {displayName} size={32} />
	</button>

	{#if open}
		<div class="menu-dropdown">
			{#if guest}
				<!-- Guests get a single entry point: the login page is the combined
				     login/signup page, so one item covers both. Help and Suggest stay — the
				     feedback endpoint accepts reports without a session. -->
				<a href="/login" class="menu-item" onclick={closeMenu} data-astro-prefetch>Log in / Register</a>
				<button type="button" class="menu-item" onclick={() => openReport('help')}>Help</button>
				<button type="button" class="menu-item" onclick={() => openReport('suggest')}>Suggest</button>
			{:else}
				<a href="/account" class="menu-item" onclick={closeMenu} data-astro-prefetch>Account</a>
				<button type="button" class="menu-item" onclick={() => openReport('help')}>Help</button>
				<button type="button" class="menu-item" onclick={() => openReport('suggest')}>Suggest</button>
				<form method="POST" action="/api/auth/logout" data-astro-reload>
					<button type="submit" class="menu-item menu-logout">Log out</button>
				</form>
			{/if}
		</div>
	{/if}
</div>

{#if feedbackMode}
	<div class="modal-backdrop" onclick={closeReport}>
		<div class="modal-box" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
			{#if reportId}
				<p>Thanks — logged as <code>{reportId}</code>.</p>
				<div class="modal-actions">
					<button type="button" class="btn-plain" onclick={closeReport}>Close</button>
				</div>
			{:else}
				<label class="feedback-label">
					{feedbackMode === 'suggest' ? 'Any feature or improvement suggestions?' : 'What happened?'}
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

	/* The avatar is the whole control — the ring is what a hover/focus has to move, since
	   the picture itself must not change. */
	.menu-trigger {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		background: none;
		border: none;
		border-radius: 50%;
		box-shadow: 0 0 0 1px var(--color-border);
		cursor: pointer;
		line-height: 0;
	}

	.menu-trigger:hover,
	.menu-trigger[aria-expanded='true'] {
		box-shadow: 0 0 0 2px var(--color-border-strong);
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
