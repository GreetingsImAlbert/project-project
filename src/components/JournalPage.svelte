<script lang="ts">
	import { onMount } from 'svelte';
	import { renderMarkdown } from '../lib/markdown';
	import { createBrowserSupabaseClient } from '../lib/supabase/browser';
	import { toastError } from '../lib/toast.svelte';
	import { onSwapOrDestroy } from '../lib/island-teardown';
	import type { SupabaseClient } from '@supabase/supabase-js';

	interface JournalEntry {
		date: string;
		body: string;
	}

	let {
		projectId,
		initialDraftDate,
		initialDraftContent,
		initialEntries,
	}: {
		projectId: string;
		initialDraftDate: string;
		initialDraftContent: string;
		initialEntries: JournalEntry[];
	} = $props();

	// The debounce window between a keystroke and the autosave it triggers — the
	// same PUT that persists the draft is also what every other open tab syncs
	// against (see draft.ts), so this doubles as the app's live-typing latency.
	const SAVE_DEBOUNCE_MS = 500;
	// Comfortably under the hour an access token normally lives for.
	const TOKEN_REFRESH_MS = 45 * 60 * 1000;

	let draftDate = $state(initialDraftDate);
	let content = $state(initialDraftContent);
	let entries = $state(initialEntries);
	let saveState = $state<'idle' | 'saving' | 'saved'>('idle');
	// Set on every keystroke and compared in the realtime handler below, so an
	// incoming row we just wrote ourselves never stomps text typed since.
	let lastSavedContent = initialDraftContent;

	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let saveTimer: ReturnType<typeof setTimeout> | null = null;

	async function saveDraft(value: string) {
		saveState = 'saving';
		try {
			const res = await fetch(`/api/projects/${projectId}/journal/draft`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: value }),
			});
			if (!res.ok) {
				toastError(await res.text());
				saveState = 'idle';
				return;
			}
			const data = (await res.json()) as { draft_date: string };
			draftDate = data.draft_date;
			lastSavedContent = value;
			saveState = 'saved';
		} catch {
			toastError('Could not save — check your connection');
			saveState = 'idle';
		}
	}

	function onInput() {
		saveState = 'idle';
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => saveDraft(content), SAVE_DEBOUNCE_MS);
	}

	// Realtime: the database migrations add journal_drafts to the
	// supabase_realtime publication, so any owner/editor's save — including this
	// tab's own, once it
	// round-trips — arrives here as a Postgres Changes UPDATE. Own writes are
	// recognised by matching `lastSavedContent` and skipped; anything else is a
	// collaborator's edit and replaces the textarea outright. There's no merge —
	// two people typing into the same day at the same moment will have one
	// overwrite the other, the same tradeoff any single shared text field has
	// without an operational-transform engine behind it.
	let client: SupabaseClient | null = null;
	let tokenTimer: ReturnType<typeof setInterval> | null = null;

	async function refreshRealtimeAuth() {
		if (!client) return;
		try {
			const res = await fetch(`/api/projects/${projectId}/journal/realtime-token`);
			if (!res.ok) return;
			const { accessToken } = (await res.json()) as { accessToken: string };
			client.realtime.setAuth(accessToken);
		} catch {
			// A missed refresh just means the socket falls back to its last token —
			// worst case the subscription stops receiving updates until the next tick.
		}
	}

	onMount(() => {
		let cancelled = false;

		(async () => {
			try {
				client = createBrowserSupabaseClient();
				await refreshRealtimeAuth();
				if (cancelled || !client) return;

				client
					.channel(`journal-drafts-${projectId}`)
					.on(
						'postgres_changes',
						{ event: 'UPDATE', schema: 'public', table: 'journal_drafts', filter: `project_id=eq.${projectId}` },
						(payload) => {
							const row = payload.new as { draft_date: string; content: string };
							draftDate = row.draft_date;
							if (row.content !== lastSavedContent) {
								content = row.content;
								lastSavedContent = row.content;
							}
						},
					)
					.subscribe();

				tokenTimer = setInterval(refreshRealtimeAuth, TOKEN_REFRESH_MS);
			} catch {
				// No PUBLIC_SUPABASE_* env configured, or the socket couldn't connect —
				// the textarea still autosaves via plain PUT, just without live sync
				// from other tabs until this resolves.
				console.error('[journal] realtime sync unavailable; autosave still works');
			}
		})();

		return onSwapOrDestroy(() => {
			cancelled = true;
			if (saveTimer) clearTimeout(saveTimer);
			if (tokenTimer) clearInterval(tokenTimer);
			// Unsubscribes every channel this client holds — there's only ever the one.
			client?.removeAllChannels();
		});
	});
</script>

<div class="journal">
	<section class="today">
		<div class="today-head">
			<h3>{draftDate}</h3>
			<span class="save-state muted">
				{#if saveState === 'saving'}Saving…{:else if saveState === 'saved'}Saved{/if}
			</span>
		</div>
		<textarea
			bind:this={textareaEl}
			bind:value={content}
			oninput={onInput}
			placeholder="What did you work on today?"
			aria-label={`Journal entry for ${draftDate}`}
		></textarea>
		<p class="hint muted">
			Saved automatically at the end of the day. Past entries can still be edited from the Journal file in
			<a href={`/projects/${projectId}/files`}>Files</a>.
		</p>
	</section>

	{#if entries.length > 0}
		<section class="history">
			{#each entries as entry (entry.date)}
				<article class="entry">
					<h3>{entry.date}</h3>
					<!-- renderMarkdown escapes the whole source, same as FileViewerPanel's use — an
					     entry is just this project's own textarea content, but nothing here treats
					     it as trusted markup on that basis. -->
					<div class="md-body">{@html renderMarkdown(entry.body)}</div>
				</article>
			{/each}
		</section>
	{/if}
</div>

<style>
	.journal {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}

	.today-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-2);
	}

	.today-head h3 {
		margin: 0;
	}

	.save-state {
		font-size: 0.8rem;
	}

	textarea {
		width: 100%;
		min-height: 220px;
		box-sizing: border-box;
		resize: vertical;
		padding: var(--space-3);
		font-family: inherit;
		font-size: 0.9rem;
		line-height: 1.6;
	}

	.hint {
		margin: var(--space-2) 0 0;
		font-size: 0.8rem;
	}

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
</style>
