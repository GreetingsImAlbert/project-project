<script lang="ts">
	import { slide } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { formatCurrency, initCurrency } from '../lib/currency.svelte';
	import { transactionsState, initTransactions, type Transaction, type TransactionType } from '../lib/transactions-store.svelte';
	import { contributionsState, initContributions, setContributionPercents } from '../lib/contributions-store.svelte';
	import { partiesState, initParties, addParty, updateParty, removeParty, type Party } from '../lib/parties-store.svelte';
	import { ghostIdOf, ghostPartyId, partyIdOf, relatedPartyIdOf } from '../lib/money-parties';
	import { netSpend, paidByMember, entryAmount, topLevel, resolveContributionPercents } from '../lib/money-math';

	let {
		projectId,
		initialParties,
		transactions: initialTransactions,
		canEdit,
	}: {
		projectId: string;
		initialParties: Party[];
		transactions: Transaction[];
		canEdit: boolean;
	} = $props();

	initTransactions(initialTransactions);
	initParties(initialParties);
	initContributions(resolveContributionPercents(initialParties));

	// Real members and ghost members share every column of this table — a ghost is just
	// a party the project keeps its own record of, because the person behind it (a
	// commissioner, an outside funder) has no P2 account to be added with.
	let parties = $derived(partiesState.items);

	let editingPercents = $state(false);
	let draftPercents = $state<Record<string, number>>({});
	let saving = $state(false);
	let rowError = $state<string | null>(null);
	let expandedId = $state<string | null>(null);

	let addingGhost = $state(false);
	let ghostName = $state('');
	let ghostNote = $state('');
	let ghostSaving = $state(false);
	let ghostError = $state<string | null>(null);

	let editingGhostId = $state<string | null>(null);
	let editGhostName = $state('');
	let editGhostNote = $state('');
	let deletingGhostId = $state<string | null>(null);

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

	// The last party is the remainder: it's never directly edited, it's always
	// whatever makes the other shares add up to 100 — so the total can never be wrong
	// by construction, no cross-field validation needed. Kept at full float precision
	// (only rounded for display) so the underlying math stays accurate.
	let remainderParty = $derived(parties[parties.length - 1]);
	let editableParties = $derived(parties.slice(0, -1));
	let remainderPercent = $derived(100 - editableParties.reduce((sum, p) => sum + (draftPercents[p.id] ?? 0), 0));
	let remainderValid = $derived(remainderPercent >= 0 && remainderPercent <= 100);

	let netTotal = $derived(netSpend(transactionsState.items));

	// The footer used to hardcode 100% / net / net / 0, which quietly told the wrong
	// story whenever the stored shares didn't actually add up (a member added after the
	// split was saved sits at 0%, a removed one leaves their share unassigned). It now
	// sums the rows above it, and says so when the total isn't 100%.
	let totalPercent = $derived(parties.reduce((sum, party) => sum + (percents[party.id] ?? 0), 0));
	let totalOwed = $derived(parties.reduce((sum, party) => sum + contributionAmount(party.id), 0));
	let totalPaid = $derived(parties.reduce((sum, party) => sum + paid(party.id), 0));
	// Snapped to cents, and `|| 0` turns the -0 a balanced group lands on into plain 0 —
	// Intl formats negative zero with the sign, so the footer would read '-0.00'.
	let totalDues = $derived((Math.round((totalOwed - totalPaid) * 100) || 0) / 100);
	// Half a display cent of slack — the shares are kept at full float precision, so an
	// exactly-100 split can still sum to 99.99999999999999.
	let splitBalanced = $derived(Math.abs(totalPercent - 100) < 0.005);

	// Whether a party has a *stored* share, which the resolved percent can't tell you:
	// someone sitting at 0% because they were added after the split was saved needs
	// pointing out, someone deliberately set to 0% does not. Seeded from the SSR prop
	// and extended on save, since the prop doesn't refresh without a reload.
	let assignedIds = $state(initialParties.filter((p) => p.contributionPercent != null).map((p) => p.id));
	let unassignedParties = $derived(
		assignedIds.length > 0 ? parties.filter((p) => !assignedIds.includes(p.id)) : [],
	);

	function displayPercent(partyId: string): number {
		if (editingPercents && partyId === remainderParty?.id) return remainderPercent;
		if (editingPercents) return draftPercents[partyId] ?? 0;
		return percents[partyId] ?? 0;
	}

	function contributionAmount(partyId: string): number {
		return (netTotal * (percents[partyId] ?? 0)) / 100;
	}

	function paid(partyId: string): number {
		return paidByMember(transactionsState.items, partyId);
	}

	function dues(partyId: string): number {
		return contributionAmount(partyId) - paid(partyId);
	}

	// topLevel first: a bulk transaction belongs in a party's history once, as the
	// parent row that carries the amount, not again as each of its lines.
	function transactionsFor(partyId: string): Transaction[] {
		return topLevel(transactionsState.items)
			.filter((t) => partyIdOf(t) === partyId || relatedPartyIdOf(t) === partyId)
			.slice()
			.sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
	}

	// The embedded name is the payer's own — profiles for a member, ghost_members for a
	// ghost — so it stands in for a payer who has since left the list.
	function payerName(t: Transaction): string {
		return (
			t.profiles?.display_name ??
			t.ghost_members?.display_name ??
			parties.find((p) => p.id === partyIdOf(t))?.displayName ??
			'a member'
		);
	}

	// The payer's own side has no stored label — it's the current payee name, so a
	// rename shows up on every past row instead of freezing whatever name was picked
	// when the row was created.
	function partyDisplayName(id: string | null): string {
		if (!id) return 'a member';
		return parties.find((p) => p.id === id)?.displayName ?? 'a member';
	}

	function entryLabel(t: Transaction, partyId: string): string {
		if (t.type === 'payment') {
			return partyIdOf(t) === partyId
				? `Pay ${partyDisplayName(relatedPartyIdOf(t))}`
				: `Received from ${payerName(t)}`;
		}
		return t.item_name || TYPE_LABELS[t.type];
	}

	function toggleExpanded(e: MouseEvent, partyId: string) {
		if ((e.target as HTMLElement).closest('input, button')) return;
		expandedId = expandedId === partyId ? null : partyId;
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
		draftPercents = Object.fromEntries(editableParties.map((p) => [p.id, 100 / parties.length]));
	}

	function handlePercentInput(partyId: string, value: string) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			draftPercents = { ...draftPercents, [partyId]: parsed };
		}
	}

	// A ghost's share lives on its own row in ghost_members, a member's on their
	// project_members row, so the two halves of the split are saved through different
	// endpoints — same payload either way.
	function contributionUrl(partyId: string): string {
		const ghostId = ghostIdOf(partyId);
		return ghostId
			? `/api/projects/${projectId}/ghost-members/${ghostId}/update`
			: `/api/projects/${projectId}/members/${partyId}/contribution`;
	}

	async function savePercents() {
		rowError = null;

		for (const party of editableParties) {
			const value = draftPercents[party.id];
			if (!Number.isFinite(value) || value < 0 || value > 100) {
				rowError = `${party.displayName}: percent must be between 0 and 100`;
				return;
			}
		}

		if (!remainderValid) {
			rowError = `${remainderParty.displayName}'s remainder would be ${remainderPercent.toFixed(2)}% — the other percentages must add up to no more than 100%`;
			return;
		}

		const fullDraft = { ...draftPercents, [remainderParty.id]: remainderPercent };
		// Parties with nothing stored yet are written even when their resolved 0% already
		// matches the draft — otherwise saving the split would leave them unassigned and
		// the notice below would never clear.
		const changed = parties.filter((p) => fullDraft[p.id] !== percents[p.id] || !assignedIds.includes(p.id));

		saving = true;

		for (const party of changed) {
			const formData = new FormData();
			formData.set('contributionPercent', String(fullDraft[party.id]));

			const res = await fetch(contributionUrl(party.id), { method: 'POST', body: formData });

			if (!res.ok) {
				rowError = await res.text();
				saving = false;
				return;
			}
		}

		setContributionPercents(fullDraft);
		// Every party now has a stored share — the loop above wrote the ones that didn't.
		assignedIds = parties.map((p) => p.id);
		saving = false;
		editingPercents = false;
	}

	function openAddGhost() {
		ghostName = '';
		ghostNote = '';
		ghostError = null;
		addingGhost = true;
	}

	function cancelAddGhost() {
		addingGhost = false;
		ghostError = null;
	}

	async function submitGhost(e: SubmitEvent) {
		e.preventDefault();

		ghostError = null;
		ghostSaving = true;

		const formData = new FormData();
		formData.set('displayName', ghostName);
		formData.set('note', ghostNote);

		const res = await fetch(`/api/projects/${projectId}/ghost-members/create`, { method: 'POST', body: formData });

		if (!res.ok) {
			ghostError = await res.text();
			ghostSaving = false;
			return;
		}

		const created: { id: string; display_name: string; note: string | null; contribution_percent: number | null } =
			await res.json();

		addParty({
			id: ghostPartyId(created.id),
			displayName: created.display_name,
			isGhost: true,
			note: created.note,
			contributionPercent: created.contribution_percent,
		});

		// Deliberately left out of assignedIds: a new ghost has no share until the split
		// is edited and saved, which is exactly what the notice under the table says.
		ghostSaving = false;
		addingGhost = false;
	}

	function startEditGhost(party: Party) {
		editingGhostId = party.id;
		editGhostName = party.displayName;
		editGhostNote = party.note ?? '';
		rowError = null;
	}

	function cancelEditGhost() {
		editingGhostId = null;
	}

	async function saveGhost(party: Party) {
		rowError = null;
		saving = true;

		const formData = new FormData();
		formData.set('displayName', editGhostName);
		formData.set('note', editGhostNote);

		const res = await fetch(`/api/projects/${projectId}/ghost-members/${ghostIdOf(party.id)}/update`, {
			method: 'POST',
			body: formData,
		});

		if (!res.ok) {
			rowError = await res.text();
			saving = false;
			return;
		}

		const updated: { display_name: string; note: string | null } = await res.json();
		updateParty(party.id, { displayName: updated.display_name, note: updated.note });
		saving = false;
		editingGhostId = null;
	}

	// The share the ghost held isn't redistributed — the split simply drops below 100%
	// and says so, the same as when a member leaves the project.
	async function deleteGhost(party: Party) {
		if (!confirm(`Remove ${party.displayName} from this project's money?`)) return;

		rowError = null;
		deletingGhostId = party.id;

		const res = await fetch(`/api/projects/${projectId}/ghost-members/${ghostIdOf(party.id)}/delete`, {
			method: 'POST',
		});

		if (!res.ok) {
			rowError = await res.text();
			deletingGhostId = null;
			return;
		}

		removeParty(party.id);
		assignedIds = assignedIds.filter((id) => id !== party.id);
		if (expandedId === party.id) expandedId = null;
		deletingGhostId = null;
	}

	onMount(() => {
		initCurrency();
	});
