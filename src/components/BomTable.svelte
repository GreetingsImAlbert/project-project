<script lang="ts">
	interface BomItem {
		id: string;
		part_name: string;
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
		items,
		canEdit,
	}: {
		projectId: string;
		items: BomItem[];
		canEdit: boolean;
	} = $props();

	let editingId = $state<string | null>(null);
	let savingId = $state<string | null>(null);

	function startEdit(id: string) {
		editingId = id;
	}

	function cancelEdit() {
		editingId = null;
	}

	function handleSaveSubmit(id: string) {
		savingId = id;
	}

	function handleDeleteSubmit(e: SubmitEvent) {
		if (!confirm('Delete this BOM item?')) {
			e.preventDefault();
		}
	}
</script>

<h2>Bill of Materials</h2>

{#if items.length === 0}
	<p class="muted">No BOM items yet.</p>
{:else}
	<div class="table-scroll">
	<table>
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
			{#each items as item (item.id)}
				{#if editingId === item.id}
					<tr>
						<td><input form={`bom-update-${item.id}`} type="text" name="partName" value={item.part_name} maxlength="200" required /></td>
						<td><input form={`bom-update-${item.id}`} type="text" name="description" value={item.description ?? ''} maxlength="1000" /></td>
						<td><input form={`bom-update-${item.id}`} type="number" step="any" min="0" name="quantity" value={item.quantity ?? ''} /></td>
						<td><input form={`bom-update-${item.id}`} type="text" name="unit" value={item.unit ?? ''} placeholder="e.g. 5 pcs" maxlength="50" /></td>
						<td><input form={`bom-update-${item.id}`} type="number" step="any" min="0" name="unitCost" value={item.unit_cost ?? ''} /></td>
						<td>
							<input form={`bom-update-${item.id}`} type="text" name="supplier" value={item.supplier ?? ''} placeholder="Supplier name" maxlength="200" />
							<input form={`bom-update-${item.id}`} type="url" name="itemUrl" value={item.item_url ?? ''} placeholder="Supplier link" />
						</td>
						<td class="muted">—</td>
						{#if canEdit}
							<td class="row-actions">
								<button form={`bom-update-${item.id}`} type="submit" onclick={() => handleSaveSubmit(item.id)} disabled={savingId === item.id}>Save</button>
								<button type="button" class="btn-plain" onclick={cancelEdit}>Cancel</button>
							</td>
						{/if}
					</tr>
				{:else}
					<tr>
						<td>{item.part_name}</td>
						<td>{item.description}</td>
						<td>{item.quantity}</td>
						<td>{item.unit}</td>
						<td>{item.unit_cost}</td>
						<td>
							{#if item.supplier}
								{#if item.item_url}
									<a href={item.item_url} target="_blank" rel="noopener noreferrer">{item.supplier}</a>
								{:else}
									{item.supplier}
								{/if}
							{/if}
						</td>
						<td>{item.total_cost}</td>
						{#if canEdit}
							<td class="row-actions">
								<button type="button" class="btn-plain" onclick={() => startEdit(item.id)}>Edit</button>
								<button form={`bom-delete-${item.id}`} type="submit" class="btn-danger">Delete</button>
							</td>
						{/if}
					</tr>
				{/if}
			{/each}
		</tbody>
	</table>
	</div>
{/if}

{#if canEdit}
	{#each items as item (item.id)}
		<form id={`bom-update-${item.id}`} method="POST" action={`/api/bom/${item.id}/update`} class="hidden-form"></form>
		<form id={`bom-delete-${item.id}`} method="POST" action={`/api/bom/${item.id}/delete`} class="hidden-form" onsubmit={handleDeleteSubmit}></form>
	{/each}

	<form method="POST" action={`/api/projects/${projectId}/bom/create`} onsubmit={(e) => (e.currentTarget.querySelector('button')!.disabled = true)}>
		<input type="text" name="partName" placeholder="Part name" maxlength="200" required />
		<input type="text" name="description" placeholder="Description" maxlength="1000" />
		<input type="number" step="any" min="0" name="quantity" placeholder="Qty" />
		<input type="text" name="unit" placeholder="Unit (e.g. 5 pcs)" maxlength="50" />
		<input type="number" step="any" min="0" name="unitCost" placeholder="Unit cost" />
		<input type="text" name="supplier" placeholder="Supplier" maxlength="200" />
		<input type="url" name="itemUrl" placeholder="Supplier link" />
		<button type="submit">Add BOM item</button>
	</form>
{/if}

<style>
	.row-actions {
		display: flex;
		gap: var(--space-2);
		white-space: nowrap;
	}

	.hidden-form {
		display: none;
	}
</style>