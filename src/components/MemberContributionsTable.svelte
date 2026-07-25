<script lang="ts">
	import { slide } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { formatCurrency, initCurrency } from '../lib/currency.svelte';
	import { transactionsState, initTransactions, type Transaction, type TransactionType } from '../lib/transactions-store.svelte';
	import { contributionsState, initContributions, setContributionPercents } from '../lib/contributions-store.svelte';
	import { netSpend, paidByMember, entryAmount } from '../lib/money-math';

	interface Member {
		id: string;
		displayName: string;
		contributionPercent: number | null;
	}

	let {
		projectId,
		members,
		transactions: initialTransactions,
		canEdit,
	}: {
		projectId: string;
		members: Member[];
		transactions: Transaction[];
		canEdit: boolean;
	} = $props();

	initTransactions(initialTransactions);
	initContributions(Object.fromEntries(members.map((m) => [m.id, m.contributionPercent ?? 100 / members.length])));

	let editingPercents = $state(false);
	let draftPercents = $state<Record<string, number>>({});
	let saving = $state(false);
	let rowError = $state<string | null>(null);
	let expandedId = $state<string | null>(null);

	const TYPE_LABELS: Record<TransactionType, string> = {
		item: 'Item',
		shipping: 'Shipping',
		discount: 'Discount',
		refund: 'Refund',
		payment: 'Payment',
	};

	const colCount = 5;

	let percents = $derived(contributionsState.percents);

	// The last member is the remainder: it's never directly edited, it's always
	// whatever makes the other members' percentages add up to 100 — so the total can
	// never be wrong by construction, no cross-field validation needed. Kept at full
	// float precision (only rounded for display) so the underlying math stays accurate.
	let remainderMember = $derived(members[members.length - 1]);
	let editableMembers = $derived(members.slice(0, -1));
	let remainderPercent = $derived(100 - editableMembers.reduce((sum, m) => sum + (draftPercents[m.id] ?? 0), 0));
	let remainderValid = $derived(remainderPercent >= 0 && remainderPercent <= 100);

	let netTotal = $derived(netSpend(transactionsState.items));

	function displayPercent(memberId: string): number {
		if (editingPercents && memberId === remainderMember?.id) return remainderPercent;
		if (editingPercents) return draftPercents[memberId] ?? 0;
		return percents[memberId] ?? 0;
	}

	function contributionAmount(memberId: string): number {
		return (netTotal * (percents[memberId] ?? 0)) / 100;
	}

	function paid(memberId: string): number {
		return paidByMember(transactionsState.items, memberId);
	}

	function dues(memberId: string): number {
		return contributionAmount(memberId) - paid(memberId);
	}

	function transactionsFor(memberId: string): Transaction[] {
		return transactionsState.items
			.filter((t) => t.member_id === memberId || t.related_member_id === memberId)
			.slice()
			.sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
	}

	function entryLabel(t: Transaction, memberId: string): string {
		if (t.type === 'payment') {
			return t.member_id === memberId ? (t.item_name ?? 'Payment') : 'Payment received';
		}
		return t.item_name || TYPE_LABELS[t.type];
	}

	function toggleExpanded(e: MouseEvent, memberId: string) {
		if ((e.target as HTMLElement).closest('input, button')) return;
		expandedId = expandedId === memberId ? null : memberId;
	}

	function startEditPercents() {
		draftPercents = { ...percents };
		rowError = null;
		editingPercents = true;
	}

	function cancelEditPercents() {
		editingPercents = false;
		rowError = null;
	}

	function resetToEqualSplit() {
		rowError = null;
		draftPercents = Object.fromEntries(editableMembers.map((m) => [m.id, 100 / members.length]));
	}

	function handlePercentInput(memberId: string, value: string) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			draftPercents = { ...draftPercents, [memberId]: parsed };
		}
	}

	async function savePercents() {
		rowError = null;

		for (const member of editableMembers) {
			const value = draftPercents[member.id];
			if (!Number.isFinite(value) || value < 0 || value > 100) {
				rowError = `${member.displayName}: percent must be between 0 and 100`;
				return;
			}
		}

		if (!remainderValid) {
			rowError = `${remainderMember.displayName}'s remainder would be ${remainderPercent.toFixed(2)}% — the other members' percentages must add up to no more than 100%`;
			return;
		}

		const fullDraft = { ...draftPercents, [remainderMember.id]: remainderPercent };
		const changed = members.filter((m) => fullDraft[m.id] !== percents[m.id]);

		saving = true;

		for (const member of changed) {
			const formData = new FormData();
			formData.set('contributionPercent', String(fullDraft[member.id]));

			const res = await fetch(`/api/projects/${projectId}/members/${member.id}/contribution`, {
				method: 'POST',
				body: formData,
			});

			if (!res.ok) {
				rowError = await res.text();
				saving = false;
				return;
			}
		}

		setContributionPercents(fullDraft);
		saving = false;
		editingPercents = false;
	}

	onMount(() => {
		initCurrency();
	});
</script>

