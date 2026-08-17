<script lang="ts">
	import { onMount, tick } from 'svelte';
	import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
	import JournalHistory from './JournalHistory.svelte';
	import type { ProjectJournal, JournalVisibility } from '../lib/journal';
	import type { JournalEntry } from '../lib/journal-entries';
	import { createBrowserSupabaseClient } from '../lib/supabase/browser';
	import { toastError } from '../lib/toast.svelte';
	import { onSwapOrDestroy } from '../lib/island-teardown';
	import { isRealtimeRowForJournal, journalDraftEndpoint, journalRealtimeFilter, type JournalRealtimeRow } from '../lib/journal-client-sync';

	interface JournalState extends Omit<ProjectJournal, 'draft' | 'history'> {
		draftDate: string;
		content: string;
		entries: JournalEntry[];
		lastSavedContent: string;
		saveState: 'idle' | 'saving' | 'saved';
	}

	interface PrivateJournalManagementRow { fileId: string; filename: string; creatorName: string; }

	let {
		projectId, currentUserId, initialJournals, initialActiveJournalId,
		canCreatePersonalJournal: initialCanCreatePersonalJournal, initialPrivateJournalManagement,
	}: {
		projectId: string;
		currentUserId: string;
		initialJournals: ProjectJournal[];
		initialActiveJournalId: string;
		canCreatePersonalJournal: boolean;
		initialPrivateJournalManagement: PrivateJournalManagementRow[];
	} = $props();

	const SAVE_DEBOUNCE_MS = 500;
	const TOKEN_REFRESH_MS = 45 * 60 * 1000;
	function buildInitialState() {
		return {
			journals: Object.fromEntries(initialJournals.map((journal) => [journal.fileId, {
				...journal,
				draftDate: journal.draft?.draft_date ?? '',
				content: journal.draft?.content ?? '',
				entries: journal.history,
				lastSavedContent: journal.draft?.content ?? '',
				saveState: 'idle' as const,
			}])),
			orderedIds: initialJournals.map((journal) => journal.fileId),
			activeJournalId: initialActiveJournalId,
			canCreatePersonalJournal: initialCanCreatePersonalJournal,
			privateManagement: initialPrivateJournalManagement,
		};
	}
	const initialState = buildInitialState();
	const states = $state<Record<string, JournalState>>(initialState.journals);
	let orderedIds = $state(initialState.orderedIds);
	let activeJournalId = $state(initialState.activeJournalId);
	let canCreatePersonalJournal = $state(initialState.canCreatePersonalJournal);
	let privateManagement = $state(initialState.privateManagement);
	let creating = $state(false);
	let deletingId = $state<string | null>(null);
	let visibilityBusy = $state(false);
	let actionError = $state('');
	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let tabButtons = $state<Record<string, HTMLButtonElement>>({});
	const active = $derived(states[activeJournalId]);

	const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const pendingSaves = new Map<string, Promise<void>>();
	const saveSequences = new Map<string, number>();
	const recentOwnWrites = new Map<string, number>();
	let disposed = false;

	function ownWriteKey(journalFileId: string, value: string): string { return `${journalFileId}\u0000${value}`; }
	function rememberOwnWrite(journalFileId: string, value: string) {
		const now = Date.now();
		for (const [key, expiresAt] of recentOwnWrites) if (expiresAt <= now) recentOwnWrites.delete(key);
		recentOwnWrites.set(ownWriteKey(journalFileId, value), now + 30_000);
	}

	async function saveDraft(journalFileId: string, value: string, keepalive = false): Promise<void> {
		const state = states[journalFileId];
		if (!state?.canEdit) return;
		const sequence = (saveSequences.get(journalFileId) ?? 0) + 1;
		saveSequences.set(journalFileId, sequence);
		rememberOwnWrite(journalFileId, value);
		state.saveState = 'saving';
		try {
			const response = await fetch(journalDraftEndpoint(projectId, journalFileId), {
				method: 'PUT', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: value }), keepalive,
			});
			if (disposed || saveSequences.get(journalFileId) !== sequence || !states[journalFileId]) return;
			if (!response.ok) { toastError(await response.text()); state.saveState = 'idle'; return; }
			const data = await response.json() as { draft_date: string };
			state.draftDate = data.draft_date;
			state.lastSavedContent = value;
			state.saveState = 'saved';
		} catch {
			if (disposed || saveSequences.get(journalFileId) !== sequence || !states[journalFileId]) return;
			toastError('Could not save — check your connection');
			state.saveState = 'idle';
		}
	}

	function startSave(journalFileId: string, value: string, keepalive = false): Promise<void> {
		const save = saveDraft(journalFileId, value, keepalive);
		pendingSaves.set(journalFileId, save);
		void save.finally(() => { if (pendingSaves.get(journalFileId) === save) pendingSaves.delete(journalFileId); });
		return save;
	}

	export async function flushPendingSave(journalFileId = activeJournalId, keepalive = false): Promise<void> {
		const timer = saveTimers.get(journalFileId);
		if (timer) { clearTimeout(timer); saveTimers.delete(journalFileId); }
		const state = states[journalFileId];
		if (!state?.canEdit) return;
		const inFlight = pendingSaves.get(journalFileId);
		if (state.content !== state.lastSavedContent) await startSave(journalFileId, state.content, keepalive);
		else if (inFlight) await inFlight;
	}

	function onInput(event: Event) {
		if (!active?.canEdit) return;
		active.content = (event.currentTarget as HTMLTextAreaElement).value;
		active.saveState = 'idle';
		const existing = saveTimers.get(active.fileId);
		if (existing) clearTimeout(existing);
		const journalFileId = active.fileId;
		saveTimers.set(journalFileId, setTimeout(() => {
			saveTimers.delete(journalFileId);
			const state = states[journalFileId];
			if (state) void startSave(journalFileId, state.content);
		}, SAVE_DEBOUNCE_MS));
	}

	function updateUrl(journalFileId: string) {
		const url = new URL(window.location.href);
		url.searchParams.set('journal', journalFileId);
		window.history.replaceState(window.history.state, '', url);
	}

	async function selectJournal(journalFileId: string, focusTab = false) {
		if (journalFileId === activeJournalId || !states[journalFileId]) return;
		await flushPendingSave(activeJournalId);
		activeJournalId = journalFileId;
		updateUrl(journalFileId);
		await tick();
		if (focusTab) tabButtons[journalFileId]?.focus();
		else if (states[journalFileId]?.canEdit) textareaEl?.focus();
	}

	function onTabKeydown(event: KeyboardEvent, index: number) {
		let next = index;
		if (event.key === 'ArrowRight') next = (index + 1) % orderedIds.length;
		else if (event.key === 'ArrowLeft') next = (index - 1 + orderedIds.length) % orderedIds.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = orderedIds.length - 1;
		else return;
		event.preventDefault();
		void selectJournal(orderedIds[next], true);
	}

	async function createMyJournal(restore = false) {
		creating = true;
		actionError = '';
		try {
			const response = await fetch(`/api/projects/${projectId}/journals`, {
				method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ restore }),
			});
			const data = await response.json().catch(() => null) as { restoreRequired?: boolean; journal?: { fileId: string; filename?: string }; error?: string } | null;
			if (response.status === 409 && data?.restoreRequired) {
				if (confirm(`Restore your deleted journal${data.journal?.filename ? ` (${data.journal.filename})` : ''}?`)) await createMyJournal(true);
				return;
			}
			if (!response.ok || !data?.journal?.fileId) { actionError = data?.error ?? 'Could not create journal'; return; }
			window.location.href = `/projects/${projectId}/journal?journal=${data.journal.fileId}`;
		} catch { actionError = 'Could not create journal — check your connection'; }
		finally { creating = false; }
	}

	async function changeVisibility(event: Event) {
		if (!active?.canChangeVisibility) return;
		const state = active;
		const previous = state.visibility;
		const visibility = (event.currentTarget as HTMLSelectElement).value as JournalVisibility;
		state.visibility = visibility;
		visibilityBusy = true;
		actionError = '';
		try {
			const response = await fetch(`/api/projects/${projectId}/journals/${state.fileId}/visibility`, {
				method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visibility }),
			});
			if (!response.ok) { state.visibility = previous; actionError = await response.text(); }
		} catch { state.visibility = previous; actionError = 'Could not update visibility'; }
		finally { visibilityBusy = false; }
	}

	async function deleteJournal(journalFileId: string, label: string) {
		if (!confirm(`Delete ${label}? Its finalized history will move to Trash.`)) return;
		deletingId = journalFileId;
		actionError = '';
		const timer = saveTimers.get(journalFileId);
		if (timer) clearTimeout(timer);
		saveTimers.delete(journalFileId);
		saveSequences.set(journalFileId, (saveSequences.get(journalFileId) ?? 0) + 1);
		try {
			const response = await fetch(`/api/projects/${projectId}/journals/${journalFileId}/delete`, { method: 'POST' });
			if (!response.ok) { actionError = await response.text(); return; }
			privateManagement = privateManagement.filter((row) => row.fileId !== journalFileId);
			if (states[journalFileId]) {
				const deletedOwnJournal = states[journalFileId].creatorId === currentUserId;
				delete states[journalFileId];
				orderedIds = orderedIds.filter((id) => id !== journalFileId);
				if (deletedOwnJournal) canCreatePersonalJournal = true;
				if (activeJournalId === journalFileId && orderedIds[0]) { activeJournalId = orderedIds[0]; updateUrl(activeJournalId); }
			}
		} catch { actionError = 'Could not delete journal'; }
		finally { deletingId = null; }
	}

	let client: SupabaseClient | null = null;
	let channel: RealtimeChannel | null = null;
	let subscribedJournalFileId: string | null = null;
	let tokenTimer: ReturnType<typeof setInterval> | null = null;

	function subscribeToJournal(journalFileId: string) {
		if (!client || subscribedJournalFileId === journalFileId) return;
		if (channel) void client.removeChannel(channel);
		subscribedJournalFileId = journalFileId;
		channel = client.channel(`journal-drafts-${projectId}-${journalFileId}`)
			.on('postgres_changes', { event: '*', schema: 'public', table: 'journal_drafts', filter: journalRealtimeFilter(projectId, journalFileId) }, (payload) => {
				const row = payload.new as unknown as JournalRealtimeRow;
				const state = states[journalFileId];
				if (!state || activeJournalId !== journalFileId || !row?.draft_date || typeof row.content !== 'string') return;
				if (!isRealtimeRowForJournal(row, journalFileId)) return;
				if (row.draft_date !== state.draftDate) {
					if (state.content.trim() && state.draftDate) state.entries = [{ date: state.draftDate, body: state.content.trim() }, ...state.entries.filter((entry) => entry.date !== state.draftDate)];
					state.draftDate = row.draft_date;
				}
				if (recentOwnWrites.has(ownWriteKey(journalFileId, row.content))) { if (state.content === row.content) state.lastSavedContent = row.content; return; }
				state.content = row.content;
				state.lastSavedContent = row.content;
			}).subscribe();
	}

	$effect(() => subscribeToJournal(activeJournalId));

	async function refreshRealtimeAuth() {
		if (!client) return;
		try {
			const response = await fetch(`/api/projects/${projectId}/journal/realtime-token`);
			if (!response.ok) return;
			const { accessToken } = await response.json() as { accessToken: string };
			client.realtime.setAuth(accessToken);
		} catch { /* keep the last token */ }
	}

	onMount(() => {
		let cancelled = false;
		disposed = false;
		void (async () => {
			try {
				client = createBrowserSupabaseClient();
				await refreshRealtimeAuth();
				if (cancelled) return;
				subscribeToJournal(activeJournalId);
				tokenTimer = setInterval(refreshRealtimeAuth, TOKEN_REFRESH_MS);
			} catch { console.error('[journal] realtime sync unavailable; autosave still works'); }
		})();
		return onSwapOrDestroy(() => {
			cancelled = true;
			for (const timer of saveTimers.values()) clearTimeout(timer);
			saveTimers.clear();
			for (const state of Object.values(states)) if (state.canEdit && state.content !== state.lastSavedContent) void startSave(state.fileId, state.content, true);
			disposed = true;
			if (tokenTimer) clearInterval(tokenTimer);
			if (channel && client) void client.removeChannel(channel);
			channel = null;
			subscribedJournalFileId = null;
		});
	});
