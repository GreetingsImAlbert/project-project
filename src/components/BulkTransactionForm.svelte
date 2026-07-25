<script lang="ts">
	import { bomState } from '../lib/bom-store.svelte';
	import type { BomItem } from '../lib/bom-store.svelte';
	import type { Transaction } from '../lib/transactions-store.svelte';
	import { BULK_LINE_TYPES, type BulkLineType, type CostMode } from '../lib/bulk-transaction';

	interface Member {
		id: string;
		displayName: string;
	}

	let {
		action,
		members,
		parent = null,
		lines: existingLines = [],
		submitLabel = 'Add bulk transaction',
		onSaved,
		onCancel,
	}: {
		action: string;
		members: Member[];
		parent?: Transaction | null;
		lines?: Transaction[];
		submitLabel?: string;
		onSaved: (result: { parent: Transaction; lines: Transaction[] }) => void;
		onCancel: () => void;
	} = $props();

	interface DraftLine {
		key: number;
		type: BulkLineType;
		bomId: string;
		itemName: string;
		quantity: string;
		unit: string;
		unitCost: string;
		supplier: string;
		itemUrl: string;
	}

	const LINE_TYPE_LABELS: Record<BulkLineType, string> = {
		item: 'Item',
		shipping: 'Shipping',
		discount: 'Discount',
		refund: 'Refund',
	};

	let nextKey = 0;

	function blankLine(): DraftLine {
		return {
			key: nextKey++,
			type: 'item',
			bomId: '',
			itemName: '',
			quantity: '',
			unit: '',
			unitCost: '',
			supplier: '',
			itemUrl: '',
		};
	}

	function lineFrom(t: Transaction): DraftLine {
		return {
			key: nextKey++,
			type: (BULK_LINE_TYPES as readonly string[]).includes(t.type) ? (t.type as BulkLineType) : 'item',
			bomId: '',
			itemName: t.item_name ?? '',
			quantity: t.quantity != null ? String(t.quantity) : '',
			unit: t.unit ?? '',
			unitCost: t.unit_cost != null ? String(t.unit_cost) : '',
			supplier: t.supplier ?? '',
			itemUrl: t.item_url ?? '',
		};
	}

	// Editing reopens the group exactly as it was stored; a fresh form starts with two
	// blank lines, since one line would just be a plain transaction.
	let label = $state(parent?.item_name ?? '');
	let transactionDate = $state(parent?.transaction_date ?? '');
	let memberId = $state(parent?.member_id ?? '');
	let supplier = $state(parent?.supplier ?? '');
	let itemUrl = $state(parent?.item_url ?? '');
	// A stored group whose lines carry no cost was entered as one overall amount.
	let costMode = $state<CostMode>(
		parent && existingLines.length > 0 && existingLines.every((l) => l.unit_cost == null) ? 'overall' : 'per-item',
	);
	let overallCost = $state(parent && parent.unit_cost != null ? String(parent.unit_cost) : '');
	let draftLines = $state<DraftLine[]>(
		existingLines.length > 0 ? existingLines.map(lineFrom) : [blankLine(), blankLine()],
	);

	let saving = $state(false);
	let error = $state<string | null>(null);

	let bomItems = $derived(bomState.items);

	// Mirrors buildBulkRows' per-item branch so the running total shown while typing is
	// the number that will actually be stored.
	let runningTotal = $derived(
		draftLines.reduce((sum, line) => {
			const qty = line.type === 'item' ? Number(line.quantity || '1') : 1;
			const cost = Number(line.unitCost || '0');
			if (!Number.isFinite(qty) || !Number.isFinite(cost)) return sum;
			const lineTotal = qty * cost;
			return line.type === 'discount' || line.type === 'refund' ? sum - lineTotal : sum + lineTotal;
		}, 0),
	);

	function bomItemFor(id: string): BomItem | undefined {
		return bomItems.find((item) => item.id === id);
	}

	function addLine() {
		draftLines = [...draftLines, blankLine()];
	}

	function removeLine(key: number) {
		draftLines = draftLines.filter((line) => line.key !== key);
	}

	function updateLine(key: number, patch: Partial<DraftLine>) {
		draftLines = draftLines.map((line) => (line.key === key ? { ...line, ...patch } : line));
	}

	type BomField = 'itemName' | 'quantity' | 'unit' | 'unitCost' | 'supplier' | 'itemUrl';

	function valuesFrom(item: BomItem): Record<BomField, string> {
		return {
			itemName: item.part_name,
			quantity: item.quantity != null ? String(item.quantity) : '',
			unit: item.unit ?? '',
			unitCost: item.unit_cost != null ? String(item.unit_cost) : '',
			supplier: item.supplier ?? '',
			itemUrl: item.item_url ?? '',
		};
	}

	// Picking a BOM item fills the whole line at once; the per-field copy buttons stay
	// for pulling one value back after it's been changed by hand.
	function pickBom(key: number, bomId: string) {
		const item = bomItemFor(bomId);
		updateLine(key, item ? { bomId, ...valuesFrom(item) } : { bomId });
	}

	function copyField(key: number, field: BomField) {
		const line = draftLines.find((l) => l.key === key);
		if (!line) return;
		const item = bomItemFor(line.bomId);
		if (!item) return;

		updateLine(key, { [field]: valuesFrom(item)[field] } as Partial<DraftLine>);
	}

	function copyAll(key: number) {
		const line = draftLines.find((l) => l.key === key);
		if (!line) return;
		const item = bomItemFor(line.bomId);
		if (!item) return;

		updateLine(key, valuesFrom(item));
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();

		saving = true;
		error = null;

		const res = await fetch(action, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				label,
				transactionDate,
				memberId,
				supplier,
				itemUrl,
				costMode,
				overallCost,
				lines: draftLines.map((line) => ({
					type: line.type,
					itemName: line.itemName,
					quantity: line.quantity,
					unit: line.unit,
					unitCost: line.unitCost,
					supplier: line.supplier,
					itemUrl: line.itemUrl,
				})),
			}),
		});

		if (!res.ok) {
			error = await res.text();
			saving = false;
			return;
		}

		onSaved(await res.json());
		saving = false;
	}
