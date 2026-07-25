<script lang="ts">
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import { formatCurrency, initCurrency } from '../lib/currency.svelte';
	import { netSpend } from '../lib/money-math';
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

	// One row panel at a time — read-only detail or the edit form, never both.
	let openId = $state<string | null>(null);
	let openMode = $state<'detail' | 'edit'>('detail');

	let savingId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

	let adding = $state(false);
	let addError = $state<string | null>(null);
	let showAddForm = $state(false);
	let addButtonVisible = $state(true);
	let addType = $state<TransactionType>('item');
	let addTransactionDate = $state('');
	let addItemName = $state('');
	let addQuantity = $state('');
	let addUnit = $state('');
	let addUnitCost = $state('');
	let addMemberId = $state('');
	let addRelatedMemberId = $state('');

	let editingType = $state<TransactionType>('item');
	let editingMemberId = $state('');
	let editingRelatedMemberId = $state('');

	const TYPE_LABELS: Record<TransactionType, string> = {
		item: 'Item',
		shipping: 'Shipping',
		discount: 'Discount',
		refund: 'Refund',
		payment: 'Payment',
	};

	let colCount = $derived(canEdit ? 9 : 8);

	function unitCostPlaceholder(type: TransactionType): string {
		return type === 'item' ? 'Unit cost' : 'Amount';
	}

	function memberName(id: string | null, profile: { display_name: string } | null = null): string {
		if (!id) return '—';
		return profile?.display_name ?? members.find((m) => m.id === id)?.displayName ?? 'Unknown';
	}

	// Newest date first, and the first row of each date carries a rule above it —
	// the Date column is still present per row, so a full-width date banner would
	// just be the same string twice.
	let rows = $derived.by(() => {
		const sorted = [...transactionsState.items].sort((a, b) => b.transaction_date.localeCompare(a.transaction_date));
		return sorted.map((t, i) => ({
			t,
			isGroupStart: i === 0 || sorted[i - 1].transaction_date !== t.transaction_date,
		}));
	});

	let netTotal = $derived(netSpend(transactionsState.items));

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

	function startEdit(t: Transaction) {
		if (openId === t.id && openMode === 'edit') {
			openId = null;
			return;
		}
		openId = t.id;
		openMode = 'edit';
		editingType = t.type;
		editingMemberId = t.member_id;
		editingRelatedMemberId = t.related_member_id ?? '';
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
		if (openId === id) openId = null;
		deletingId = null;
	}

	function openAddForm() {
		showAddForm = true;
		addButtonVisible = false;
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

		addTransaction(await res.json());
		form.reset();
		addType = 'item';
		addTransactionDate = '';
		addItemName = '';
		addQuantity = '';
		addUnit = '';
		addUnitCost = '';
		addMemberId = '';
		addRelatedMemberId = '';
		showAddForm = false;
		adding = false;
	}
</script>

