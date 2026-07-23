<script lang="ts">
	import { slide } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { formatCurrency, initCurrency } from '../lib/currency.svelte';

	type TransactionType = 'item' | 'shipping' | 'discount' | 'refund';

	interface Transaction {
		id: string;
		transaction_date: string;
		type: TransactionType;
		item_name: string | null;
		quantity: number | null;
		unit: string | null;
		unit_cost: number | null;
		total_cost: number | null;
		member_id: string;
		profiles: { display_name: string } | null;
	}

	interface Member {
		id: string;
		displayName: string;
		contributionPercent: number | null;
	}

	let {
		projectId,
		members,
		transactions,
		canEdit,
	}: {
		projectId: string;
		members: Member[];
		transactions: Transaction[];
		canEdit: boolean;
	} = $props();

	let percents = $state<Record<string, number>>(
		Object.fromEntries(members.map((m) => [m.id, m.contributionPercent ?? 100 / members.length])),
	);

	let editingPercents = $state(false);
	let draftPercents = $state<Record<string, number>>({ ...percents });
	let saving = $state(false);
	let rowError = $state<string | null>(null);
	let expanded = $state(false);

	// The last member column is the remainder: it's never directly edited, it's always
	// whatever makes the other members' percentages add up to 100 — so the total can
	// never be wrong by construction, no cross-field validation needed. Kept at full
	// float precision (only rounded for display) so the underlying math stays accurate.
	let remainderMember = $derived(members[members.length - 1]);
	let editableMembers = $derived(members.slice(0, -1));
	let remainderPercent = $derived(100 - editableMembers.reduce((sum, m) => sum + (draftPercents[m.id] ?? 0), 0));
	let remainderValid = $derived(remainderPercent >= 0 && remainderPercent <= 100);

	const TYPE_LABELS: Record<TransactionType, string> = {
		item: 'Item',
		shipping: 'Shipping',
		discount: 'Discount',
		refund: 'Refund',
	};

	function signedAmount(t: Transaction): number {
		const total = t.total_cost ?? 0;
		return t.type === 'discount' || t.type === 'refund' ? -total : total;
	}

	let netTotal = $derived(transactions.reduce((sum, t) => sum + signedAmount(t), 0));

	function contributionAmount(memberId: string): number {
		return (netTotal * (percents[memberId] ?? 0)) / 100;
	}

	function spentByMember(memberId: string): number {
		return transactions.filter((t) => t.member_id === memberId).reduce((sum, t) => sum + signedAmount(t), 0);
	}

	function dues(memberId: string): number {
		return contributionAmount(memberId) - spentByMember(memberId);
	}

	function transactionsFor(memberId: string): Transaction[] {
		return transactions
			.filter((t) => t.member_id === memberId)
			.slice()
			.sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
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

		percents = { ...percents, ...fullDraft };
		saving = false;
		editingPercents = false;
	}

	onMount(() => {
		initCurrency();
	});
</script>

<h2>Member contributions</h2>

