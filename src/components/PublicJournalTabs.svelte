<script lang="ts">
	import JournalHistory from './JournalHistory.svelte';
	import type { PublicProjectJournal } from '../lib/journal';

	let { journals }: { journals: PublicProjectJournal[] } = $props();
	let activeIndex = $state(0);
	let tabButtons = $state<HTMLButtonElement[]>([]);

	function selectJournal(index: number, focus = false) {
		activeIndex = index;
		if (focus) tabButtons[index]?.focus();
	}

	function onTabKeydown(event: KeyboardEvent, index: number) {
		let next = index;
		if (event.key === 'ArrowRight') next = (index + 1) % journals.length;
		else if (event.key === 'ArrowLeft') next = (index - 1 + journals.length) % journals.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = journals.length - 1;
		else return;
		event.preventDefault();
		selectJournal(next, true);
	}
</script>

{#if journals.length > 0}
	<div class="public-journals">
		<div class="tabs-scroll">
			<div class="journal-tabs" role="tablist" aria-label="Public project journals">
				{#each journals as journal, index (`${journal.kind}-${index}`)}
					<button
						bind:this={tabButtons[index]}
						type="button"
						role="tab"
						id={`public-journal-tab-${index}`}
						aria-selected={activeIndex === index}
						aria-controls={`public-journal-panel-${index}`}
						tabindex={activeIndex === index ? 0 : -1}
						class:active={activeIndex === index}
						onclick={() => selectJournal(index)}
						onkeydown={(event) => onTabKeydown(event, index)}
					>
						{journal.label}
					</button>
				{/each}
			</div>
		</div>

		{#each journals as journal, index (`${journal.kind}-${index}`)}
			<div
				class="journal-panel"
				role="tabpanel"
				id={`public-journal-panel-${index}`}
				aria-labelledby={`public-journal-tab-${index}`}
				tabindex="0"
				hidden={activeIndex !== index}
			>
				<h2>{journal.label}</h2>
				<JournalHistory entries={journal.history} />
			</div>
		{/each}
	</div>
{:else}
	<p class="muted empty">No finalized journal entries yet.</p>
{/if}

<style>
	.public-journals { display: flex; flex-direction: column; gap: var(--space-5); }
	.tabs-scroll { overflow-x: auto; border-bottom: 1px solid var(--color-border); scrollbar-width: thin; }
	.journal-tabs { display: flex; width: max-content; min-width: 100%; gap: var(--space-1); }
	.journal-tabs button { min-width: 130px; max-width: 220px; overflow: hidden; padding: var(--space-2) var(--space-3); border: 0; border-bottom: 2px solid transparent; border-radius: var(--radius-sm) var(--radius-sm) 0 0; background: transparent; color: var(--color-muted); font-weight: 600; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
	.journal-tabs button:hover { background: var(--color-highlight); color: var(--color-fg); }
	.journal-tabs button.active { border-bottom-color: var(--color-border-strong); background: var(--color-highlight); color: var(--color-fg); }
	.journal-panel { outline: none; }
	.journal-panel h2 { margin: 0 0 var(--space-4); }
	.empty { font-size: 0.85rem; }
</style>
