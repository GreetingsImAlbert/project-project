<script lang="ts">
	import { onMount } from 'svelte';
	import { currencyState, formatCurrency, initCurrency, type CurrencyCode } from '../lib/currency.svelte';

	// Mirrors TRASH_GRACE_DAYS in src/lib/trash.ts — kept as a plain number here
	// rather than imported, since that module also pulls in aws4fetch, which has no
	// business in a client bundle (same reasoning as FileList's FILE_GRACE_DAYS).
	const TRASH_GRACE_DAYS = 10;
	const TRASH_PAGE_SIZE = 50;
	type TrashKind = 'files' | 'folders' | 'tasks' | 'bomItems' | 'transactions';

	interface FileRow {
		id: string;
		filename: string;
		size_bytes: number | null;
		deleted_at: string;
		canRestore: boolean;
		canPurge: boolean;
	}

	interface FolderRow {
		id: string;
		name: string;
		deleted_at: string;
		isJournalsFolder: boolean;
		canRestore: boolean;
		canPurge: boolean;
	}

	interface TaskRow {
		id: string;
		name: string;
		category: string | null;
		deleted_at: string;
	}

	interface BomItemRow {
		id: string;
		part_name: string;
		category: string | null;
		total_cost: number | null;
		deleted_at: string;
	}

	interface TransactionRow {
		id: string;
		type: string;
		item_name: string | null;
		transaction_date: string;
		total_cost: number | null;
		deleted_at: string;
	}

	let {
		projectId,
		currency,
		canEditMoney,
	}: {
		projectId: string;
		currency: CurrencyCode;
		canEditMoney: boolean;
	} = $props();

	initCurrency(currency);

	let files = $state<FileRow[]>([]);
	let folders = $state<FolderRow[]>([]);
	let tasks = $state<TaskRow[]>([]);
	let bomItems = $state<BomItemRow[]>([]);
	let transactions = $state<TransactionRow[]>([]);
	let visibleCounts = $state<Record<TrashKind, number>>({
		files: TRASH_PAGE_SIZE,
		folders: TRASH_PAGE_SIZE,
		tasks: TRASH_PAGE_SIZE,
		bomItems: TRASH_PAGE_SIZE,
		transactions: TRASH_PAGE_SIZE,
	});
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	onMount(() => {
		async function loadTrash() {
			try {
				const response = await fetch(`/api/projects/${projectId}/trash`);
				if (!response.ok) throw new Error(await response.text());
				const result = (await response.json()) as {
					files: FileRow[];
					folders: FolderRow[];
					tasks: TaskRow[];
					bomItems: BomItemRow[];
					transactions: TransactionRow[];
				};
				files = result.files;
				folders = result.folders;
				tasks = result.tasks;
				bomItems = result.bomItems;
				transactions = result.transactions;
			} catch (error) {
				loadError = error instanceof Error ? error.message : 'Could not load trash';
			} finally {
				loading = false;
			}
		}

		void loadTrash();
	});

	let busyId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

	let visibleFiles = $derived(files.slice(0, visibleCounts.files));
	let visibleFolders = $derived(folders.slice(0, visibleCounts.folders));
	let visibleTasks = $derived(tasks.slice(0, visibleCounts.tasks));
	let visibleBomItems = $derived(bomItems.slice(0, visibleCounts.bomItems));
	let visibleTransactions = $derived(transactions.slice(0, visibleCounts.transactions));

	function showMore(kind: TrashKind, total: number) {
		visibleCounts[kind] = Math.min(visibleCounts[kind] + TRASH_PAGE_SIZE, total);
	}

	function daysLeft(deletedAt: string): number {
		const elapsed = (Date.now() - new Date(deletedAt).getTime()) / (24 * 60 * 60 * 1000);
		return Math.max(0, Math.ceil(TRASH_GRACE_DAYS - elapsed));
	}

	function restoreUrl(kind: 'file' | 'folder' | 'task' | 'bom_item' | 'transaction', id: string): string {
		switch (kind) {
			case 'file':
				return `/api/files/${id}/restore`;
			case 'folder':
				return `/api/projects/${projectId}/folders/${id}/restore`;
			case 'task':
				return `/api/tasks/${id}/restore`;
			case 'bom_item':
				return `/api/bom/${id}/restore`;
			case 'transaction':
				return `/api/transactions/${id}/restore`;
		}
	}

	function purgeUrl(kind: 'file' | 'folder' | 'task' | 'bom_item' | 'transaction', id: string): string {
		switch (kind) {
			case 'file':
				return `/api/files/${id}/purge`;
			case 'folder':
				return `/api/projects/${projectId}/folders/${id}/purge`;
			case 'task':
				return `/api/tasks/${id}/purge`;
			case 'bom_item':
				return `/api/bom/${id}/purge`;
			case 'transaction':
				return `/api/transactions/${id}/purge`;
		}
	}

	function removeFromList(kind: 'file' | 'folder' | 'task' | 'bom_item' | 'transaction', id: string) {
		if (kind === 'file') files = files.filter((f) => f.id !== id);
		else if (kind === 'folder') folders = folders.filter((f) => f.id !== id);
		else if (kind === 'task') tasks = tasks.filter((t) => t.id !== id);
		else if (kind === 'bom_item') bomItems = bomItems.filter((b) => b.id !== id);
		else transactions = transactions.filter((t) => t.id !== id);
	}

	async function restore(kind: 'file' | 'folder' | 'task' | 'bom_item' | 'transaction', id: string) {
		rowError = null;
		busyId = id;

		const res = await fetch(restoreUrl(kind, id), { method: 'POST' });

		if (!res.ok) {
			rowError = { id, message: await res.text() };
			busyId = null;
			return;
		}

		removeFromList(kind, id);
		busyId = null;
	}

	async function purgeForever(kind: 'file' | 'folder' | 'task' | 'bom_item' | 'transaction', id: string, label: string) {
		if (!confirm(`Permanently delete "${label}"? This cannot be undone.`)) return;

		rowError = null;
		busyId = id;

		const res = await fetch(purgeUrl(kind, id), { method: 'POST' });

		if (!res.ok) {
			rowError = { id, message: await res.text() };
			busyId = null;
			return;
		}

		removeFromList(kind, id);
		busyId = null;
	}

	const empty = $derived(
		files.length === 0 && folders.length === 0 && tasks.length === 0 && bomItems.length === 0 && transactions.length === 0,
	);
