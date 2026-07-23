<script lang="ts">
	import { onMount } from 'svelte';
	import { formatCurrency, initCurrency } from '../lib/currency.svelte';

	interface BomItem {
		id: string;
		part_name: string;
		category: string | null;
		description: string | null;
		quantity: number | null;
		unit: string | null;
		unit_cost: number | null;
		supplier: string | null;
		item_url: string | null;
		total_cost: number | null;
	}

	let {
		projectId,
		initialItems,
		canEdit,
	}: {
		projectId: string;
		initialItems: BomItem[];
		canEdit: boolean;
	} = $props();

	let items = $state(initialItems);

	let editingId = $state<string | null>(null);
	let savingId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

	let adding = $state(false);
	let addError = $state<string | null>(null);

	let expandedId = $state<string | null>(null);

	const UNCATEGORIZED = 'Uncategorized';

	let groups = $derived.by(() => {
		const map = new Map<string, BomItem[]>();
		for (const item of items) {
			const key = item.category?.trim() || UNCATEGORIZED;
			if (!map.has(key)) map.set(key, []);
			map.get(key)!.push(item);
		}
		const keys = [...map.keys()].sort((a, b) => {
			if (a === UNCATEGORIZED) return 1;
			if (b === UNCATEGORIZED) return -1;
			return a.localeCompare(b);
		});
		return keys.map((category) => ({ category, items: map.get(category)! }));
	});

	let showGroupHeaders = $derived(groups.length > 1 || groups[0]?.category !== UNCATEGORIZED);

	let grandTotal = $derived(items.reduce((sum, item) => sum + (item.total_cost ?? 0), 0));

	onMount(() => {
		initCurrency();
	});

	function handleRowClick(e: MouseEvent, id: string) {
		if ((e.target as HTMLElement).closest('.row-actions, a')) return;
		expandedId = expandedId === id ? null : id;
	}

	function startEdit(id: string) {
		editingId = id;
		rowError = null;
	}

	function cancelEdit() {
		editingId = null;
		rowError = null;
	}

	async function handleSave(id: string) {
		rowError = null;
		savingId = id;

		const form = document.getElementById(`bom-update-${id}`) as HTMLFormElement;
		const res = await fetch(form.action, { method: 'POST', body: new FormData(form) });

		if (!res.ok) {
			rowError = { id, message: await res.text() };
			savingId = null;
			return;
		}

		const updated: BomItem = await res.json();
		items = items.map((item) => (item.id === id ? updated : item));
		editingId = null;
		savingId = null;
	}

	async function handleDelete(id: string) {
		if (!confirm('Delete this BOM item?')) return;

		rowError = null;
		deletingId = id;

		const res = await fetch(`/api/bom/${id}/delete`, { method: 'POST' });

		if (!res.ok) {
			rowError = { id, message: await res.text() };
			deletingId = null;
			return;
		}

		items = items.filter((item) => item.id !== id);
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

		const created: BomItem = await res.json();
		items = [...items, created];
		form.reset();
		adding = false;
	}
</script>

<h2>Bill of Materials</h2>

