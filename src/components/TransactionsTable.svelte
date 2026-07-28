<script lang="ts">
	import { slide } from 'svelte/transition';
	import BulkTransactionForm from './BulkTransactionForm.svelte';
	import { formatCurrency, initCurrency, type CurrencyCode } from '../lib/currency.svelte';
	import { duesFor, netSpend, topLevel } from '../lib/money-math';
	import { bomState, initBom, type BomItem } from '../lib/bom-store.svelte';
	import { contributionsState, initContributions } from '../lib/contributions-store.svelte';
	import { partiesState, initParties, type Party } from '../lib/parties-store.svelte';
	import { partyIdOf, relatedPartyIdOf } from '../lib/money-parties';
	import {
		transactionsState,
		initTransactions,
		addTransaction,
		addTransactionGroup,
		updateTransaction,
		replaceTransactionGroup,
		removeTransaction,
		linesOf,
		type Transaction,
		type TransactionType,
	} from '../lib/transactions-store.svelte';

	let {
		projectId,
		initialTransactions,
		initialBomItems,
		initialPercents,
		initialParties,
		canEdit,
		currency,
	}: {
		projectId: string;
		initialTransactions: Transaction[];
		initialBomItems: BomItem[];
		initialPercents: Record<string, number>;
		initialParties: Party[];
		canEdit: boolean;
		currency: CurrencyCode;
	} = $props();

	initTransactions(initialTransactions);
	// Members and ghost members in one list — the contributions table can add, rename
	// or remove a ghost, and these selects have to follow without a reload.
	initParties(initialParties);
	// Seeded here as well as in BomTable/MoneySummary so an item form can offer the BOM
	// list no matter which island hydrates first — see initTransactions for the guard.
	initBom(initialBomItems);
	// Same reason: the payment form's "all dues" shortcut needs the split, and the
	// contributions table below may not have hydrated yet.
	initContributions(initialPercents);
	initCurrency(currency);

	// One row panel at a time — read-only detail or the edit form, never both.
	let openId = $state<string | null>(null);
	let openMode = $state<'detail' | 'edit'>('detail');

	let savingId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

	let adding = $state(false);
	let addError = $state<string | null>(null);
	let showAddForm = $state(false);
	let showBulkForm = $state(false);
	let addButtonVisible = $state(true);
	let addType = $state<TransactionType>('item');
	let addTransactionDate = $state('');
	let addItemName = $state('');
	let addQuantity = $state('');
	let addUnit = $state('');
	let addUnitCost = $state('');
	let addSupplier = $state('');
	let addItemUrl = $state('');
	let addPartyId = $state('');
	let addRelatedPartyId = $state('');
	let addBomId = $state('');

	let editingType = $state<TransactionType>('item');
	let editingPartyId = $state('');
	let editingRelatedPartyId = $state('');
	let editingDate = $state('');
	let editingItemName = $state('');
	let editingQuantity = $state('');
	let editingUnit = $state('');
	let editingUnitCost = $state('');
	let editingSupplier = $state('');
	let editingItemUrl = $state('');
	let editingBomId = $state('');

	const TYPE_LABELS: Record<TransactionType, string> = {
		item: 'Item',
		shipping: 'Shipping',
		discount: 'Discount',
		refund: 'Refund',
		payment: 'Payment',
		bulk: 'Bulk',
	};

	// 'bulk' is only ever created through the bulk form — it can't be picked as the
	// type of a plain one-line transaction.
	const SINGLE_TYPES = (Object.keys(TYPE_LABELS) as TransactionType[]).filter((t) => t !== 'bulk');

	type BomField = 'itemName' | 'quantity' | 'unit' | 'unitCost' | 'supplier' | 'itemUrl';

	let colCount = $derived(canEdit ? 10 : 9);

	let parties = $derived(partiesState.items);

	function unitCostPlaceholder(type: TransactionType): string {
		return type === 'item' ? 'Unit cost' : 'Amount';
	}

	// What the payer would still owe if this transaction didn't exist, snapped to cents.
	// The row being edited is left out on purpose: it already counts as money that party
	// has paid, so including it would offer only the remainder *after* itself and shrink
	// the payment a little more on every save.
	function duesOf(partyId: string, excludeId: string | null): number {
		const items = excludeId
			? transactionsState.items.filter((t) => t.id !== excludeId && t.group_id !== excludeId)
			: transactionsState.items;
		return Math.round(duesFor(items, contributionsState.percents, partyId) * 100) / 100;
	}

	// Only offered when there's something left to settle — a party who's square with the
	// group (or already ahead) has no "all dues" amount to fill in.
	let addDues = $derived(addType === 'payment' && addPartyId ? duesOf(addPartyId, null) : 0);
	let editDues = $derived(editingType === 'payment' && editingPartyId && openId ? duesOf(editingPartyId, openId) : 0);

	// The payee list excludes whoever is currently the payer, so switching the payer to
	// the party already picked as payee leaves a selection that's no longer in the list:
	// the select renders blank, `required` still sees a value and lets the form through,
	// and the server has to bounce it. Drop the payee instead, so the field asks again.
	// Both read the new payer off the event rather than the bound state, which isn't
	// guaranteed to have been written by the time this listener runs.
	function onAddPartyChange(newPartyId: string) {
		if (addRelatedPartyId === newPartyId) addRelatedPartyId = '';
	}

	function onEditPartyChange(newPartyId: string) {
		if (editingRelatedPartyId === newPartyId) editingRelatedPartyId = '';
	}

	function partyName(id: string | null): string {
		if (!id) return '—';
		return parties.find((p) => p.id === id)?.displayName ?? 'Unknown';
	}

	// The embedded name is the row's own payer — profiles for a member, ghost_members
	// for a ghost — so it still names somebody who has since left the members list.
	function payerName(t: Transaction): string {
		return t.profiles?.display_name ?? t.ghost_members?.display_name ?? partyName(partyIdOf(t));
	}

	function partyOptionLabel(party: Party): string {
		return party.isGhost ? `${party.displayName} · ghost` : party.displayName;
	}

	// A payment has no stored item_name — its label is the current payee name, so a
	// rename shows up on every past row instead of freezing whatever name was picked
	// when the row was created.
	function itemLabel(t: Transaction): string {
		if (t.type === 'payment') return `Pay ${partyName(relatedPartyIdOf(t))}`;
		return t.item_name ?? '';
	}

	function bomValue(bomId: string, field: BomField): string | null {
		const item = bomState.items.find((i) => i.id === bomId);
		if (!item) return null;

		switch (field) {
			case 'itemName':
				return item.part_name;
			case 'quantity':
				return item.quantity != null ? String(item.quantity) : '';
			case 'unit':
				return item.unit ?? '';
			case 'unitCost':
				return item.unit_cost != null ? String(item.unit_cost) : '';
			case 'supplier':
				return item.supplier ?? '';
			case 'itemUrl':
				return item.item_url ?? '';
		}
	}

	function copyToAdd(field: BomField) {
		const value = bomValue(addBomId, field);
		if (value === null) return;

		if (field === 'itemName') addItemName = value;
		else if (field === 'quantity') addQuantity = value;
		else if (field === 'unit') addUnit = value;
		else if (field === 'unitCost') addUnitCost = value;
		else if (field === 'supplier') addSupplier = value;
		else addItemUrl = value;
	}

	function copyToEdit(field: BomField) {
		const value = bomValue(editingBomId, field);
		if (value === null) return;

		if (field === 'itemName') editingItemName = value;
		else if (field === 'quantity') editingQuantity = value;
		else if (field === 'unit') editingUnit = value;
		else if (field === 'unitCost') editingUnitCost = value;
		else if (field === 'supplier') editingSupplier = value;
		else editingItemUrl = value;
	}

	const ALL_BOM_FIELDS: BomField[] = ['itemName', 'quantity', 'unit', 'unitCost', 'supplier', 'itemUrl'];

	function copyAllToAdd() {
		ALL_BOM_FIELDS.forEach(copyToAdd);
	}

	function copyAllToEdit() {
		ALL_BOM_FIELDS.forEach(copyToEdit);
	}

	// Picking a BOM item fills the whole row straight away — the per-field copy buttons
	// stay for pulling one value back after it's been changed by hand.
	function pickAddBom(bomId: string) {
		addBomId = bomId;
		copyAllToAdd();
	}

	function pickEditBom(bomId: string) {
		editingBomId = bomId;
		copyAllToEdit();
	}

	// Newest date first, and the first row of each date carries a rule above it —
	// the Date column is still present per row, so a full-width date banner would
	// just be the same string twice. Bulk lines never appear here: their parent row
	// stands in for them, and clicking it reveals the breakdown.
	let rows = $derived.by(() => {
		const sorted = topLevel(transactionsState.items).sort((a, b) =>
			b.transaction_date.localeCompare(a.transaction_date),
		);
		return sorted.map((t, i) => ({
			t,
			isGroupStart: i === 0 || sorted[i - 1].transaction_date !== t.transaction_date,
		}));
	});

	let netTotal = $derived(netSpend(transactionsState.items));

	function handleRowClick(e: MouseEvent, id: string) {
		if ((e.target as HTMLElement).closest('.row-actions, a')) return;
		if (openId === id && openMode === 'detail') {
			openId = null;
			return;
		}
		openId = id;
		openMode = 'detail';
	}

	function startEdit(t: Transaction) {
		if (openId === t.id && openMode === 'edit') {
			openId = null;
			return;
		}
		openId = t.id;
		openMode = 'edit';
		editingType = t.type;
		editingPartyId = partyIdOf(t);
		editingRelatedPartyId = relatedPartyIdOf(t) ?? '';
		editingDate = t.transaction_date;
		editingItemName = t.item_name ?? '';
		editingQuantity = t.quantity != null ? String(t.quantity) : '';
		editingUnit = t.unit ?? '';
		editingUnitCost = t.unit_cost != null ? String(t.unit_cost) : '';
		editingSupplier = t.supplier ?? '';
		editingItemUrl = t.item_url ?? '';
		editingBomId = '';
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

		updateTransaction(await res.json());
		openId = null;
		savingId = null;
	}

	async function handleDelete(t: Transaction) {
		const prompt =
			t.type === 'bulk' ? 'Delete this bulk transaction and all of its items?' : 'Delete this transaction?';
		if (!confirm(prompt)) return;

		rowError = null;
		deletingId = t.id;

		const res = await fetch(`/api/transactions/${t.id}/delete`, { method: 'POST' });

		if (!res.ok) {
			rowError = { id: t.id, message: await res.text() };
			deletingId = null;
			return;
		}

		removeTransaction(t.id);
		if (openId === t.id) openId = null;
		deletingId = null;
	}

	// Both openers clear addError: the panel keeps its half-filled state across a close,
	// but the error from the last failed attempt has nothing to do with the reopened
	// form and shouldn't be sitting under it.
	function openAddForm() {
		showAddForm = true;
		showBulkForm = false;
		addButtonVisible = false;
		addError = null;
	}

	function openBulkForm() {
		showBulkForm = true;
		showAddForm = false;
		addButtonVisible = false;
		addError = null;
	}

	function closeAddForm() {
		showAddForm = false;
	}

	function closeBulkForm() {
		showBulkForm = false;
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

		addTransaction(await res.json());
		form.reset();
		addType = 'item';
		addTransactionDate = '';
		addItemName = '';
		addQuantity = '';
		addUnit = '';
		addUnitCost = '';
		addSupplier = '';
		addItemUrl = '';
		addPartyId = '';
		addRelatedPartyId = '';
		addBomId = '';
		showAddForm = false;
		adding = false;
	}

	function handleBulkAdded(result: { parent: Transaction; lines: Transaction[] }) {
		addTransactionGroup([result.parent, ...result.lines]);
		showBulkForm = false;
	}

	function handleBulkSaved(parentId: string, result: { parent: Transaction; lines: Transaction[] }) {
		replaceTransactionGroup(parentId, [result.parent, ...result.lines]);
		openId = null;
	}