</script>

<form onsubmit={handleSubmit}>
	<div class="panel-grid">
		<label class="field">
			<span class="field-label">Name</span>
			<input type="text" placeholder="Bulk transaction" maxlength="200" bind:value={label} />
		</label>
		<label class="field">
			<span class="field-label">Date</span>
			<input type="date" required bind:value={transactionDate} />
		</label>
		<label class="field">
			<span class="field-label">Recorded by</span>
			<select required bind:value={memberId}>
				<option value="" disabled>Select member…</option>
				{#each members as member (member.id)}
					<option value={member.id}>{member.displayName}</option>
				{/each}
			</select>
		</label>
		<label class="field">
			<span class="field-label">Supplier</span>
			<input type="text" placeholder="Supplier name" maxlength="200" bind:value={supplier} />
		</label>
		<label class="field field-wide">
			<span class="field-label">Supplier link</span>
			<input type="url" placeholder="https://…" bind:value={itemUrl} />
		</label>
	</div>

	<div class="cost-mode">
		<span class="field-label">Costs</span>
		<label class="radio"><input type="radio" value="per-item" bind:group={costMode} /> Per item</label>
		<label class="radio"><input type="radio" value="overall" bind:group={costMode} /> One total for everything</label>

		{#if costMode === 'overall'}
			<input
				class="overall-input"
				type="number"
				step="any"
				min="0"
				placeholder="Total cost"
				required
				bind:value={overallCost}
			/>
		{:else}
			<span class="running-total">Total {runningTotal.toFixed(2)}</span>
		{/if}
	</div>

	<div class="lines">
		{#each draftLines as line (line.key)}
			{@const picked = bomItemFor(line.bomId)}
			<div class="line">
				<div class="line-grid">
					<label class="field">
						<span class="field-label">Type</span>
						<select
							value={line.type}
							onchange={(e) => updateLine(line.key, { type: e.currentTarget.value as BulkLineType })}
						>
							{#each BULK_LINE_TYPES as value (value)}
								<option {value}>{LINE_TYPE_LABELS[value]}</option>
							{/each}
						</select>
					</label>

					{#if line.type === 'item'}
						<label class="field">
							<span class="field-label">
								From BOM
								{#if picked}
									<button type="button" class="copy-btn" onclick={() => copyAll(line.key)}>copy all</button>
								{/if}
							</span>
							<select value={line.bomId} onchange={(e) => pickBom(line.key, e.currentTarget.value)}>
								<option value="">Custom item</option>
								{#each bomItems as item (item.id)}
									<option value={item.id}>{item.part_name}</option>
								{/each}
							</select>
						</label>
					{/if}

					<label class="field">
						<span class="field-label">
							{line.type === 'item' ? 'Item' : 'Description'}
							{#if picked}
								<button type="button" class="copy-btn" onclick={() => copyField(line.key, 'itemName')}>copy</button>
							{/if}
						</span>
						<input
							type="text"
							placeholder={line.type === 'item' ? 'Item name' : LINE_TYPE_LABELS[line.type]}
							maxlength="200"
							value={line.itemName}
							oninput={(e) => updateLine(line.key, { itemName: e.currentTarget.value })}
						/>
					</label>

					{#if line.type === 'item'}
						<label class="field">
							<span class="field-label">
								Qty
								{#if picked}
									<button type="button" class="copy-btn" onclick={() => copyField(line.key, 'quantity')}>copy</button>
								{/if}
							</span>
							<input
								type="number"
								step="any"
								min="0"
								placeholder="Qty"
								value={line.quantity}
								oninput={(e) => updateLine(line.key, { quantity: e.currentTarget.value })}
							/>
						</label>
						<label class="field">
							<span class="field-label">
								Unit
								{#if picked}
									<button type="button" class="copy-btn" onclick={() => copyField(line.key, 'unit')}>copy</button>
								{/if}
							</span>
							<input
								type="text"
								placeholder="e.g. pcs"
								maxlength="50"
								value={line.unit}
								oninput={(e) => updateLine(line.key, { unit: e.currentTarget.value })}
							/>
						</label>
					{/if}

					{#if costMode === 'per-item'}
						<label class="field">
							<span class="field-label">
								{line.type === 'item' ? 'Unit cost' : 'Amount'}
								{#if picked && line.type === 'item'}
									<button type="button" class="copy-btn" onclick={() => copyField(line.key, 'unitCost')}>copy</button>
								{/if}
							</span>
							<input
								type="number"
								step="any"
								min="0"
								placeholder={line.type === 'item' ? 'Unit cost' : 'Amount'}
								value={line.unitCost}
								oninput={(e) => updateLine(line.key, { unitCost: e.currentTarget.value })}
							/>
						</label>
					{/if}

					<label class="field">
						<span class="field-label">
							Supplier
							{#if picked}
								<button type="button" class="copy-btn" onclick={() => copyField(line.key, 'supplier')}>copy</button>
							{/if}
						</span>
						<input
							type="text"
							placeholder="Supplier name"
							maxlength="200"
							value={line.supplier}
							oninput={(e) => updateLine(line.key, { supplier: e.currentTarget.value })}
						/>
					</label>

					<label class="field">
						<span class="field-label">
							Supplier link
							{#if picked}
								<button type="button" class="copy-btn" onclick={() => copyField(line.key, 'itemUrl')}>copy</button>
							{/if}
						</span>
						<input
							type="url"
							placeholder="https://…"
							value={line.itemUrl}
							oninput={(e) => updateLine(line.key, { itemUrl: e.currentTarget.value })}
						/>
					</label>
				</div>

				<button
					type="button"
					class="btn-danger remove-line"
					onclick={() => removeLine(line.key)}
					disabled={draftLines.length === 1}
					title={draftLines.length === 1 ? 'A bulk transaction needs at least one item' : 'Remove this item'}
				>
					Remove
				</button>
			</div>
		{/each}
	</div>

	<button type="button" class="btn-plain add-line" onclick={addLine}>Add item</button>

	{#if error}<p class="panel-error">{error}</p>{/if}

	<div class="panel-actions">
		<button type="submit" disabled={saving}>{saving ? 'Saving…' : submitLabel}</button>
		<button type="button" class="btn-plain" onclick={onCancel}>Cancel</button>
	</div>
</form>

<style>
	.cost-mode {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-border);
	}

	.cost-mode .field-label {
		color: var(--color-muted);
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.radio {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		font-size: 0.8rem;
	}

	.radio input {
		width: auto;
	}

	.overall-input {
		width: 140px;
		padding: var(--space-1) var(--space-2);
		font-size: 0.8rem;
	}

	.running-total {
		color: var(--color-muted);
		font-size: 0.78rem;
		font-variant-numeric: tabular-nums;
		margin-left: auto;
	}

	.lines {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}

	.line {
		display: flex;
		align-items: flex-end;
		gap: var(--space-2);
		padding: var(--space-2);
		border: 1px solid var(--color-border);
	}

	.line-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
		gap: var(--space-2);
		flex: 1;
		min-width: 0;
	}

	/* .copy-btn lives in global.css — shared with TransactionsTable's own item form. */

	.remove-line {
		padding: var(--space-1) var(--space-2);
		font-size: 0.7rem;
		white-space: nowrap;
	}

	.add-line {
		margin-top: var(--space-2);
		padding: var(--space-1) var(--space-3);
		font-size: 0.8rem;
	}

	@media (max-width: 640px) {
		.line {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