{#if members.length === 0}
	<p class="muted">No members yet.</p>
{:else}
	<div class="table-scroll">
	<table>
		<colgroup>
			<col style="width:140px" />
			{#each members as member (member.id)}
				<col style="width:160px" />
			{/each}
			{#if canEdit}
				<col style="width:190px" />
			{/if}
		</colgroup>
		<thead>
			<tr>
				<th></th>
				{#each members as member (member.id)}
					<th>{member.displayName}</th>
				{/each}
				{#if canEdit}<th></th>{/if}
			</tr>
		</thead>
		<tbody>
			<tr>
				<td>Contribution (%)</td>
				{#each members as member (member.id)}
					<td>
						{#if editingPercents && member.id === remainderMember.id}
							<span
								class="remainder-value"
								class:invalid={!remainderValid}
								title="Automatically calculated so all members add up to 100%"
							>
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
							{(percents[member.id] ?? 0).toFixed(2)}%
						{/if}
					</td>
				{/each}
				{#if canEdit}
					<td class="actions-cell">
						<div class="row-actions">
							{#if editingPercents}
								<button type="button" onclick={savePercents} disabled={saving || !remainderValid}>{saving ? 'Saving…' : 'Save'}</button>
								<button type="button" class="btn-plain" onclick={cancelEditPercents} disabled={saving}>Cancel</button>
								<button
									type="button"
									class="btn-plain icon-btn"
									onclick={resetToEqualSplit}
									disabled={saving}
									title="Reset to equal split"
									aria-label="Reset to equal split"
								>
									↺
								</button>
							{:else}
								<button type="button" class="btn-plain" onclick={startEditPercents}>Edit</button>
							{/if}
						</div>
					</td>
				{/if}
			</tr>
			<tr>
				<td>Contribution</td>
				{#each members as member (member.id)}
					<td>{formatCurrency(contributionAmount(member.id))}</td>
				{/each}
				{#if canEdit}<td></td>{/if}
			</tr>
			<tr class="dues-row">
				<td>Dues</td>
				{#each members as member (member.id)}
					<td class:dues-owed={dues(member.id) > 0} class:dues-credit={dues(member.id) < 0}>
						{formatCurrency(dues(member.id))}
					</td>
				{/each}
				{#if canEdit}<td></td>{/if}
			</tr>
			<tr class="toggle-row">
				<td colspan={members.length + (canEdit ? 2 : 1)}>
					<button type="button" class="btn-plain" onclick={() => (expanded = !expanded)}>
						{expanded ? '▲ Hide transactions' : '▼ Show transactions'}
					</button>
				</td>
			</tr>
			{#if expanded}
				<tr class="detail-row">
					<td class="detail-label"></td>
					{#each members as member (member.id)}
						<td class="detail-cell">
							<div class="member-column" transition:slide={{ duration: 150 }}>
								{#each transactionsFor(member.id) as t (t.id)}
									<div class="txn-entry">
										<span class="txn-date">{t.transaction_date}</span>
										<span class="txn-label">{t.type === 'item' ? (t.item_name ?? TYPE_LABELS[t.type]) : TYPE_LABELS[t.type]}</span>
										<span class="txn-amount">
											{t.type === 'discount' || t.type === 'refund' ? '-' : ''}{t.total_cost != null ? formatCurrency(t.total_cost) : ''}
										</span>
									</div>
								{:else}
									<p class="muted">No transactions.</p>
								{/each}
							</div>
						</td>
					{/each}
					{#if canEdit}<td class="detail-cell"></td>{/if}
				</tr>
			{/if}
		</tbody>
	</table>
	</div>
	{#if rowError}<p class="row-error">{rowError}</p>{/if}
{/if}

<style>
	.table-scroll table {
		table-layout: fixed;
		font-size: 0.85rem;
	}

	.table-scroll th,
	.table-scroll td {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.table-scroll td input {
		width: 100px;
		box-sizing: border-box;
		padding: 2px var(--space-2);
	}

	.dues-row .dues-owed {
		color: var(--color-danger);
	}

	.dues-row .dues-credit {
		color: var(--color-role-editor);
	}

	.toggle-row td {
		border-top: 1px solid var(--color-border);
		padding-top: var(--space-2);
	}

	.remainder-value {
		color: var(--color-muted);
		font-style: italic;
	}

	.remainder-value.invalid {
		color: var(--color-danger);
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

	.icon-btn {
		padding: 2px var(--space-1);
		line-height: 1;
	}

	.detail-row td {
		vertical-align: top;
		white-space: normal;
		overflow: visible;
		text-overflow: clip;
	}

	.detail-cell {
		padding-top: var(--space-2);
	}

	.member-column {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
		overflow: hidden;
	}

	.txn-entry {
		display: flex;
		flex-direction: column;
		font-size: 0.8rem;
		padding: var(--space-1) 0;
		border-bottom: 1px dashed var(--color-border);
	}

	.txn-date {
		color: var(--color-muted);
	}

	.txn-label {
		overflow-wrap: break-word;
		word-break: break-word;
	}

	.row-error {
		color: var(--color-danger);
	}
</style>
