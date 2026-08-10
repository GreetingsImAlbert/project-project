<script lang="ts">
	import { renderMarkdown } from '../lib/markdown';
	import type { JournalEntry } from '../lib/journal-entries';

	export type { JournalEntry };

	let {
		entries,
		emptyMessage = 'No finalized journal entries yet.',
	}: {
		entries: JournalEntry[];
		emptyMessage?: string;
	} = $props();
</script>

{#if entries.length > 0}
	<section class="history">
		{#each entries as entry (entry.date)}
			<article class="entry">
				<h3>{entry.date}</h3>
				<!-- renderMarkdown escapes the source before rebuilding its safe subset. -->
				<div class="md-body">{@html renderMarkdown(entry.body)}</div>
			</article>
		{/each}
	</section>
{:else}
	<p class="muted empty">{emptyMessage}</p>
{/if}

<style>
	.history {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	.entry {
		padding-top: var(--space-5);
		border-top: 1px solid var(--color-border);
	}

	.entry h3 {
		margin: 0 0 var(--space-2);
	}

	.md-body :global(> *:first-child) {
		margin-top: 0;
	}

	.md-body :global(> *:last-child) {
		margin-bottom: 0;
	}

	.empty {
		font-size: 0.85rem;
	}
</style>