</script>

<div class="journal-workspace">
	<div class="journal-toolbar">
		<div class="tabs-scroll">
			<div class="journal-tabs" role="tablist" aria-label="Project journals">
				{#each orderedIds as journalId, index (journalId)}
					{@const journal = states[journalId]}
					<button bind:this={tabButtons[journalId]} type="button" role="tab" id={`journal-tab-${journalId}`}
						aria-selected={activeJournalId === journalId} aria-controls={`journal-panel-${journalId}`}
						tabindex={activeJournalId === journalId ? 0 : -1} class:active={activeJournalId === journalId}
						onclick={() => void selectJournal(journalId, true)} onkeydown={(event) => onTabKeydown(event, index)}>
						<span>{journal.kind === 'group' ? 'Group' : journal.creatorName ?? journal.filename}</span>
						<small>{journal.filename}</small>
					</button>
				{/each}
			</div>
		</div>
		{#if canCreatePersonalJournal}<button type="button" class="create-journal" onclick={() => void createMyJournal()} disabled={creating}>{creating ? 'Creating…' : 'Create my journal'}</button>{/if}
	</div>

	{#if actionError}<p class="row-error" role="alert">{actionError}</p>{/if}
	{#if active}
		<div class="journal-panel" role="tabpanel" id={`journal-panel-${active.fileId}`} aria-labelledby={`journal-tab-${active.fileId}`} tabindex="0">
			<header class="panel-head">
				<div><h2>{active.kind === 'group' ? 'Group journal' : active.creatorName ?? 'Personal journal'}</h2><p class="muted">{active.filename}</p></div>
				<div class="journal-actions">
					{#if active.canChangeVisibility}
						<label><span>Visibility</span><select value={active.visibility ?? 'private'} onchange={changeVisibility} disabled={visibilityBusy}>
							<option value="private">Private</option><option value="members">Project Members</option><option value="public">Public</option>
						</select></label>
					{/if}
					{#if active.canDelete}<button type="button" class="danger" onclick={() => void deleteJournal(active.fileId, active.filename)} disabled={deletingId === active.fileId}>Delete</button>{/if}
				</div>
			</header>
			{#if active.visibility === 'public' && active.canChangeVisibility}<p class="visibility-note muted">Public access also requires Project Settings → Journal visibility to be enabled.</p>{/if}

			<section class="today">
				<div class="today-head"><h3>{active.draftDate || 'Today'}</h3><span class="save-state muted" aria-live="polite">{#if active.saveState === 'saving'}Saving…{:else if active.saveState === 'saved'}Saved{/if}</span></div>
				{#if active.canEdit}
					<textarea bind:this={textareaEl} value={active.content} oninput={onInput} placeholder="What did you work on today?" aria-label={`Journal entry for ${active.draftDate || 'today'}`}></textarea>
					<p class="hint muted">Saved automatically. Simultaneous editing uses last writer wins; entries are not merged.</p>
				{:else}
					<div class="read-only-draft" aria-label={`Read-only journal entry for ${active.draftDate || 'today'}`}>{active.content || 'Nothing has been written today.'}</div>
					<p class="hint muted">
						{active.kind === 'personal'
							? `Only ${active.creatorName ?? 'the creator'} can edit this personal journal.`
							: 'Only project owners and editors can edit the group journal.'}
					</p>
				{/if}
			</section>
			<JournalHistory entries={active.entries} />
		</div>
	{/if}
	{#each orderedIds.filter((journalId) => journalId !== activeJournalId) as journalId (journalId)}
		<div role="tabpanel" id={`journal-panel-${journalId}`} aria-labelledby={`journal-tab-${journalId}`} hidden></div>
	{/each}

	{#if privateManagement.length > 0}
		<section class="private-management" aria-labelledby="private-journal-management-title">
			<h3 id="private-journal-management-title">Private journal management</h3>
			<p class="muted">You can delete these journals as project owner, but their contents remain private.</p>
			<ul>{#each privateManagement as row (row.fileId)}<li><span><strong>{row.creatorName}</strong><small class="muted">{row.filename}</small></span><button type="button" class="danger" onclick={() => void deleteJournal(row.fileId, `${row.creatorName}'s private journal`)} disabled={deletingId === row.fileId}>Delete</button></li>{/each}</ul>
		</section>
	{/if}
</div>

<style>
	.journal-workspace { display: flex; flex-direction: column; gap: var(--space-5); }
	.journal-toolbar { display: flex; align-items: flex-end; gap: var(--space-3); border-bottom: 1px solid var(--color-border); }
	.tabs-scroll { flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: thin; }
	.journal-tabs { display: flex; align-items: stretch; width: max-content; min-width: 100%; gap: var(--space-1); }
	.journal-tabs button { display: flex; flex-direction: column; align-items: flex-start; min-width: 130px; max-width: 220px; padding: var(--space-2) var(--space-3); border: 0; border-bottom: 2px solid transparent; border-radius: var(--radius-sm) var(--radius-sm) 0 0; background: transparent; color: var(--color-muted); text-align: left; }
	.journal-tabs button:hover { background: var(--color-highlight); color: var(--color-fg); }
	.journal-tabs button.active { border-bottom-color: var(--color-border-strong); color: var(--color-fg); background: var(--color-highlight); }
	.journal-tabs span, .journal-tabs small { overflow: hidden; width: 100%; text-overflow: ellipsis; white-space: nowrap; }
	.journal-tabs span { font-weight: 600; } .journal-tabs small { opacity: 0.7; }
	.create-journal { flex: 0 0 auto; margin-bottom: var(--space-2); }
	.journal-panel { display: flex; flex-direction: column; gap: var(--space-6); outline: none; }
	.panel-head, .today-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
	.panel-head h2, .panel-head p, .today-head h3 { margin: 0; }
	.journal-actions { display: flex; align-items: end; gap: var(--space-2); flex-wrap: wrap; justify-content: flex-end; }
	.journal-actions label { display: flex; flex-direction: column; gap: var(--space-1); font-size: 0.8rem; }
	.visibility-note { margin: calc(-1 * var(--space-4)) 0 0; font-size: 0.8rem; }
	.save-state { min-width: 4rem; text-align: right; font-size: 0.8rem; }
	textarea { width: 100%; min-height: 220px; box-sizing: border-box; resize: vertical; padding: var(--space-3); font-family: inherit; font-size: 0.9rem; line-height: 1.6; }
	.read-only-draft { min-height: 120px; padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); white-space: pre-wrap; line-height: 1.6; background: var(--color-highlight); }
	.hint { margin: var(--space-2) 0 0; font-size: 0.8rem; }
	.danger { color: var(--color-danger); }
	.private-management { padding-top: var(--space-4); border-top: 1px solid var(--color-border); }
	.private-management h3, .private-management p { margin-top: 0; }
	.private-management ul { display: flex; flex-direction: column; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
	.private-management li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; }
	.private-management li span { display: flex; flex-direction: column; min-width: 0; }
	.private-management small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	@media (max-width: 640px) { .journal-toolbar, .panel-head { align-items: stretch; flex-direction: column; } .journal-toolbar { padding-bottom: var(--space-2); } .create-journal { align-self: flex-start; margin: 0; } .journal-actions { justify-content: flex-start; } .private-management li { align-items: flex-start; } }
</style>