<section class="money-section">
	<div class="money-section-head">
		<h2>Transactions</h2>
		<span class="section-meta">
			{transactionsState.items.length} entr{transactionsState.items.length === 1 ? 'y' : 'ies'} · net
			<strong>{formatCurrency(netTotal)}</strong>
		</span>
	</div>

	{#if transactionsState.items.length === 0}
		<p class="muted empty">No transactions yet.</p>
	{:else}
		<div class="money-table">
			<table>
				<colgroup>
					<col style="width:92px" />
					<col style="width:78px" />
					<col style="width:170px" />
					<col style="width:50px" />
					<col style="width:66px" />
					<col style="width:92px" />
					<col style="width:96px" />
					<col style="width:120px" />
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
						<th class="num">Total</th>
						<th>By</th>
						{#if canEdit}<th><span class="sr-only">Actions</span></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.t.id)}
						{@const t = row.t}
						<tr
							class="data-row clickable"
							class:group-start={row.isGroupStart}
							class:open={openId === t.id}
							onclick={(e) => handleRowClick(e, t.id)}
						>
							<td class="date-cell">{t.transaction_date}</td>
							<td><span class={`type-tag type-${t.type}`}>{TYPE_LABELS[t.type]}</span></td>
							<td>{t.item_name ?? ''}</td>
							<td class="num">{t.type === 'item' ? (t.quantity ?? '') : ''}</td>
							<td>{t.unit ?? ''}</td>
							<td class="num">{t.type === 'item' && t.unit_cost != null ? formatCurrency(t.unit_cost) : ''}</td>
							<td class="num" class:negative={t.type === 'discount' || t.type === 'refund'}>
								{t.type === 'discount' || t.type === 'refund' ? '-' : ''}{t.total_cost != null ? formatCurrency(t.total_cost) : ''}
							</td>
							<td>{memberName(t.member_id, t.profiles)}</td>
							{#if canEdit}
								<td class="actions-cell">
									<div class="row-actions">
										<button type="button" class="btn-plain" onclick={() => startEdit(t)}>Edit</button>
										<button type="button" class="btn-danger" onclick={() => handleDelete(t.id)} disabled={deletingId === t.id}>
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
												<span class="field-label">{t.type === 'payment' ? 'Paid to' : 'Item'}</span>
												<span class="field-value">
													{t.type === 'payment' ? memberName(t.related_member_id) : t.item_name || '—'}
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
												<span class="field-value">{memberName(t.member_id, t.profiles)}</span>
											</div>
										</div>
									</div>
								</td>
							</tr>
						{/if}

						{#if canEdit && openId === t.id && openMode === 'edit'}
							<tr class="panel-row">
								<td colspan={colCount}>
									<div class="money-panel" transition:slide={{ duration: 150 }}>
										<form method="POST" action={`/api/transactions/${t.id}/update`} onsubmit={(e) => handleSave(e, t.id)}>
											<div class="panel-grid">
												<label class="field">
													<span class="field-label">Date</span>
													<input type="date" name="transactionDate" value={t.transaction_date} required />
												</label>
												<label class="field">
													<span class="field-label">Type</span>
													<select name="type" bind:value={editingType}>
														{#each Object.entries(TYPE_LABELS) as [value, label] (value)}
															<option {value}>{label}</option>
														{/each}
													</select>
												</label>
												<label class="field">
													<span class="field-label">{editingType === 'payment' ? 'Paid by' : 'Recorded by'}</span>
													<select name="memberId" bind:value={editingMemberId}>
														{#each members as member (member.id)}
															<option value={member.id}>{member.displayName}</option>
														{/each}
													</select>
												</label>

												{#if editingType === 'payment'}
													<label class="field">
														<span class="field-label">Paid to</span>
														<select name="relatedMemberId" bind:value={editingRelatedMemberId} required>
															<option value="" disabled>Select member…</option>
															{#each members.filter((m) => m.id !== editingMemberId) as member (member.id)}
																<option value={member.id}>{member.displayName}</option>
															{/each}
														</select>
													</label>
												{:else}
													<label class="field">
														<span class="field-label">Item</span>
														<input
															type="text"
															name="itemName"
															value={t.item_name ?? ''}
															placeholder="Item name"
															maxlength="200"
															disabled={editingType !== 'item'}
														/>
													</label>
												{/if}

												{#if editingType === 'item'}
													<label class="field">
														<span class="field-label">Quantity</span>
														<input type="number" step="any" min="0" name="quantity" value={t.quantity ?? ''} />
													</label>
													<label class="field">
														<span class="field-label">Unit</span>
														<input type="text" name="unit" value={t.unit ?? ''} placeholder="e.g. pcs" maxlength="50" />
													</label>
												{/if}

												<label class="field">
													<span class="field-label">{editingType === 'item' ? 'Unit cost' : 'Amount'}</span>
													<input
														type="number"
														step="any"
														min="0"
														name="unitCost"
														value={t.unit_cost ?? ''}
														placeholder={unitCostPlaceholder(editingType)}
														required
													/>
												</label>
											</div>

											{#if rowError?.id === t.id}<p class="panel-error">{rowError.message}</p>{/if}

											<div class="panel-actions">
												<button type="submit" disabled={savingId === t.id}>{savingId === t.id ? 'Saving…' : 'Save'}</button>
												<button type="button" class="btn-plain" onclick={cancelEdit}>Cancel</button>
											</div>
										</form>
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
						<td colspan="6">Net total</td>
						<td class="num">{formatCurrency(netTotal)}</td>
						<td></td>
						{#if canEdit}<td></td>{/if}
					</tr>
				</tfoot>
			</table>
		</div>
	{/if}

	{#if canEdit}
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
								{#each Object.entries(TYPE_LABELS) as [value, label] (value)}
									<option {value}>{label}</option>
								{/each}
							</select>
						</label>
						<label class="field">
							<span class="field-label">{addType === 'payment' ? 'Paid by' : 'Recorded by'}</span>
							<select name="memberId" required bind:value={addMemberId}>
								<option value="" disabled>Select member…</option>
								{#each members as member (member.id)}
									<option value={member.id}>{member.displayName}</option>
								{/each}
							</select>
						</label>

						{#if addType === 'payment'}
							<label class="field">
								<span class="field-label">Paid to</span>
								<select name="relatedMemberId" required bind:value={addRelatedMemberId}>
									<option value="" disabled>Select member…</option>
									{#each members.filter((m) => m.id !== addMemberId) as member (member.id)}
										<option value={member.id}>{member.displayName}</option>
									{/each}
								</select>
							</label>
						{:else}
							<label class="field">
								<span class="field-label">Item</span>
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
								<span class="field-label">Quantity</span>
								<input type="number" step="any" min="0" name="quantity" placeholder="Qty" bind:value={addQuantity} />
							</label>
							<label class="field">
								<span class="field-label">Unit</span>
								<input type="text" name="unit" placeholder="e.g. pcs" maxlength="50" bind:value={addUnit} />
							</label>
						{/if}

						<label class="field">
							<span class="field-label">{addType === 'item' ? 'Unit cost' : 'Amount'}</span>
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
					</div>

					{#if addError}<p class="panel-error">{addError}</p>{/if}
				</div>
			{/if}

			<div class="add-form-actions">
				{#if addButtonVisible}
					<button type="button" class="btn-plain" onclick={openAddForm}>Add transaction</button>
				{:else}
					<button type="submit" disabled={adding}>{adding ? 'Adding…' : 'Add transaction'}</button>
					<button type="button" class="btn-plain" onclick={closeAddForm}>Cancel</button>
				{/if}
			</div>
		</form>
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

	.type-shipping {
		color: var(--color-muted);
	}

	.negative {
		color: var(--color-role-viewer);
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
