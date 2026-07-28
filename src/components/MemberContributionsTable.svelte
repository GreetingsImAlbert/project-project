<script lang="ts">
	import { slide } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { formatCurrency, initCurrency } from '../lib/currency.svelte';
	import { transactionsState, initTransactions, type Transaction, type TransactionType } from '../lib/transactions-store.svelte';
	import { contributionsState, initContributions, setContributionPercents } from '../lib/contributions-store.svelte';
	import { netSpend, paidByMember, entryAmount, topLevel, resolveContributionPercents } from '../lib/money-math';

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
	initContributions(resolveContributionPercents(members));

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
		bulk: 'Bulk',
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

	// The footer used to hardcode 100% / net / net / 0, which quietly told the wrong
	// story whenever the stored shares didn't actually add up (a member added after the
	// split was saved sits at 0%, a removed one leaves their share unassigned). It now
	// sums the rows above it, and says so when the total isn't 100%.
	let totalPercent = $derived(members.reduce((sum, member) => sum + (percents[member.id] ?? 0), 0));
	let totalOwed = $derived(members.reduce((sum, member) => sum + contributionAmount(member.id), 0));
	let totalPaid = $derived(members.reduce((sum, member) => sum + paid(member.id), 0));
	// Snapped to cents, and `|| 0` turns the -0 a balanced group lands on into plain 0 —
	// Intl formats negative zero with the sign, so the footer would read '-0.00'.
	let totalDues = $derived((Math.round((totalOwed - totalPaid) * 100) || 0) / 100);
	// Half a display cent of slack — the shares are kept at full float precision, so an
	// exactly-100 split can still sum to 99.99999999999999.
	let splitBalanced = $derived(Math.abs(totalPercent - 100) < 0.005);

	// Whether a member has a *stored* share, which the resolved percent can't tell you:
	// someone sitting at 0% because they joined after the split was saved needs pointing
	// out, someone deliberately set to 0% does not. Seeded from the SSR prop and extended
	// on save, since the prop doesn't refresh without a reload.
	let assignedIds = $state(members.filter((m) => m.contributionPercent != null).map((m) => m.id));
	let unassignedMembers = $derived(
		assignedIds.length > 0 ? members.filter((m) => !assignedIds.includes(m.id)) : [],
	);

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

	// topLevel first: a bulk transaction belongs in a member's history once, as the
	// parent row that carries the amount, not again as each of its lines.
	function transactionsFor(memberId: string): Transaction[] {
		return topLevel(transactionsState.items)
			.filter((t) => t.member_id === memberId || t.related_member_id === memberId)
			.slice()
			.sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
	}

	// The embedded profile is the payer's (transactions embed member_id's profile), so it
	// stands in for a payer who has since left the members list.
	function payerName(t: Transaction): string {
		return t.profiles?.display_name ?? members.find((m) => m.id === t.member_id)?.displayName ?? 'a member';
	}

	function entryLabel(t: Transaction, memberId: string): string {
		if (t.type === 'payment') {
			return t.member_id === memberId ? (t.item_name ?? 'Payment') : `Received from ${payerName(t)}`;
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
		// Members with nothing stored yet are written even when their resolved 0% already
		// matches the draft — otherwise saving the split would leave them unassigned and
		// the notice below would never clear.
		const changed = members.filter((m) => fullDraft[m.id] !== percents[m.id] || !assignedIds.includes(m.id));

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
		// Every member now has a stored share — the loop above wrote the ones that didn't.
		assignedIds = members.map((m) => m.id);
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
						<td class="num" class:unbalanced={!splitBalanced}>{totalPercent.toFixed(2)}%</td>
						<td class="num">{formatCurrency(totalOwed)}</td>
						<td class="num">{formatCurrency(totalPaid)}</td>
						<td class="num">{formatCurrency(totalDues)}</td>
					</tr>
				</tfoot>
			</table>
		</div>

		{#if !splitBalanced}
			<p class="split-warning">
				Shares add up to {totalPercent.toFixed(2)}%, not 100% — the split is out of date, so each member's
				share of the net spend is off.
				{#if canEdit}
					Edit the split and save it to rebalance.
				{:else}
					Ask the project owner to update it.
				{/if}
			</p>
		{/if}

		{#if unassignedMembers.length > 0}
			<p class="split-note">
				{unassignedMembers.map((m) => m.displayName).join(', ')}
				{unassignedMembers.length === 1 ? 'has' : 'have'} no share in the split yet, so
				{unassignedMembers.length === 1 ? 'it counts' : 'they count'} as 0%.
				{#if canEdit}
					Edit the split to give {unassignedMembers.length === 1 ? 'them' : 'each of them'} one.
				{/if}
			</p>
		{/if}

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

	.money-table .total-row .unbalanced {
		color: var(--color-danger);
	}

	.split-warning {
		color: var(--color-danger);
		font-size: 0.78rem;
		margin: 0 0 var(--space-2);
	}

	/* Not an error — a member with no share yet is a normal state, just one worth
	   pointing out, so it stays in the muted voice. */
	.split-note {
		color: var(--color-muted);
		font-size: 0.78rem;
		margin: 0 0 var(--space-2);
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

	/* .sub-table / .sub-date / .sub-item live in global.css — TransactionsTable's bulk
	   breakdown is a separate island and needs the same look. */

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
