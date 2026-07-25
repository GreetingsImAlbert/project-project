<script lang="ts">
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import { formatCurrency, initCurrency } from '../lib/currency.svelte';
	import {
		bomState,
		initBom,
		addBomItem,
		updateBomItem,
		removeBomItem,
		type BomItem,
	} from '../lib/bom-store.svelte';

	let {
		projectId,
		initialItems,
		canEdit,
	}: {
		projectId: string;
		initialItems: BomItem[];
		canEdit: boolean;
	} = $props();

	initBom(initialItems);

	// One row panel is open at a time: either its read-only detail or its edit form.
	// Keeping them mutually exclusive means a row never has two things hanging off it.
	let openId = $state<string | null>(null);
	let openMode = $state<'detail' | 'edit'>('detail');

	let savingId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

	let adding = $state(false);
	let addError = $state<string | null>(null);
	let showAddForm = $state(false);
	let addButtonVisible = $state(true);
	let addPartName = $state('');
	let addCategorySelect = $state('');
	let addCategoryNew = $state('');
	let addDescription = $state('');
	let addQuantity = $state('');
	let addUnit = $state('');
	let addUnitCost = $state('');
	let addSupplier = $state('');
	let addItemUrl = $state('');

	let editCategorySelect = $state('');
	let editCategoryNew = $state('');

	const UNCATEGORIZED = 'Uncategorized';
	const NEW_CATEGORY_VALUE = '__new__';

	let colCount = $derived(canEdit ? 8 : 7);

	let groups = $derived.by(() => {
		const map = new Map<string, BomItem[]>();
		for (const item of bomState.items) {
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

	let existingCategories = $derived(
		[...new Set(bomState.items.map((item) => item.category?.trim()).filter((c): c is string => !!c))].sort((a, b) =>
			a.localeCompare(b),
		),
	);

	let addCategoryEffective = $derived(addCategorySelect === NEW_CATEGORY_VALUE ? addCategoryNew : addCategorySelect);
	let editCategoryEffective = $derived(editCategorySelect === NEW_CATEGORY_VALUE ? editCategoryNew : editCategorySelect);

	let showGroupHeaders = $derived(groups.length > 1 || groups[0]?.category !== UNCATEGORIZED);

	let grandTotal = $derived(bomState.items.reduce((sum, item) => sum + (item.total_cost ?? 0), 0));

	let groupSubtotals = $derived(
		new Map(groups.map((g) => [g.category, g.items.reduce((sum, item) => sum + (item.total_cost ?? 0), 0)])),
	);

	onMount(() => {
		initCurrency();
	});

	function handleRowClick(e: MouseEvent, id: string) {
		if ((e.target as HTMLElement).closest('.row-actions, a')) return;
		if (openId === id && openMode === 'detail') {
			openId = null;
			return;
		}
		openId = id;
		openMode = 'detail';
	}

	function startEdit(item: BomItem) {
		if (openId === item.id && openMode === 'edit') {
			openId = null;
			return;
		}
		openId = item.id;
		openMode = 'edit';
		editCategorySelect = item.category?.trim() || '';
		editCategoryNew = '';
		rowError = null;
	}

	function cancelEdit() {
		openId = null;
		rowError = null;
	}

	async function handleSave(e: SubmitEvent, id: string) {
		e.preventDefault();
		const form = e.currentTarget as HTMLFormElement;

		rowError = null;
		savingId = id;

		const res = await fetch(form.action, { method: 'POST', body: new FormData(form) });

		if (!res.ok) {
			rowError = { id, message: await res.text() };
			savingId = null;
			return;
		}

		updateBomItem(await res.json());
		openId = null;
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

		removeBomItem(id);
		if (openId === id) openId = null;
		deletingId = null;
	}

	// addError is cleared here, not on close: the panel deliberately keeps a half-filled
	// row across a close, but a stale error from the last attempt shouldn't come back
	// with it.
	function openAddForm() {
		showAddForm = true;
		addButtonVisible = false;
		addError = null;
	}

	function closeAddForm() {
		showAddForm = false;
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

		addBomItem(await res.json());
		form.reset();
		addPartName = '';
		addCategorySelect = '';
		addCategoryNew = '';
		addDescription = '';
		addQuantity = '';
		addUnit = '';
		addUnitCost = '';
		addSupplier = '';
		addItemUrl = '';
		showAddForm = false;
		adding = false;
	}
</script>

{#snippet categoryField(select: string, newValue: string, onSelect: (v: string) => void, onNew: (v: string) => void)}
	<label class="field">
		<span class="field-label">Category</span>
		<select value={select} onchange={(e) => onSelect((e.currentTarget as HTMLSelectElement).value)}>
			<option value="">None</option>
			{#each existingCategories as cat (cat)}
				<option value={cat}>{cat}</option>
			{/each}
			<option value={NEW_CATEGORY_VALUE}>+ Add category</option>
		</select>
		{#if select === NEW_CATEGORY_VALUE}
			<input
				type="text"
				placeholder="New category name"
				maxlength="100"
				value={newValue}
				oninput={(e) => onNew((e.currentTarget as HTMLInputElement).value)}
			/>
		{/if}
	</label>
{/snippet}

<section class="money-section">
	<div class="money-section-head">
		<h2>Bill of Materials</h2>
		<span class="section-meta">
			{bomState.items.length} item{bomState.items.length === 1 ? '' : 's'} · total <strong>{formatCurrency(grandTotal)}</strong>
		</span>
	</div>

	{#if bomState.items.length === 0}
		<p class="muted empty">No BOM items yet.</p>
	{:else}
		<div class="money-table">
			<table>
				<colgroup>
					<col style="width:160px" />
					<col style="width:200px" />
					<col style="width:52px" />
					<col style="width:72px" />
					<col style="width:96px" />
					<col style="width:140px" />
					<col style="width:100px" />
					{#if canEdit}<col style="width:130px" />{/if}
				</colgroup>
				<thead>
					<tr>
						<th>Part name</th>
						<th>Description</th>
						<th class="num">Qty</th>
						<th>Unit</th>
						<th class="num">Unit cost</th>
						<th>Supplier</th>
						<th class="num">Total</th>
						{#if canEdit}<th><span class="sr-only">Actions</span></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each groups as group (group.category)}
						{#if showGroupHeaders}
							<tr class="group-row">
								<td colspan={colCount}>
									<div class="group-head">
										<span class="group-name">{group.category}</span>
										<span class="group-total">{formatCurrency(groupSubtotals.get(group.category) ?? 0)}</span>
									</div>
								</td>
							</tr>
						{/if}
						{#each group.items as item (item.id)}
							<tr class="data-row clickable" class:open={openId === item.id} onclick={(e) => handleRowClick(e, item.id)}>
								<td>{item.part_name}</td>
								<td>{item.description ?? ''}</td>
								<td class="num">{item.quantity ?? ''}</td>
								<td>{item.unit ?? ''}</td>
								<td class="num">{item.unit_cost != null ? formatCurrency(item.unit_cost) : ''}</td>
								<td>
									{#if item.supplier}
										{#if item.item_url}
											<a href={item.item_url} target="_blank" rel="noopener noreferrer">{item.supplier}</a>
										{:else}
											{item.supplier}
										{/if}
									{/if}
								</td>
								<td class="num">{item.total_cost != null ? formatCurrency(item.total_cost) : ''}</td>
								{#if canEdit}
									<td class="actions-cell">
										<div class="row-actions">
											<button type="button" class="btn-plain" onclick={() => startEdit(item)}>Edit</button>
											<button type="button" class="btn-danger" onclick={() => handleDelete(item.id)} disabled={deletingId === item.id}>
												{deletingId === item.id ? '…' : 'Delete'}
											</button>
										</div>
									</td>
								{/if}
							</tr>

							{#if openId === item.id && openMode === 'detail'}
								<tr class="panel-row">
									<td colspan={colCount}>
										<div class="money-panel" transition:slide={{ duration: 150 }}>
											<div class="panel-grid">
												<div class="field">
													<span class="field-label">Part name</span>
													<span class="field-value">{item.part_name}</span>
												</div>
												<div class="field">
													<span class="field-label">Category</span>
													<span class="field-value">{item.category?.trim() || '—'}</span>
												</div>
												<div class="field">
													<span class="field-label">Quantity</span>
													<span class="field-value">{item.quantity ?? '—'} {item.unit ?? ''}</span>
												</div>
												<div class="field">
													<span class="field-label">Unit cost</span>
													<span class="field-value">{item.unit_cost != null ? formatCurrency(item.unit_cost) : '—'}</span>
												</div>
												<div class="field">
													<span class="field-label">Total cost</span>
													<span class="field-value">{item.total_cost != null ? formatCurrency(item.total_cost) : '—'}</span>
												</div>
												<div class="field">
													<span class="field-label">Supplier</span>
													<span class="field-value">
														{#if item.item_url}
															<a href={item.item_url} target="_blank" rel="noopener noreferrer">{item.supplier || item.item_url}</a>
														{:else}
															{item.supplier || '—'}
														{/if}
													</span>
												</div>
												<div class="field field-wide">
													<span class="field-label">Description</span>
													<span class="field-value">{item.description || '—'}</span>
												</div>
											</div>
										</div>
									</td>
								</tr>
							{/if}

							{#if canEdit && openId === item.id && openMode === 'edit'}
								<tr class="panel-row">
									<td colspan={colCount}>
										<div class="money-panel" transition:slide={{ duration: 150 }}>
											<form method="POST" action={`/api/bom/${item.id}/update`} onsubmit={(e) => handleSave(e, item.id)}>
												<div class="panel-grid">
													<label class="field">
														<span class="field-label">Part name</span>
														<input type="text" name="partName" value={item.part_name} maxlength="200" required />
													</label>

													{@render categoryField(
														editCategorySelect,
														editCategoryNew,
														(v) => (editCategorySelect = v),
														(v) => (editCategoryNew = v),
													)}
													<input type="hidden" name="category" value={editCategoryEffective} />

													<label class="field">
														<span class="field-label">Quantity</span>
														<input type="number" step="any" min="0" name="quantity" value={item.quantity ?? ''} />
													</label>
													<label class="field">
														<span class="field-label">Unit</span>
														<input type="text" name="unit" value={item.unit ?? ''} placeholder="e.g. pcs" maxlength="50" />
													</label>
													<label class="field">
														<span class="field-label">Unit cost</span>
														<input type="number" step="any" min="0" name="unitCost" value={item.unit_cost ?? ''} />
													</label>
													<label class="field">
														<span class="field-label">Supplier</span>
														<input type="text" name="supplier" value={item.supplier ?? ''} placeholder="Supplier name" maxlength="200" />
													</label>
													<label class="field field-wide">
														<span class="field-label">Supplier link</span>
														<input type="url" name="itemUrl" value={item.item_url ?? ''} placeholder="https://…" />
													</label>
													<label class="field field-wide">
														<span class="field-label">Description</span>
														<input type="text" name="description" value={item.description ?? ''} maxlength="1000" />
													</label>
												</div>

												{#if rowError?.id === item.id}<p class="panel-error">{rowError.message}</p>{/if}

												<div class="panel-actions">
													<button type="submit" disabled={savingId === item.id}>{savingId === item.id ? 'Saving…' : 'Save'}</button>
													<button type="button" class="btn-plain" onclick={cancelEdit}>Cancel</button>
												</div>
											</form>
										</div>
									</td>
								</tr>
							{/if}

							{#if rowError?.id === item.id && !(openId === item.id && openMode === 'edit')}
								<tr class="row-error">
									<td colspan={colCount}>{rowError.message}</td>
								</tr>
							{/if}
						{/each}
					{/each}
				</tbody>
				<tfoot>
					<tr class="total-row">
						<td colspan="6">Total</td>
						<td class="num">{formatCurrency(grandTotal)}</td>
						{#if canEdit}<td></td>{/if}
					</tr>
				</tfoot>
			</table>
		</div>
	{/if}

	{#if canEdit}
		<form method="POST" action={`/api/projects/${projectId}/bom/create`} onsubmit={handleAddSubmit} class="add-form">
			{#if showAddForm}
				<div class="money-panel add-panel" transition:slide={{ duration: 150 }} onoutroend={() => (addButtonVisible = true)}>
					<div class="panel-grid">
						<label class="field">
							<span class="field-label">Part name</span>
							<input type="text" name="partName" placeholder="Part name" maxlength="200" required bind:value={addPartName} />
						</label>

						{@render categoryField(
							addCategorySelect,
							addCategoryNew,
							(v) => (addCategorySelect = v),
							(v) => (addCategoryNew = v),
						)}
						<input type="hidden" name="category" value={addCategoryEffective} />

						<label class="field">
							<span class="field-label">Quantity</span>
							<input type="number" step="any" min="0" name="quantity" placeholder="Qty" bind:value={addQuantity} />
						</label>
						<label class="field">
							<span class="field-label">Unit</span>
							<input type="text" name="unit" placeholder="e.g. pcs" maxlength="50" bind:value={addUnit} />
						</label>
						<label class="field">
							<span class="field-label">Unit cost</span>
							<input type="number" step="any" min="0" name="unitCost" placeholder="Unit cost" bind:value={addUnitCost} />
						</label>
						<label class="field">
							<span class="field-label">Supplier</span>
							<input type="text" name="supplier" placeholder="Supplier" maxlength="200" bind:value={addSupplier} />
						</label>
						<label class="field field-wide">
							<span class="field-label">Supplier link</span>
							<input type="url" name="itemUrl" placeholder="https://…" bind:value={addItemUrl} />
						</label>
						<label class="field field-wide">
							<span class="field-label">Description</span>
							<input type="text" name="description" placeholder="Description" maxlength="1000" bind:value={addDescription} />
						</label>
					</div>

					{#if addError}<p class="panel-error">{addError}</p>{/if}
				</div>
			{/if}

			<div class="add-form-actions">
				{#if addButtonVisible}
					<button type="button" class="btn-plain" onclick={openAddForm}>Add BOM item</button>
				{:else}
					<button type="submit" disabled={adding}>{adding ? 'Adding…' : 'Add BOM item'}</button>
					<button type="button" class="btn-plain" onclick={closeAddForm}>Cancel</button>
				{/if}
			</div>
		</form>
	{/if}
</section>

<style>
	.group-head {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		min-width: 0;
	}

	.group-name {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.group-total {
		flex: 0 0 auto;
		font-variant-numeric: tabular-nums;
	}

	.empty {
		font-size: 0.85rem;
	}

	.add-form {
		display: block;
		margin: 0;
	}

	.add-panel {
		border: 1px solid var(--color-border-strong);
		margin-bottom: var(--space-2);
	}

	.add-form-actions {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}

	.add-form-actions button {
		padding: var(--space-1) var(--space-3);
		font-size: 0.8rem;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