{#if items.length === 0}
	<p class="muted">No BOM items yet.</p>
{:else}
	<div class="table-scroll">
	<table>
		{#if canEdit}
			<colgroup>
				<col style="width:140px" />
				<col style="width:200px" />
				<col style="width:60px" />
				<col style="width:90px" />
				<col style="width:100px" />
				<col style="width:150px" />
				<col style="width:100px" />
				<col style="width:170px" />
			</colgroup>
		{:else}
			<colgroup>
				<col style="width:140px" />
				<col style="width:200px" />
				<col style="width:60px" />
				<col style="width:90px" />
				<col style="width:100px" />
				<col style="width:150px" />
				<col style="width:100px" />
			</colgroup>
		{/if}
		<thead>
			<tr>
				<th>Part name</th>
				<th>Description</th>
				<th>Qty</th>
				<th>Unit</th>
				<th>Unit cost</th>
				<th>Supplier</th>
				<th>Total cost</th>
				{#if canEdit}<th></th>{/if}
			</tr>
		</thead>
		<tbody>
			{#each groups as group (group.category)}
				{#if showGroupHeaders}
					<tr class="category-row">
						<td colspan={canEdit ? 8 : 7} class="category-header">{group.category}</td>
					</tr>
				{/if}
				{#each group.items as item (item.id)}
					{#if editingId === item.id}
						<tr>
							<td>
								<div class="stacked-inputs">
									<input form={`bom-update-${item.id}`} type="text" name="partName" value={item.part_name} maxlength="200" required />
									<input form={`bom-update-${item.id}`} type="text" name="category" value={item.category ?? ''} placeholder="Category" maxlength="100" />
								</div>
							</td>
							<td><input form={`bom-update-${item.id}`} type="text" name="description" value={item.description ?? ''} maxlength="1000" /></td>
							<td><input form={`bom-update-${item.id}`} type="number" step="any" min="0" name="quantity" value={item.quantity ?? ''} /></td>
							<td><input form={`bom-update-${item.id}`} type="text" name="unit" value={item.unit ?? ''} placeholder="e.g. 5 pcs" maxlength="50" /></td>
							<td><input form={`bom-update-${item.id}`} type="number" step="any" min="0" name="unitCost" value={item.unit_cost ?? ''} /></td>
							<td>
								<div class="stacked-inputs">
									<input form={`bom-update-${item.id}`} type="text" name="supplier" value={item.supplier ?? ''} placeholder="Supplier name" maxlength="200" />
									<input form={`bom-update-${item.id}`} type="url" name="itemUrl" value={item.item_url ?? ''} placeholder="Supplier link" />
								</div>
							</td>
							<td class="muted">—</td>
							{#if canEdit}
								<td class="row-actions">
									<button type="button" onclick={() => handleSave(item.id)} disabled={savingId === item.id}>
										{savingId === item.id ? 'Saving…' : 'Save'}
									</button>
									<button type="button" class="btn-plain" onclick={cancelEdit}>Cancel</button>
								</td>
							{/if}
						</tr>
					{:else}
						<tr class="display-row" class:expanded={expandedId === item.id} onclick={(e) => handleRowClick(e, item.id)}>
							<td>{item.part_name}</td>
							<td>{item.description}</td>
							<td>{item.quantity}</td>
							<td>{item.unit}</td>
							<td>{item.unit_cost != null ? formatCurrency(item.unit_cost) : ''}</td>
							<td>
								{#if item.supplier}
									{#if item.item_url}
										<a href={item.item_url} target="_blank" rel="noopener noreferrer">{item.supplier}</a>
									{:else}
										{item.supplier}
									{/if}
								{/if}
							</td>
							<td>{item.total_cost != null ? formatCurrency(item.total_cost) : ''}</td>
							{#if canEdit}
								<td class="row-actions">
									<button type="button" class="btn-plain" onclick={() => startEdit(item.id)}>Edit</button>
									<button type="button" class="btn-danger" onclick={() => handleDelete(item.id)} disabled={deletingId === item.id}>
										{deletingId === item.id ? 'Deleting…' : 'Delete'}
									</button>
								</td>
							{/if}
						</tr>
					{/if}
					{#if rowError?.id === item.id}
						<tr>
							<td colspan={canEdit ? 8 : 7} class="row-error">{rowError.message}</td>
						</tr>
					{/if}
				{/each}
			{/each}
		</tbody>
		<tfoot>
			<tr class="total-row">
				<td colspan="6">Total</td>
				<td>{formatCurrency(grandTotal)}</td>
				{#if canEdit}<td></td>{/if}
			</tr>
		</tfoot>
	</table>
	</div>
{/if}

{#if canEdit}
	{#each items as item (item.id)}
		<form id={`bom-update-${item.id}`} method="POST" action={`/api/bom/${item.id}/update`} class="hidden-form"></form>
	{/each}

	<form method="POST" action={`/api/projects/${projectId}/bom/create`} onsubmit={handleAddSubmit}>
		<input type="text" name="partName" placeholder="Part name" maxlength="200" required />
		<input type="text" name="category" placeholder="Category (optional)" maxlength="100" />
		<input type="text" name="description" placeholder="Description" maxlength="1000" />
		<input type="number" step="any" min="0" name="quantity" placeholder="Qty" />
		<input type="text" name="unit" placeholder="Unit (e.g. 5 pcs)" maxlength="50" />
		<input type="number" step="any" min="0" name="unitCost" placeholder="Unit cost" />
		<input type="text" name="supplier" placeholder="Supplier" maxlength="200" />
		<input type="url" name="itemUrl" placeholder="Supplier link" />
		<button type="submit" disabled={adding}>{adding ? 'Adding…' : 'Add BOM item'}</button>
	</form>
	{#if addError}<p class="row-error">{addError}</p>{/if}
{/if}

<style>
	.table-scroll table {
		table-layout: fixed;
		font-size: 0.85rem;
	}

	.category-header {
		font-weight: 700;
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-border);
	}

	.category-row:first-child .category-header {
		border-top: none;
		padding-top: var(--space-2);
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

	.table-scroll td {
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

	tr.display-row td.row-actions {
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

	.stacked-inputs {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
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
	}

	.hidden-form {
		display: none;
	}

	.row-error {
		color: var(--color-danger);
	}
</style>