<script lang="ts">
	import { onSwapOrDestroy } from '../lib/island-teardown';
	import { PUBLIC_SECTIONS, type PublicSection } from '../lib/project-visibility';

	let {
		projectId,
		isPublic,
		publicFilesEnabled,
		publicTasksEnabled,
		publicJournalEnabled,
		publicMoneyEnabled,
	}: {
		projectId: string;
		isPublic: boolean;
		publicFilesEnabled: boolean;
		publicTasksEnabled: boolean;
		publicJournalEnabled: boolean;
		publicMoneyEnabled: boolean;
	} = $props();

	const labels: Record<PublicSection, string> = {
		overview: 'Overview',
		tasks: 'Tasks',
		files: 'Files',
		journal: 'Journal',
		money: 'Money',
	};

	let values = $state<Record<PublicSection, boolean>>({
		overview: isPublic,
		tasks: publicTasksEnabled,
		files: publicFilesEnabled,
		journal: publicJournalEnabled,
		money: publicMoneyEnabled,
	});
	let saving = $state<PublicSection | null>(null);
	let saved = $state<PublicSection | null>(null);
	let error = $state<{ section: PublicSection; message: string } | null>(null);
	let savedTimers: Partial<Record<PublicSection, ReturnType<typeof setTimeout>>> = {};

	function setValue(section: PublicSection, next: boolean) {
		values[section] = next;
		saved = null;
		error = null;
	}

	function restoreValue(section: PublicSection, previous: boolean) {
		values[section] = previous;
	}

	async function setVisibility(section: PublicSection, next: boolean) {
		const current = values[section];
		if (next === current || saving) return;
		const previous = current;
		setValue(section, next);
		saving = section;

		try {
			const res = await fetch(`/api/projects/${projectId}/visibility`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ section, enabled: next }),
			});
			if (!res.ok) {
				restoreValue(section, previous);
				error = { section, message: await res.text() };
				return;
			}
			clearTimeout(savedTimers[section]);
			saved = section;
			savedTimers[section] = setTimeout(() => {
				if (saved === section) saved = null;
			}, 2500);
		} catch (cause) {
			error = {
				section,
				message: cause instanceof Error ? cause.message : 'Could not save visibility',
			};
			restoreValue(section, previous);
		} finally {
			saving = null;
		}
	}

	onSwapOrDestroy(() => {
		for (const timer of Object.values(savedTimers)) clearTimeout(timer);
	});
</script>

<div class="visibility-picker">
	{#each PUBLIC_SECTIONS as section}
		<div class="visibility-row">
			<strong>{labels[section]}</strong>
			<button
				type="button"
				class="visibility-switch"
				class:active={values[section]}
				role="switch"
				aria-checked={values[section]}
				aria-label={`${labels[section]} visibility`}
				disabled={saving !== null}
				title={values[section] ? `Make ${labels[section].toLowerCase()} private` : `Make ${labels[section].toLowerCase()} public`}
				onclick={() => setVisibility(section, !values[section])}
			>
				<span class="visibility-switch-track" aria-hidden="true"><span class="visibility-switch-thumb"></span></span>
				<span class="visibility-switch-label">{values[section] ? 'Public' : 'Private'}</span>
			</button>
			{#if saving === section}
				<p class="visibility-status muted" role="status">Saving…</p>
			{:else if saved === section}
				<p class="visibility-status muted" role="status">Saved</p>
			{/if}
			{#if error?.section === section}<p class="row-error">{error.message}</p>{/if}
		</div>
	{/each}
</div>

<style>
	.visibility-picker {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.visibility-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.visibility-row strong {
		min-width: 4rem;
	}

	.visibility-switch {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--color-border-strong);
		background: var(--color-bg);
		color: var(--color-fg);
		cursor: pointer;
	}

	.visibility-switch.active {
		background: var(--color-highlight);
	}

	.visibility-switch:disabled {
		cursor: not-allowed;
		opacity: 0.65;
	}

	.visibility-switch-track {
		position: relative;
		display: block;
		width: 2rem;
		height: 1.1rem;
		border-radius: 999px;
		background: var(--color-muted);
		transition: background 0.12s ease;
	}

	.visibility-switch.active .visibility-switch-track {
		background: var(--color-highlight-strong);
	}

	.visibility-switch-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: calc(1.1rem - 4px);
		height: calc(1.1rem - 4px);
		border-radius: 50%;
		background: var(--color-bg);
		transition: transform 0.12s ease;
	}

	.visibility-switch.active .visibility-switch-thumb {
		transform: translateX(0.9rem);
	}

	.visibility-switch-label {
		font-size: 0.85rem;
		font-weight: 700;
		letter-spacing: 0.02em;
	}

	.visibility-status {
		font-size: 0.75rem;
		margin: 0;
	}

	.row-error {
		color: var(--color-danger);
		margin: 0;
	}
</style>
