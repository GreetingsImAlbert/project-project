<script lang="ts">
	import { onMount } from 'svelte';
	import { formatCurrency, initCurrency } from '../lib/currency.svelte';
	import {
		transactionsState,
		initTransactions,
		addTransaction,
		updateTransaction,
		removeTransaction,
		type Transaction,
		type TransactionType,
	} from '../lib/transactions-store.svelte';

	interface Member {
		id: string;
		displayName: string;
	}

	let {
		projectId,
		initialTransactions,
		members,
		canEdit,
	}: {
		projectId: string;
		initialTransactions: Transaction[];
		members: Member[];
		canEdit: boolean;
	} = $props();

	initTransactions(initialTransactions);

	let editingId = $state<string | null>(null);
	let savingId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

	let adding = $state(false);
	let addError = $state<string | null>(null);
	let addType = $state<TransactionType>('item');

	let expandedId = $state<string | null>(null);
	let editingType = $state<TransactionType>('item');

	const TYPE_LABELS: Record<TransactionType, string> = {
		item: 'Item',
		shipping: 'Shipping',
		discount: 'Discount',
		refund: 'Refund',
	};

	function unitCostPlaceholder(type: TransactionType): string {
		return type === 'item' ? 'Unit cost' : 'Amount';
	}

	function memberName(id: string, profile: { display_name: string } | null): string {
		return profile?.display_name ?? members.find((m) => m.id === id)?.displayName ?? 'Unknown';
	}

	let groups = $derived.by(() => {
		const map = new Map<string, Transaction[]>();
		for (const t of transactionsState.items) {
			if (!map.has(t.transaction_date)) map.set(t.transaction_date, []);
			map.get(t.transaction_date)!.push(t);
		}
		const keys = [...map.keys()].sort((a, b) => b.localeCompare(a));
		return keys.map((date) => ({ date, items: map.get(date)! }));
	});

	function signedAmount(t: Transaction): number {
		const total = t.total_cost ?? 0;
		return t.type === 'discount' || t.type === 'refund' ? -total : total;
	}

	let netTotal = $derived(transactionsState.items.reduce((sum, t) => sum + signedAmount(t), 0));

	onMount(() => {
		initCurrency();
	});

	function handleRowClick(e: MouseEvent, id: string) {
		if ((e.target as HTMLElement).closest('.row-actions, a')) return;
		expandedId = expandedId === id ? null : id;
	}

	function startEdit(t: Transaction) {
		editingId = t.id;
		editingType = t.type;
		rowError = null;
	}

	function cancelEdit() {
		editingId = null;
		rowError = null;
	}

	async function handleSave(id: string) {
		rowError = null;
		savingId = id;

		const form = document.getElementById(`transaction-update-${id}`) as HTMLFormElement;
		const res = await fetch(form.action, { method: 'POST', body: new FormData(form) });

		if (!res.ok) {
			rowError = { id, message: await res.text() };
			savingId = null;
			return;
		}

		const updated: Transaction = await res.json();
		updateTransaction(updated);
		editingId = null;
		savingId = null;
	}

	async function handleDelete(id: string) {
		if (!confirm('Delete this transaction?')) return;

		rowError = null;
		deletingId = id;

		const res = await fetch(`/api/transactions/${id}/delete`, { method: 'POST' });

		if (!res.ok) {
			rowError = { id, message: await res.text() };
			deletingId = null;
			return;
		}

		removeTransaction(id);
		deletingId = null;
	}

	async function handleAddSubmit(e: SubmitEvent) {
		e.preventDefault();
		const form = e.currentTarget as HTMLFormElement;

		adding = true;
		addError = null;

		const res = await fetch(form.action, { method: 'POST', body: new FormData(form) });

		if (!res.ok) {
			addError = await res.text();
			adding = false;
			return;
		}

		const created: Transaction = await res.json();
		addTransaction(created);
		form.reset();
		addType = 'item';
		adding = false;
	}
</script>

<h2>Transactions</h2>