<section class="money-section">
	<div class="money-section-head">
		<h2>Member contributions</h2>
		{#if canEdit && members.length > 0}
			<div class="head-actions">
				{#if editingPercents}
					<button type="button" onclick={savePercents} disabled={saving || !remainderValid}>
						{saving ? 'Saving…' : 'Save split'}
					</button>
					<button type="button" class="btn-plain" onclick={cancelEditPercents} disabled={saving}>Cancel</button>
					<button
						type="button"
						class="btn-plain"
						onclick={resetToEqualSplit}
						disabled={saving}
						title="Reset to equal split"
						aria-label="Reset to equal split"
					>↺</button>
				{:else}
					<button type="button" class="btn-plain" onclick={startEditPercents}>Edit split</button>
				{/if}
			</div>
		{/if}
	</div>

	{#if members.length === 0}
		<p class="muted empty">No members yet.</p>
	{:else}
		<div class="money-table">
			<table>
				<colgroup>
					<col style="width:170px" />
					<col style="width:96px" />
					<col style="width:120px" />
					<col style="width:120px" />
					<col style="width:120px" />
				</colgroup>
				<thead>
					<tr>
						<th>Member</th>
						<th class="num">Share</th>
						<th class="num">Owes total</th>
						<th class="num">Paid</th>
						<th class="num">Dues</th>
					</tr>
				</thead>
				<tbody>
					{#each members as member (member.id)}
						{@const memberDues = dues(member.id)}
						<tr class="data-row clickable" class:open={expandedId === member.id} onclick={(e) => toggleExpanded(e, member.id)}>
							<td>
								<span class="caret">{expandedId === member.id ? '▾' : '▸'}</span>{member.displayName}
							</td>
							<td class="num">
								{#if editingPercents && member.id === remainderMember.id}
									<span class="remainder-value" class:invalid={!remainderValid} title="Automatically calculated so all members add up to 100%">
										{remainderPercent.toFixed(2)}%
									</span>
								{:else if editingPercents}
									<input
										type="number"
										step="0.01"
										min="0"
										max="100"
										value={(draftPercents[member.id] ?? 0).toFixed(2)}
										disabled={saving}
										onchange={(e) => handlePercentInput(member.id, (e.currentTarget as HTMLInputElement).value)}
									/>
								{:else}
									{displayPercent(member.id).toFixed(2)}%
								{/if}
							</td>
							<td class="num">{formatCurrency(contributionAmount(member.id))}</td>
							<td class="num">{formatCurrency(paid(member.id))}</td>
							<td class="num" class:dues-owed={memberDues > 0} class:dues-credit={memberDues < 0}>
								{formatCurrency(memberDues)}
							</td>
						</tr>

						{#if expandedId === member.id}
							<tr class="panel-row">
								<td colspan={colCount}>
									<div class="money-panel" transition:slide={{ duration: 150 }}>
										{#if transactionsFor(member.id).length === 0}
											<p class="muted no-txns">No transactions for {member.displayName}.</p>
										{:else}
											<table class="sub-table">
												<colgroup>
													<col style="width:96px" />
													<col style="width:84px" />
													<col />
													<col style="width:110px" />
												</colgroup>
												<thead>
													<tr>
														<th>Date</th>
														<th>Type</th>
														<th>Item</th>
														<th class="num">Amount</th>
													</tr>
												</thead>
												<tbody>
													{#each transactionsFor(member.id) as t (t.id)}
														{@const amount = entryAmount(t, member.id)}
														<tr>
															<td class="sub-date">{t.transaction_date}</td>
															<td>{TYPE_LABELS[t.type]}</td>
															<td class="sub-item">{entryLabel(t, member.id)}</td>
															<td class="num" class:dues-credit={amount < 0}>{formatCurrency(amount)}</td>
														</tr>
													{/each}
												</tbody>
												<tfoot>
													<tr>
														<td colspan="3">Paid</td>
														<td class="num">{formatCurrency(paid(member.id))}</td>
													</tr>
												</tfoot>
											</table>
										{/if}
									</div>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
				<tfoot>
					<tr class="total-row">
						<td>All members</td>
						<td class="num">100.00%</td>
						<td class="num">{formatCurrency(netTotal)}</td>
						<td class="num">{formatCurrency(netTotal)}</td>
						<td class="num">{formatCurrency(0)}</td>
					</tr>
				</tfoot>
			</table>
		</div>

		{#if rowError}<p class="panel-error standalone-error">{rowError}</p>{/if}
	{/if}
</section>

<style>
	.head-actions {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}

	.head-actions button {
		padding: var(--space-1) var(--space-3);
		font-size: 0.8rem;
	}

	.caret {
		display: inline-block;
		width: 1.1em;
		color: var(--color-muted);
	}

	.dues-owed {
		color: var(--color-danger);
	}

	.dues-credit {
		color: var(--color-role-viewer);
	}

	.remainder-value {
		color: var(--color-muted);
		font-style: italic;
	}

	.remainder-value.invalid {
		color: var(--color-danger);
	}

	/* The percent input sits inside a right-aligned numeric cell, so it has to hug
	   the right edge rather than fill the column. */
	.money-table td input {
		width: 100%;
		max-width: 84px;
		box-sizing: border-box;
		padding: 0 var(--space-1);
		font-size: 0.78rem;
		text-align: right;
	}

	.sub-table {
		width: 100%;
		table-layout: fixed;
		border-collapse: collapse;
		margin: 0;
		font-size: 0.76rem;
	}

	.sub-table th,
	.sub-table td {
		padding: 2px var(--space-2);
		border: none;
		border-bottom: 1px dashed var(--color-border);
		vertical-align: top;
	}

	.sub-table thead th {
		background: none;
		border-bottom: 1px solid var(--color-border);
		color: var(--color-muted);
		font-size: 0.66rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.sub-table tfoot td {
		border-bottom: none;
		border-top: 1px solid var(--color-border-strong);
		font-weight: 700;
	}

	.sub-date {
		color: var(--color-muted);
		font-variant-numeric: tabular-nums;
	}

	.sub-item {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.no-txns {
		font-size: 0.78rem;
		margin: 0;
	}

	.standalone-error {
		margin-top: 0;
	}

	.empty {
		font-size: 0.85rem;
	}
</style>