</script>

<section class="money-section">
	<div class="money-section-head">
		<h2>Member contributions</h2>
		{#if canEdit}
			<div class="head-actions">
				{#if !editingPercents && !addingGhost}
					<button type="button" class="btn-plain" onclick={openAddGhost}>Add ghost member</button>
				{/if}
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
				{:else if parties.length > 0}
					<button type="button" class="btn-plain" onclick={startEditPercents}>Edit split</button>
				{/if}
			</div>
		{/if}
	</div>

	{#if canEdit && addingGhost}
		<form class="money-panel ghost-form" transition:slide={{ duration: 150 }} onsubmit={submitGhost}>
			<p class="muted ghost-hint">
				A ghost member stands in for somebody funding or buying for this project who has no P2
				account — a commissioner, a sponsor, an outside supplier. They take a share of the split
				and can be named on transactions, but they never sign in.
			</p>
			<div class="panel-grid">
				<label class="field">
					<span class="field-label">Name</span>
					<input type="text" bind:value={ghostName} placeholder="e.g. Dept. of Engineering" maxlength="80" required />
				</label>
				<label class="field field-wide">
					<span class="field-label">Note</span>
					<input type="text" bind:value={ghostNote} placeholder="Who they are (optional)" maxlength="200" />
				</label>
			</div>

			{#if ghostError}<p class="panel-error">{ghostError}</p>{/if}

			<div class="panel-actions">
				<button type="submit" disabled={ghostSaving}>{ghostSaving ? 'Adding…' : 'Add ghost member'}</button>
				<button type="button" class="btn-plain" onclick={cancelAddGhost} disabled={ghostSaving}>Cancel</button>
			</div>
		</form>
	{/if}

	{#if parties.length === 0}
		<p class="muted empty">No members yet.</p>
	{:else}
		<div class="money-table">
			<table>
				<colgroup>
					<col style="width:220px" />
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
					{#each parties as member (member.id)}
						{@const memberDues = dues(member.id)}
						<tr class="data-row clickable" class:open={expandedId === member.id} onclick={(e) => toggleExpanded(e, member.id)}>
							<td>
								<span class="caret">{expandedId === member.id ? '▾' : '▸'}</span>{member.displayName}
								{#if member.isGhost}
									<span class="ghost-tag" title={member.note ?? 'Stands in for somebody with no P2 account'}>ghost</span>
									{#if canEdit && !editingPercents}
										<span class="ghost-actions">
											<button type="button" class="btn-plain" onclick={() => startEditGhost(member)}>Edit</button>
											<button
												type="button"
												class="btn-danger"
												onclick={() => deleteGhost(member)}
												disabled={deletingGhostId === member.id}
											>{deletingGhostId === member.id ? '…' : 'Remove'}</button>
										</span>
									{/if}
								{/if}
							</td>
							<td class="num">
								{#if editingPercents && member.id === remainderParty.id}
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

						{#if editingGhostId === member.id}
							<tr class="panel-row">
								<td colspan={colCount}>
									<div class="money-panel" transition:slide={{ duration: 150 }}>
										<div class="panel-grid">
											<label class="field">
												<span class="field-label">Name</span>
												<input type="text" bind:value={editGhostName} maxlength="80" required />
											</label>
											<label class="field field-wide">
												<span class="field-label">Note</span>
												<input type="text" bind:value={editGhostNote} maxlength="200" placeholder="Who they are (optional)" />
											</label>
										</div>
										<div class="panel-actions">
											<button type="button" onclick={() => saveGhost(member)} disabled={saving}>
												{saving ? 'Saving…' : 'Save'}
											</button>
											<button type="button" class="btn-plain" onclick={cancelEditGhost} disabled={saving}>Cancel</button>
										</div>
									</div>
								</td>
							</tr>
						{/if}

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
						<td>Everyone</td>
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
				Shares add up to {totalPercent.toFixed(2)}%, not 100% — the split is out of date, so each
				share of the net spend is off.
				{#if canEdit}
					Edit the split and save it to rebalance.
				{:else}
					Ask the project owner to update it.
				{/if}
			</p>
		{/if}

		{#if unassignedParties.length > 0}
			<p class="split-note">
				{unassignedParties.map((p) => p.displayName).join(', ')}
				{unassignedParties.length === 1 ? 'has' : 'have'} no share in the split yet, so
				{unassignedParties.length === 1 ? 'it counts' : 'they count'} as 0%.
				{#if canEdit}
					Edit the split to give {unassignedParties.length === 1 ? 'them' : 'each of them'} one.
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

	.ghost-tag {
		color: var(--color-muted);
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		margin-left: var(--space-1);
	}

	/* Hidden until the row is hovered or open — the name column is narrow and two
	   buttons sitting in it permanently would crowd out the names themselves. */
	.ghost-actions {
		display: none;
		gap: var(--space-1);
		margin-left: var(--space-2);
	}

	.data-row:hover .ghost-actions,
	.data-row.open .ghost-actions {
		display: inline-flex;
	}

	.ghost-actions button {
		padding: 0 var(--space-1);
		font-size: 0.68rem;
	}

	.ghost-form {
		border: 1px solid var(--color-border-strong);
		margin-bottom: var(--space-2);
	}

	.ghost-hint {
		font-size: 0.75rem;
		margin: 0 0 var(--space-3);
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
	   the right edge rather than fill the column. Scoped to `.num` so it leaves the
	   full-width name/note inputs in the ghost-edit panel alone. */
	.money-table td.num input {
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