</script>

<section class="money-section">
	<div class="money-section-head">
		<h2>Transactions</h2>
		<span class="section-meta">
			{rows.length} entr{rows.length === 1 ? 'y' : 'ies'} · net
			<strong>{formatCurrency(netTotal)}</strong>
		</span>
	</div>

	{#if rows.length === 0}
		<p class="muted empty">No transactions yet.</p>
	{:else}
		<div class="money-table">
			<table>
				<colgroup>
					<col style="width:92px" />
					<col style="width:72px" />
					<col style="width:150px" />
					<col style="width:46px" />
					<col style="width:60px" />
					<col style="width:88px" />
					<col style="width:120px" />
					<col style="width:92px" />
					<col style="width:104px" />
					{#if canEdit}<col style="width:130px" />{/if}
				</colgroup>
				<thead>
					<tr>
						<th>Date</th>
						<th>Type</th>
						<th>Item</th>
						<th class="num">Qty</th>
						<th>Unit</th>
						<th class="num">Unit cost</th>
						<th>Supplier</th>
						<th class="num">Total</th>
						<th>By</th>
						{#if canEdit}<th><span class="sr-only">Actions</span></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.t.id)}
						{@const t = row.t}
						{@const lines = t.type === 'bulk' ? linesOf(t.id) : []}
						<tr
							class="data-row clickable"
							class:group-start={row.isGroupStart}
							class:open={openId === t.id}
							onclick={(e) => handleRowClick(e, t.id)}
						>
							<td class="date-cell">{t.transaction_date}</td>
							<td><span class={`type-tag type-${t.type}`}>{TYPE_LABELS[t.type]}</span></td>
							<td>
								{itemLabel(t)}
								{#if t.type === 'bulk'}
									<span class="line-count">({lines.length})</span>
								{/if}
							</td>
							<td class="num">{t.type === 'item' ? (t.quantity ?? '') : ''}</td>
							<td>{t.type === 'item' ? (t.unit ?? '') : ''}</td>
							<td class="num">{t.type === 'item' && t.unit_cost != null ? formatCurrency(t.unit_cost) : ''}</td>
							<td>
								{#if t.item_url}
									<a href={t.item_url} target="_blank" rel="noopener noreferrer">{t.supplier || t.item_url}</a>
								{:else}
									{t.supplier ?? ''}
								{/if}
							</td>
							<td class="num" class:negative={t.type === 'discount' || t.type === 'refund'}>
								{t.type === 'discount' || t.type === 'refund' ? '-' : ''}{t.total_cost != null ? formatCurrency(t.total_cost) : ''}
							</td>
							<td>{payerName(t)}</td>
							{#if canEdit}
								<td class="actions-cell">
									<div class="row-actions">
										<button type="button" class="btn-plain" onclick={() => startEdit(t)}>Edit</button>
										<button type="button" class="btn-danger" onclick={() => handleDelete(t)} disabled={deletingId === t.id}>
											{deletingId === t.id ? '…' : 'Delete'}
										</button>
									</div>
								</td>
							{/if}
						</tr>

						{#if openId === t.id && openMode === 'detail'}
							<tr class="panel-row">
								<td colspan={colCount}>
									<div class="money-panel" transition:slide={{ duration: 150 }}>
										<div class="panel-grid">
											<div class="field">
												<span class="field-label">Date</span>
												<span class="field-value">{t.transaction_date}</span>
											</div>
											<div class="field">
												<span class="field-label">Type</span>
												<span class="field-value">{TYPE_LABELS[t.type]}</span>
											</div>
											<div class="field">
												<span class="field-label">
													{t.type === 'payment' ? 'Paid to' : t.type === 'bulk' ? 'Name' : 'Item'}
												</span>
												<span class="field-value">
													{t.type === 'payment' ? partyName(relatedPartyIdOf(t)) : t.item_name || '—'}
												</span>
											</div>
											{#if t.type === 'item'}
												<div class="field">
													<span class="field-label">Quantity</span>
													<span class="field-value">{t.quantity ?? '—'} {t.unit ?? ''}</span>
												</div>
												<div class="field">
													<span class="field-label">Unit cost</span>
													<span class="field-value">{t.unit_cost != null ? formatCurrency(t.unit_cost) : '—'}</span>
												</div>
											{/if}
											{#if t.type !== 'payment'}
												<div class="field">
													<span class="field-label">Supplier</span>
													<span class="field-value">
														{#if t.item_url}
															<a href={t.item_url} target="_blank" rel="noopener noreferrer">{t.supplier || t.item_url}</a>
														{:else}
															{t.supplier || '—'}
														{/if}
													</span>
												</div>
											{/if}
											<div class="field">
												<span class="field-label">Total</span>
												<span class="field-value">
													{t.type === 'discount' || t.type === 'refund' ? '-' : ''}{t.total_cost != null
														? formatCurrency(t.total_cost)
														: '—'}
												</span>
											</div>
											<div class="field">
												<span class="field-label">{t.type === 'payment' ? 'Paid by' : 'Recorded by'}</span>
												<span class="field-value">{payerName(t)}</span>
											</div>
										</div>

										{#if t.type === 'bulk'}
											<table class="sub-table bulk-lines">
												<colgroup>
													<col style="width:84px" />
													<col />
													<col style="width:56px" />
													<col style="width:60px" />
													<col style="width:96px" />
													<col style="width:130px" />
													<col style="width:100px" />
												</colgroup>
												<thead>
													<tr>
														<th>Type</th>
														<th>Item</th>
														<th class="num">Qty</th>
														<th>Unit</th>
														<th class="num">Unit cost</th>
														<th>Supplier</th>
														<th class="num">Amount</th>
													</tr>
												</thead>
												<tbody>
													{#each lines as line (line.id)}
														<tr>
															<td>{TYPE_LABELS[line.type]}</td>
															<td class="sub-item">{line.item_name || '—'}</td>
															<td class="num">{line.type === 'item' ? (line.quantity ?? '') : ''}</td>
															<td>{line.unit ?? ''}</td>
															<td class="num">{line.unit_cost != null ? formatCurrency(line.unit_cost) : '—'}</td>
															<td class="sub-item">
																{#if line.item_url}
																	<a href={line.item_url} target="_blank" rel="noopener noreferrer">
																		{line.supplier || line.item_url}
																	</a>
																{:else}
																	{line.supplier ?? ''}
																{/if}
															</td>
															<td class="num" class:negative={line.type === 'discount' || line.type === 'refund'}>
																{#if line.total_cost == null}
																	—
																{:else}
																	{line.type === 'discount' || line.type === 'refund' ? '-' : ''}{formatCurrency(line.total_cost)}
																{/if}
															</td>
														</tr>
													{/each}
												</tbody>
												<tfoot>
													<tr>
														<td colspan="6">Total</td>
														<td class="num">{t.total_cost != null ? formatCurrency(t.total_cost) : '—'}</td>
													</tr>
												</tfoot>
											</table>
											{#if lines.every((line) => line.unit_cost == null)}
												<p class="muted mode-note">Recorded as one total for the whole purchase.</p>
											{/if}
										{/if}
									</div>
								</td>
							</tr>
						{/if}

						{#if canEdit && openId === t.id && openMode === 'edit'}
							<tr class="panel-row">
								<td colspan={colCount}>
									<div class="money-panel" transition:slide={{ duration: 150 }}>
										{#if t.type === 'bulk'}
											<BulkTransactionForm
												action={`/api/transactions/${t.id}/update-bulk`}
												parent={t}
												lines={lines}
												submitLabel="Save"
												onSaved={(result) => handleBulkSaved(t.id, result)}
												onCancel={cancelEdit}
											/>
										{:else}
											<form method="POST" action={`/api/transactions/${t.id}/update`} onsubmit={(e) => handleSave(e, t.id)}>
												<div class="panel-grid">
													<label class="field">
														<span class="field-label">Date</span>
														<input type="date" name="transactionDate" bind:value={editingDate} required />
													</label>
													<label class="field">
														<span class="field-label">Type</span>
														<select name="type" bind:value={editingType}>
															{#each SINGLE_TYPES as value (value)}
																<option {value}>{TYPE_LABELS[value]}</option>
															{/each}
														</select>
													</label>
													<label class="field">
														<span class="field-label">{editingType === 'payment' ? 'Paid by' : 'Recorded by'}</span>
														<select
															name="partyId"
															bind:value={editingPartyId}
															onchange={(e) => onEditPartyChange(e.currentTarget.value)}
														>
															{#each parties as party (party.id)}
																<option value={party.id}>{partyOptionLabel(party)}</option>
															{/each}
														</select>
													</label>

													{#if editingType === 'payment'}
														<label class="field">
															<span class="field-label">Paid to</span>
															<select name="relatedPartyId" bind:value={editingRelatedPartyId} required>
																<option value="" disabled>Select member…</option>
																{#each parties.filter((p) => p.id !== editingPartyId) as party (party.id)}
																	<option value={party.id}>{partyOptionLabel(party)}</option>
																{/each}
															</select>
														</label>
													{:else}
														{#if editingType === 'item'}
															<label class="field">
																<span class="field-label">
																	From BOM
																	{#if editingBomId}
																		<button type="button" class="copy-btn" onclick={copyAllToEdit}>copy all</button>
																	{/if}
																</span>
																<select value={editingBomId} onchange={(e) => pickEditBom(e.currentTarget.value)}>
																	<option value="">Custom item</option>
																	{#each bomState.items as item (item.id)}
																		<option value={item.id}>{item.part_name}</option>
																	{/each}
																</select>
															</label>
														{/if}
														<label class="field">
															<span class="field-label">
																Item
																{#if editingBomId && editingType === 'item'}
																	<button type="button" class="copy-btn" onclick={() => copyToEdit('itemName')}>copy</button>
																{/if}
															</span>
															<input
																type="text"
																name="itemName"
																bind:value={editingItemName}
																placeholder="Item name"
																maxlength="200"
																disabled={editingType !== 'item'}
															/>
														</label>
													{/if}

													{#if editingType === 'item'}
														<label class="field">
															<span class="field-label">
																Quantity
																{#if editingBomId}
																	<button type="button" class="copy-btn" onclick={() => copyToEdit('quantity')}>copy</button>
																{/if}
															</span>
															<input type="number" step="any" min="0" name="quantity" bind:value={editingQuantity} />
														</label>
														<label class="field">
															<span class="field-label">
																Unit
																{#if editingBomId}
																	<button type="button" class="copy-btn" onclick={() => copyToEdit('unit')}>copy</button>
																{/if}
															</span>
															<input type="text" name="unit" bind:value={editingUnit} placeholder="e.g. pcs" maxlength="50" />
														</label>
													{/if}

													<label class="field">
														<span class="field-label">
															{editingType === 'item' ? 'Unit cost' : 'Amount'}
															{#if editingBomId && editingType === 'item'}
																<button type="button" class="copy-btn" onclick={() => copyToEdit('unitCost')}>copy</button>
															{/if}
															{#if editDues > 0}
																<button
																	type="button"
																	class="copy-btn"
																	title={`Settle ${partyName(editingPartyId)}'s remaining dues`}
																	onclick={() => (editingUnitCost = String(editDues))}
																>all dues</button>
															{/if}
														</span>
														<input
															type="number"
															step="any"
															min="0"
															name="unitCost"
															bind:value={editingUnitCost}
															placeholder={unitCostPlaceholder(editingType)}
															required
														/>
													</label>

													{#if editingType !== 'payment'}
														<label class="field">
															<span class="field-label">
																Supplier
																{#if editingBomId && editingType === 'item'}
																	<button type="button" class="copy-btn" onclick={() => copyToEdit('supplier')}>copy</button>
																{/if}
															</span>
															<input
																type="text"
																name="supplier"
																bind:value={editingSupplier}
																placeholder="Supplier name"
																maxlength="200"
															/>
														</label>
														<label class="field field-wide">
															<span class="field-label">
																Supplier link
																{#if editingBomId && editingType === 'item'}
																	<button type="button" class="copy-btn" onclick={() => copyToEdit('itemUrl')}>copy</button>
																{/if}
															</span>
															<input type="url" name="itemUrl" bind:value={editingItemUrl} placeholder="https://…" />
														</label>
													{/if}
												</div>

												{#if rowError?.id === t.id}<p class="panel-error">{rowError.message}</p>{/if}

												<div class="panel-actions">
													<button type="submit" disabled={savingId === t.id}>{savingId === t.id ? 'Saving…' : 'Save'}</button>
													<button type="button" class="btn-plain" onclick={cancelEdit}>Cancel</button>
												</div>
											</form>
										{/if}
									</div>
								</td>
							</tr>
						{/if}

						{#if rowError?.id === t.id && !(openId === t.id && openMode === 'edit')}
							<tr class="row-error">
								<td colspan={colCount}>{rowError.message}</td>
							</tr>
						{/if}
					{/each}
				</tbody>
				<tfoot>
					<tr class="total-row">
						<td colspan="7">Net total</td>
						<td class="num">{formatCurrency(netTotal)}</td>
						<td></td>
						{#if canEdit}<td></td>{/if}
					</tr>
				</tfoot>
			</table>
		</div>
	{/if}

	{#if canEdit}
		<div class="add-area">
			<form method="POST" action={`/api/projects/${projectId}/transactions/create`} onsubmit={handleAddSubmit} class="add-form">
				{#if showAddForm}
					<div class="money-panel add-panel" transition:slide={{ duration: 150 }} onoutroend={() => (addButtonVisible = true)}>
						<div class="panel-grid">
							<label class="field">
								<span class="field-label">Date</span>
								<input type="date" name="transactionDate" required bind:value={addTransactionDate} />
							</label>
							<label class="field">
								<span class="field-label">Type</span>
								<select name="type" bind:value={addType}>
									{#each SINGLE_TYPES as value (value)}
										<option {value}>{TYPE_LABELS[value]}</option>
									{/each}
								</select>
							</label>
							<label class="field">
								<span class="field-label">{addType === 'payment' ? 'Paid by' : 'Recorded by'}</span>
								<select
									name="partyId"
									required
									bind:value={addPartyId}
									onchange={(e) => onAddPartyChange(e.currentTarget.value)}
								>
									<option value="" disabled>Select member…</option>
									{#each parties as party (party.id)}
										<option value={party.id}>{partyOptionLabel(party)}</option>
									{/each}
								</select>
							</label>

							{#if addType === 'payment'}
								<label class="field">
									<span class="field-label">Paid to</span>
									<select name="relatedPartyId" required bind:value={addRelatedPartyId}>
										<option value="" disabled>Select member…</option>
										{#each parties.filter((p) => p.id !== addPartyId) as party (party.id)}
											<option value={party.id}>{partyOptionLabel(party)}</option>
										{/each}
									</select>
								</label>
							{:else}
								{#if addType === 'item'}
									<label class="field">
										<span class="field-label">
											From BOM
											{#if addBomId}
												<button type="button" class="copy-btn" onclick={copyAllToAdd}>copy all</button>
											{/if}
										</span>
										<select value={addBomId} onchange={(e) => pickAddBom(e.currentTarget.value)}>
											<option value="">Custom item</option>
											{#each bomState.items as item (item.id)}
												<option value={item.id}>{item.part_name}</option>
											{/each}
										</select>
									</label>
								{/if}
								<label class="field">
									<span class="field-label">
										Item
										{#if addBomId && addType === 'item'}
											<button type="button" class="copy-btn" onclick={() => copyToAdd('itemName')}>copy</button>
										{/if}
									</span>
									<input
										type="text"
										name="itemName"
										placeholder="Item name"
										maxlength="200"
										disabled={addType !== 'item'}
										bind:value={addItemName}
									/>
								</label>
							{/if}

							{#if addType === 'item'}
								<label class="field">
									<span class="field-label">
										Quantity
										{#if addBomId}
											<button type="button" class="copy-btn" onclick={() => copyToAdd('quantity')}>copy</button>
										{/if}
									</span>
									<input type="number" step="any" min="0" name="quantity" placeholder="Qty" bind:value={addQuantity} />
								</label>
								<label class="field">
									<span class="field-label">
										Unit
										{#if addBomId}
											<button type="button" class="copy-btn" onclick={() => copyToAdd('unit')}>copy</button>
										{/if}
									</span>
									<input type="text" name="unit" placeholder="e.g. pcs" maxlength="50" bind:value={addUnit} />
								</label>
							{/if}

							<label class="field">
								<span class="field-label">
									{addType === 'item' ? 'Unit cost' : 'Amount'}
									{#if addBomId && addType === 'item'}
										<button type="button" class="copy-btn" onclick={() => copyToAdd('unitCost')}>copy</button>
									{/if}
									{#if addDues > 0}
										<button
											type="button"
											class="copy-btn"
											title={`Settle ${partyName(addPartyId)}'s remaining dues`}
											onclick={() => (addUnitCost = String(addDues))}
										>all dues</button>
									{/if}
								</span>
								<input
									type="number"
									step="any"
									min="0"
									name="unitCost"
									placeholder={unitCostPlaceholder(addType)}
									required
									bind:value={addUnitCost}
								/>
							</label>

							{#if addType !== 'payment'}
								<label class="field">
									<span class="field-label">
										Supplier
										{#if addBomId && addType === 'item'}
											<button type="button" class="copy-btn" onclick={() => copyToAdd('supplier')}>copy</button>
										{/if}
									</span>
									<input type="text" name="supplier" placeholder="Supplier name" maxlength="200" bind:value={addSupplier} />
								</label>
								<label class="field field-wide">
									<span class="field-label">
										Supplier link
										{#if addBomId && addType === 'item'}
											<button type="button" class="copy-btn" onclick={() => copyToAdd('itemUrl')}>copy</button>
										{/if}
									</span>
									<input type="url" name="itemUrl" placeholder="https://…" bind:value={addItemUrl} />
								</label>
							{/if}
						</div>

						{#if addError}<p class="panel-error">{addError}</p>{/if}
					</div>
				{/if}

				<!-- Driven by addButtonVisible rather than showAddForm so the row stays put
				     while the panel slides shut, then swaps back to the idle buttons. -->
				{#if !addButtonVisible && !showBulkForm}
					<div class="add-form-actions">
						<button type="submit" disabled={adding}>{adding ? 'Adding…' : 'Add transaction'}</button>
						<button type="button" class="btn-plain" onclick={closeAddForm}>Cancel</button>
					</div>
				{/if}
			</form>

			{#if showBulkForm}
				<div class="money-panel add-panel" transition:slide={{ duration: 150 }} onoutroend={() => (addButtonVisible = true)}>
					<BulkTransactionForm
						action={`/api/projects/${projectId}/transactions/create-bulk`}
						onSaved={handleBulkAdded}
						onCancel={closeBulkForm}
					/>
				</div>
			{/if}

			{#if addButtonVisible}
				<div class="add-form-actions">
					<button type="button" class="btn-plain" onclick={openAddForm}>Add transaction</button>
					<button type="button" class="btn-plain" onclick={openBulkForm}>Add bulk transaction</button>
				</div>
			{/if}
		</div>
	{/if}
</section>

<style>
	.date-cell {
		color: var(--color-muted);
		font-variant-numeric: tabular-nums;
	}

	.type-tag {
		font-size: 0.7rem;
		letter-spacing: 0.03em;
		text-transform: uppercase;
	}

	.type-discount,
	.type-refund {
		color: var(--color-role-viewer);
	}

	.type-payment {
		color: var(--color-role-auditor);
	}

	.type-bulk {
		color: var(--color-role-editor);
	}

	.type-shipping {
		color: var(--color-muted);
	}

	.negative {
		color: var(--color-role-viewer);
	}

	.line-count {
		color: var(--color-muted);
	}

	.bulk-lines {
		margin-top: var(--space-3);
	}

	.mode-note {
		font-size: 0.72rem;
		margin: var(--space-2) 0 0;
	}

	/* .copy-btn lives in global.css — the bulk form is a separate component and needs
	   the same button. */

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

	/* Pinned for the same reason as BomTable's copy — see the note there. */
	.sr-only {
		position: absolute;
		top: 0;
		left: 0;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