</script>

{#snippet actions(kind: 'file' | 'folder' | 'task' | 'bom_item' | 'transaction', id: string, label: string, canRestore: boolean, canPurge = canRestore)}
	{#if canRestore || canPurge}
		<div class="row-actions">
			{#if canRestore}<button type="button" class="btn-plain" onclick={() => restore(kind, id)} disabled={busyId === id}>{busyId === id ? '…' : 'Restore'}</button>{/if}
			{#if canPurge}<button type="button" class="btn-danger" onclick={() => purgeForever(kind, id, label)} disabled={busyId === id}>Delete forever</button>{/if}
		</div>
	{/if}
	{#if rowError?.id === id}
		<p class="row-error">{rowError.message}</p>
	{/if}
{/snippet}

{#if loading}
	<p class="muted">Loading trash…</p>
{:else if loadError}
	<p class="row-error">{loadError}</p>
{:else if empty}
	<p class="muted">Nothing in the trash.</p>
{/if}

{#if files.length > 0}
	<section class="trash-section">
		<h3>Files</h3>
		<ul class="trash-list">
			{#each visibleFiles as file (file.id)}
				{@const remaining = daysLeft(file.deleted_at)}
				<li class="trash-row">
					<span class="row-label">{file.filename}</span>
					<span class="row-meta muted">
						{file.size_bytes != null ? `${Math.round(file.size_bytes).toLocaleString()} B — ` : ''}
						{remaining} day{remaining === 1 ? '' : 's'} left
					</span>
					{@render actions('file', file.id, file.filename, file.canRestore, file.canPurge)}
				</li>
			{/each}
			</ul>
			{#if files.length > visibleFiles.length}
				<div class="window-more">
					<button type="button" class="btn-plain" onclick={() => showMore('files', files.length)}>
						Show more files ({files.length - visibleFiles.length} remaining)
					</button>
				</div>
			{/if}
	</section>
{/if}

{#if folders.length > 0}
	<section class="trash-section">
		<h3>Folders</h3>
		<ul class="trash-list">
			{#each visibleFolders as folder (folder.id)}
				{@const remaining = daysLeft(folder.deleted_at)}
				<li class="trash-row">
					<span class="row-label">{folder.name}</span>
					<span class="row-meta muted">{remaining} day{remaining === 1 ? '' : 's'} left</span>
					{@render actions('folder', folder.id, folder.name, folder.canRestore, folder.canPurge)}
				</li>
			{/each}
			</ul>
			{#if folders.length > visibleFolders.length}
				<div class="window-more">
					<button type="button" class="btn-plain" onclick={() => showMore('folders', folders.length)}>
						Show more folders ({folders.length - visibleFolders.length} remaining)
					</button>
				</div>
			{/if}
	</section>
{/if}

{#if tasks.length > 0}
	<section class="trash-section">
		<h3>Tasks</h3>
		<ul class="trash-list">
			{#each visibleTasks as task (task.id)}
				{@const remaining = daysLeft(task.deleted_at)}
				<li class="trash-row">
					<span class="row-label">{task.name}</span>
					<span class="row-meta muted">
						{task.category ? `${task.category} — ` : ''}
						{remaining} day{remaining === 1 ? '' : 's'} left
					</span>
					{@render actions('task', task.id, task.name, true)}
				</li>
			{/each}
			</ul>
			{#if tasks.length > visibleTasks.length}
				<div class="window-more">
					<button type="button" class="btn-plain" onclick={() => showMore('tasks', tasks.length)}>
						Show more tasks ({tasks.length - visibleTasks.length} remaining)
					</button>
				</div>
			{/if}
	</section>
{/if}

{#if bomItems.length > 0}
	<section class="trash-section">
		<h3>BOM items</h3>
		<ul class="trash-list">
			{#each visibleBomItems as item (item.id)}
				{@const remaining = daysLeft(item.deleted_at)}
				<li class="trash-row">
					<span class="row-label">{item.part_name}</span>
					<span class="row-meta muted">
						{item.total_cost != null ? `${formatCurrency(item.total_cost)} — ` : ''}
						{remaining} day{remaining === 1 ? '' : 's'} left
					</span>
					{@render actions('bom_item', item.id, item.part_name, canEditMoney)}
				</li>
			{/each}
			</ul>
			{#if bomItems.length > visibleBomItems.length}
				<div class="window-more">
					<button type="button" class="btn-plain" onclick={() => showMore('bomItems', bomItems.length)}>
						Show more BOM items ({bomItems.length - visibleBomItems.length} remaining)
					</button>
				</div>
			{/if}
	</section>
{/if}

{#if transactions.length > 0}
	<section class="trash-section">
		<h3>Transactions</h3>
		<ul class="trash-list">
			{#each visibleTransactions as transaction (transaction.id)}
				{@const label = transaction.item_name ?? transaction.type}
				{@const remaining = daysLeft(transaction.deleted_at)}
				<li class="trash-row">
					<span class="row-label">{label}</span>
					<span class="row-meta muted">
						{transaction.total_cost != null ? `${formatCurrency(transaction.total_cost)} — ` : ''}
						{transaction.transaction_date} —
						{remaining} day{remaining === 1 ? '' : 's'} left
					</span>
					{@render actions('transaction', transaction.id, label, canEditMoney)}
				</li>
			{/each}
			</ul>
			{#if transactions.length > visibleTransactions.length}
				<div class="window-more">
					<button type="button" class="btn-plain" onclick={() => showMore('transactions', transactions.length)}>
						Show more transactions ({transactions.length - visibleTransactions.length} remaining)
					</button>
				</div>
			{/if}
	</section>
{/if}

<style>
	.trash-section + .trash-section {
		margin-top: var(--space-5);
	}

	.trash-section h3 {
		margin: 0 0 var(--space-2);
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--color-border);
		color: var(--color-muted);
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.trash-list {
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: 0.82rem;
	}

	.window-more {
		display: flex;
		justify-content: center;
		padding: var(--space-3) 0 0;
	}

	.window-more button {
		font-size: 0.78rem;
	}

	.trash-list > .trash-row {
		border-top: 1px solid var(--color-border);
	}

	.trash-list > .trash-row:first-child {
		border-top: none;
	}

	.trash-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
		align-items: baseline;
		gap: var(--space-3);
		padding: var(--space-1) var(--space-2);
	}

	.row-label {
		font-weight: 600;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.row-meta {
		font-size: 0.78rem;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.row-actions {
		display: flex;
		gap: var(--space-1);
		flex-shrink: 0;
		justify-content: flex-end;
	}

	.row-actions button {
		flex-shrink: 0;
		white-space: nowrap;
		padding: 0 var(--space-2);
		font-size: 0.7rem;
		line-height: 1.8;
	}

	.row-error {
		grid-column: 1 / -1;
		color: var(--color-danger);
		margin: 0;
	}

	@media (max-width: 640px) {
		.trash-row {
			grid-template-columns: minmax(0, 1fr);
			row-gap: 2px;
		}

		.row-actions {
			grid-column: 1 / -1;
		}
	}
</style>