{#if transactionsState.items.length === 0}
	<p class="muted">No transactions yet.</p>
{:else}
	<div class="table-scroll">
	<table>
		{#if canEdit}
			<colgroup>
				<col style="width:110px" />
				<col style="width:100px" />
				<col style="width:160px" />
				<col style="width:70px" />
				<col style="width:80px" />
				<col style="width:100px" />
				<col style="width:110px" />
				<col style="width:150px" />
				<col style="width:150px" />
			</colgroup>
		{:else}
			<colgroup>
				<col style="width:110px" />
				<col style="width:100px" />
				<col style="width:160px" />
				<col style="width:70px" />
				<col style="width:80px" />
				<col style="width:100px" />
				<col style="width:110px" />
				<col style="width:150px" />
			</colgroup>
		{/if}
		<thead>
			<tr>
				<th>Date</th>
				<th>Type</th>
				<th>Item</th>
				<th>Qty</th>
				<th>Unit</th>
				<th>Unit cost</th>
				<th>Total</th>
				<th>By</th>
				{#if canEdit}<th></th>{/if}
			</tr>
		</thead>
		<tbody>
			{#each groups as group (group.date)}
				<tr class="date-row">
					<td colspan={canEdit ? 9 : 8} class="date-header">{group.date}</td>
				</tr>
				{#each group.items as t (t.id)}
					{#if editingId === t.id}
						<tr class="editing-row">
							<td>
								<input form={`transaction-update-${t.id}`} type="date" name="transactionDate" value={t.transaction_date} required />
							</td>
							<td>
								<select form={`transaction-update-${t.id}`} name="type" bind:value={editingType}>
									{#each Object.entries(TYPE_LABELS) as [value, label]}
										<option {value}>{label}</option>
									{/each}
								</select>
							</td>
							<td>
								<input
									form={`transaction-update-${t.id}`}
									type="text"
									name="itemName"
									value={t.item_name ?? ''}
									placeholder="Item name"
									maxlength="200"
									disabled={editingType !== 'item'}
								/>
							</td>
							<td>
								<input
									form={`transaction-update-${t.id}`}
									type="number"
									step="any"
									min="0"
									name="quantity"
									value={t.quantity ?? ''}
									disabled={editingType !== 'item'}
								/>
							</td>
							<td>
								<input
									form={`transaction-update-${t.id}`}
									type="text"
									name="unit"
									value={t.unit ?? ''}
									placeholder="e.g. pcs"
									maxlength="50"
									disabled={editingType !== 'item'}
								/>
							</td>
							<td>
								<input
									form={`transaction-update-${t.id}`}
									type="number"
									step="any"
									min="0"
									name="unitCost"
									value={t.unit_cost ?? ''}
									placeholder={unitCostPlaceholder(editingType)}
									required
								/>
							</td>
							<td class="muted">—</td>
							<td>
								<select form={`transaction-update-${t.id}`} name="memberId" value={t.member_id}>
									{#each members as member (member.id)}
										<option value={member.id}>{member.displayName}</option>
									{/each}
								</select>
							</td>
							{#if canEdit}
								<td class="actions-cell">
									<div class="row-actions">
										<button type="button" onclick={() => handleSave(t.id)} disabled={savingId === t.id}>
											{savingId === t.id ? 'Saving…' : 'Save'}
										</button>
										<button type="button" class="btn-plain" onclick={cancelEdit}>Cancel</button>
									</div>
								</td>
							{/if}
						</tr>
					{:else}
						<tr class="display-row" class:expanded={expandedId === t.id} onclick={(e) => handleRowClick(e, t.id)}>
							<td>{t.transaction_date}</td>
							<td>{TYPE_LABELS[t.type]}</td>
							<td>{t.item_name ?? ''}</td>
							<td>{t.type === 'item' ? (t.quantity ?? '') : ''}</td>
							<td>{t.unit ?? ''}</td>
							<td>{t.type === 'item' && t.unit_cost != null ? formatCurrency(t.unit_cost) : ''}</td>
							<td>{t.type === 'discount' || t.type === 'refund' ? '-' : ''}{t.total_cost != null ? formatCurrency(t.total_cost) : ''}</td>
							<td>{memberName(t.member_id, t.profiles)}</td>
							{#if canEdit}
								<td class="actions-cell">
									<div class="row-actions">
										<button type="button" class="btn-plain" onclick={() => startEdit(t)}>Edit</button>
										<button type="button" class="btn-danger" onclick={() => handleDelete(t.id)} disabled={deletingId === t.id}>
											{deletingId === t.id ? 'Deleting…' : 'Delete'}
										</button>
									</div>
								</td>
							{/if}
						</tr>
					{/if}
					{#if rowError?.id === t.id}
						<tr>
							<td colspan={canEdit ? 9 : 8} class="row-error">{rowError.message}</td>
						</tr>
					{/if}
				{/each}
			{/each}
		</tbody>
		<tfoot>
			<tr class="total-row">
				<td colspan="6">Net total</td>
				<td>{formatCurrency(netTotal)}</td>
				<td></td>
				{#if canEdit}<td></td>{/if}
			</tr>
		</tfoot>
	</table>
	</div>
{/if}

{#if canEdit}
	{#each transactionsState.items as t (t.id)}
		<form id={`transaction-update-${t.id}`} method="POST" action={`/api/transactions/${t.id}/update`} class="hidden-form"></form>
	{/each}

	<form method="POST" action={`/api/projects/${projectId}/transactions/create`} onsubmit={handleAddSubmit}>
		<input type="date" name="transactionDate" required />
		<select name="type" bind:value={addType}>
			{#each Object.entries(TYPE_LABELS) as [value, label]}
				<option {value}>{label}</option>
			{/each}
		</select>
		<input type="text" name="itemName" placeholder="Item name" maxlength="200" disabled={addType !== 'item'} />
		<input type="number" step="any" min="0" name="quantity" placeholder="Qty" disabled={addType !== 'item'} />
		<input type="text" name="unit" placeholder="Unit (e.g. pcs)" maxlength="50" disabled={addType !== 'item'} />
		<input type="number" step="any" min="0" name="unitCost" placeholder={unitCostPlaceholder(addType)} required />
		<select name="memberId" required>
			<option value="" disabled selected>Made by…</option>
			{#each members as member (member.id)}
				<option value={member.id}>{member.displayName}</option>
			{/each}
		</select>
		<button type="submit" disabled={adding}>{adding ? 'Adding…' : 'Add transaction'}</button>
	</form>
	{#if addError}<p class="row-error">{addError}</p>{/if}
{/if}

<style>
	.table-scroll table {
		table-layout: fixed;
		font-size: 0.85rem;
	}

	.date-header {
		font-weight: 700;
		padding-top: var(--space-3);
	}

	.date-row:first-child .date-header {
		padding-top: var(--space-2);
	}

	.table-scroll tbody tr:last-child td {
		border-bottom: none;
	}

	.total-row td {
		font-weight: 700;
		border-top: 1px solid var(--color-border-strong);
	}

	.table-scroll th {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	tr.editing-row td {
		position: relative;
	}

	tr.display-row {
		cursor: pointer;
	}

	tr.display-row td {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	tr.display-row td.actions-cell {
		overflow: visible;
		cursor: default;
	}

	tr.display-row.expanded {
		background: var(--color-highlight);
	}

	tr.display-row.expanded td {
		overflow: visible;
		white-space: normal;
		text-overflow: clip;
		overflow-wrap: break-word;
		word-break: break-word;
	}

	.table-scroll td input,
	.table-scroll td select {
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
		padding: 2px var(--space-2);
	}

	.table-scroll td input:focus {
		position: absolute;
		top: 0;
		left: 0;
		width: 220px;
		max-width: calc(100vw - var(--space-6));
		z-index: 2;
		background: var(--color-bg);
		border-color: var(--color-border-strong);
	}

	.row-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		white-space: nowrap;
	}

	.row-actions button {
		white-space: nowrap;
		flex-shrink: 0;
		padding: 2px var(--space-2);
		font-size: 0.8rem;
	}

	.hidden-form {
		display: none;
	}

	.row-error {
		color: var(--color-danger);
	}
</style>
