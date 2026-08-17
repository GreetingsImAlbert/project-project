<script lang="ts">
	import { onMount } from 'svelte';
	import JournalHistory from './JournalHistory.svelte';
	import type { JournalEntry } from '../lib/journal-entries';
	import { createBrowserSupabaseClient } from '../lib/supabase/browser';
	import { toastError } from '../lib/toast.svelte';
	import { onSwapOrDestroy } from '../lib/island-teardown';
	import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
	import {
		isRealtimeRowForJournal,
		journalDraftEndpoint,
		journalRealtimeFilter,
		type JournalRealtimeRow,
	} from '../lib/journal-client-sync';

	let {
		projectId,
		journalFileId = null,
		initialDraftDate,
		initialDraftContent,
		initialEntries,
	}: {
		projectId: string;
		journalFileId?: string | null;
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
	let latestSaveSequence = 0;
	let pendingSave: Promise<void> | null = null;
	let disposed = false;
	const recentOwnWrites = new Map<string, number>();

	function ownWriteKey(targetJournalFileId: string | null, value: string): string {
		return `${targetJournalFileId ?? 'legacy'}\u0000${value}`;
	}

	function rememberOwnWrite(targetJournalFileId: string | null, value: string) {
		const now = Date.now();
		for (const [key, expiresAt] of recentOwnWrites) {
			if (expiresAt <= now) recentOwnWrites.delete(key);
		}
		recentOwnWrites.set(ownWriteKey(targetJournalFileId, value), now + 30_000);
	}

	async function saveDraft(value: string, targetJournalFileId: string | null, keepalive = false) {
		const sequence = ++latestSaveSequence;
		rememberOwnWrite(targetJournalFileId, value);
		saveState = 'saving';
		try {
			const res = await fetch(journalDraftEndpoint(projectId, targetJournalFileId), {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: value }),
				keepalive,
			});
			// A response from a previous tab/save must not mutate the active journal.
			if (sequence !== latestSaveSequence || targetJournalFileId !== journalFileId || disposed) return;
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
			if (sequence !== latestSaveSequence || targetJournalFileId !== journalFileId || disposed) return;
			toastError('Could not save — check your connection');
			saveState = 'idle';
		}
	}

	function startSave(value: string, targetJournalFileId: string | null, keepalive = false): Promise<void> {
		const save = saveDraft(value, targetJournalFileId, keepalive);
		pendingSave = save;
		void save.finally(() => {
			if (pendingSave === save) pendingSave = null;
		});
		return save;
	}

	// Step 4's tab controller can await this before changing journalFileId. The
	// current single-journal page also calls it best-effort during teardown.
	export async function flushPendingSave(keepalive = false): Promise<void> {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		const inFlight = pendingSave;
		if (content !== lastSavedContent) {
			await startSave(content, journalFileId, keepalive);
		} else if (inFlight) {
			await inFlight;
		}
	}

	function onInput() {
		saveState = 'idle';
		if (saveTimer) clearTimeout(saveTimer);
		const targetJournalFileId = journalFileId;
		saveTimer = setTimeout(() => {
			saveTimer = null;
			void startSave(content, targetJournalFileId);
		}, SAVE_DEBOUNCE_MS);
	}

	// Realtime: the database migrations add journal_drafts to the
	// supabase_realtime publication, so any authorized save — including this
	// tab's own, once it
	// round-trips — arrives here as a Postgres Changes UPDATE. Own writes are
	// recognised by matching `lastSavedContent` and skipped; anything else is a
	// collaborator's edit and replaces the textarea outright. There's no merge —
	// two people typing into the same day at the same moment will have one
	// overwrite the other, the same tradeoff any single shared text field has
	// without an operational-transform engine behind it.
	let client: SupabaseClient | null = null;
	let channel: RealtimeChannel | null = null;
	let subscribedJournalFileId: string | null | undefined;
	let tokenTimer: ReturnType<typeof setInterval> | null = null;

	function subscribeToJournal(targetJournalFileId: string | null) {
		if (!client || subscribedJournalFileId === targetJournalFileId) return;
		if (channel) void client.removeChannel(channel);
		subscribedJournalFileId = targetJournalFileId;
		channel = client
			.channel(`journal-drafts-${projectId}-${targetJournalFileId ?? 'legacy'}`)
			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'journal_drafts', filter: journalRealtimeFilter(projectId, targetJournalFileId) },
				(payload) => {
					const row = payload.new as unknown as JournalRealtimeRow;
					if (!row?.draft_date || typeof row.content !== 'string') return;
					if (targetJournalFileId !== journalFileId || !isRealtimeRowForJournal(row, targetJournalFileId)) return;
					draftDate = row.draft_date;
					if (recentOwnWrites.has(ownWriteKey(targetJournalFileId, row.content))) {
						if (content === row.content) lastSavedContent = row.content;
						return;
					}
					if (row.content !== lastSavedContent) {
						content = row.content;
						lastSavedContent = row.content;
					}
				},
			)
			.subscribe();
	}

	$effect(() => {
		// A parent changing tabs first awaits flushPendingSave(), then changes this
		// prop; the effect replaces the channel with the new journal-specific one.
		subscribeToJournal(journalFileId);
	});

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
		disposed = false;

		(async () => {
			try {
				client = createBrowserSupabaseClient();
				await refreshRealtimeAuth();
				if (cancelled || !client) return;

				subscribeToJournal(journalFileId);

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
			// Fetch keepalive is the best-effort path available during navigation;
			// callers switching tabs should await flushPendingSave before changing IDs.
			if (content !== lastSavedContent) void flushPendingSave(true);
			disposed = true;
			if (tokenTimer) clearInterval(tokenTimer);
			if (channel && client) void client.removeChannel(channel);
			channel = null;
			subscribedJournalFileId = undefined;
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

	<JournalHistory entries={entries} />
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

</style>
