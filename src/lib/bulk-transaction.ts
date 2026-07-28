// Shared by the bulk create/update endpoints — both build the same parent row and
// line rows out of the same JSON payload, so the parse/validate rules live here
// rather than being copy-pasted (and drifting) across the two routes.

import { itemUrlError } from './item-url';
import { transactionDateError } from './transaction-date';
import { partyColumns } from './money-parties';
import type { Database } from './supabase/database.types';

// The rows handed to the endpoints are typed as real transaction inserts, so a
// mistyped column name here is a compile error rather than a runtime 500.
export type TransactionInsert = Database['public']['Tables']['transactions']['Insert'];

export const BULK_LINE_TYPES = ['item', 'shipping', 'discount', 'refund'] as const;

export type BulkLineType = (typeof BULK_LINE_TYPES)[number];

export type CostMode = 'per-item' | 'overall';

export interface BulkLine {
	type: BulkLineType;
	itemName: string | null;
	quantity: number | null;
	unit: string | null;
	unitCost: number | null;
	supplier: string | null;
	itemUrl: string | null;
}

export interface BulkPayload {
	label: string;
	transactionDate: string;
	partyId: string;
	supplier: string | null;
	itemUrl: string | null;
	costMode: CostMode;
	overallCost: number | null;
	lines: BulkLine[];
}

function toNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const num = Number(value);
	return Number.isFinite(num) ? num : NaN;
}

function toText(value: unknown, max: number): string | null | undefined {
	if (value === null || value === undefined) return null;
	const str = String(value).trim();
	if (!str) return null;
	return str.length > max ? undefined : str;
}

/**
 * Validates the client payload and returns either an error message or the rows to
 * write. The parent row always carries the money: in 'overall' mode that's the single
 * amount the user typed and the lines are a costless manifest, in 'per-item' mode it's
 * the signed sum of the lines (recomputed here — a client-sent total is never trusted,
 * or the row and its own breakdown could disagree).
 */
export function buildBulkRows(
	payload: unknown,
	projectId: string,
): { error: string } | { parent: TransactionInsert; lines: BulkLine[]; total: number; partyId: string } {
	if (typeof payload !== 'object' || payload === null) {
		return { error: 'Invalid request body' };
	}

	const body = payload as Record<string, unknown>;

	const rawLabel = toText(body.label, 200);
	if (rawLabel === undefined) {
		return { error: 'Name: max 200 characters' };
	}
	const label = rawLabel ?? 'Bulk transaction';

	const transactionDate = toText(body.transactionDate, 32);
	if (!transactionDate) {
		return { error: 'Date is required' };
	}
	const dateError = transactionDateError(transactionDate);
	if (dateError) {
		return { error: dateError };
	}

	const partyId = toText(body.partyId, 100);
	if (!partyId) {
		return { error: 'Member is required' };
	}

	const supplier = toText(body.supplier, 200);
	if (supplier === undefined) {
		return { error: 'Supplier: max 200 characters' };
	}

	const itemUrl = toText(body.itemUrl, 2000);
	if (itemUrl === undefined) {
		return { error: 'Supplier link: max 2000 characters' };
	}
	const urlError = itemUrlError(itemUrl);
	if (urlError) {
		return { error: urlError };
	}

	const costMode = body.costMode === 'overall' ? 'overall' : 'per-item';

	if (!Array.isArray(body.lines) || body.lines.length === 0) {
		return { error: 'Add at least one item' };
	}
	if (body.lines.length > 100) {
		return { error: 'A bulk transaction can hold at most 100 items' };
	}

	const lines: BulkLine[] = [];

	for (const [index, raw] of body.lines.entries()) {
		if (typeof raw !== 'object' || raw === null) {
			return { error: `Item ${index + 1}: invalid` };
		}
		const line = raw as Record<string, unknown>;

		const type = String(line.type ?? 'item') as BulkLineType;
		if (!BULK_LINE_TYPES.includes(type)) {
			return { error: `Item ${index + 1}: invalid type` };
		}

		const itemName = toText(line.itemName, 200);
		if (itemName === undefined) {
			return { error: `Item ${index + 1}: name is max 200 characters` };
		}
		if (type === 'item' && !itemName) {
			return { error: `Item ${index + 1}: name is required` };
		}

		const unit = toText(line.unit, 50);
		if (unit === undefined) {
			return { error: `Item ${index + 1}: unit is max 50 characters` };
		}

		const lineSupplier = toText(line.supplier, 200);
		if (lineSupplier === undefined) {
			return { error: `Item ${index + 1}: supplier is max 200 characters` };
		}

		const lineUrl = toText(line.itemUrl, 2000);
		if (lineUrl === undefined) {
			return { error: `Item ${index + 1}: supplier link is max 2000 characters` };
		}
		const lineUrlError = itemUrlError(lineUrl);
		if (lineUrlError) {
			return { error: `Item ${index + 1}: ${lineUrlError.toLowerCase()}` };
		}

		const quantity = toNumber(line.quantity);
		const unitCost = toNumber(line.unitCost);

		if (Number.isNaN(quantity) || Number.isNaN(unitCost)) {
			return { error: `Item ${index + 1}: quantity and cost must be numbers` };
		}
		if ((quantity ?? 0) < 0 || (unitCost ?? 0) < 0) {
			return { error: `Item ${index + 1}: cannot be negative` };
		}
		if (costMode === 'per-item' && unitCost == null) {
			return { error: `Item ${index + 1}: cost is required` };
		}

		lines.push({
			type,
			itemName,
			quantity: type === 'item' ? (quantity ?? 1) : 1,
			unit: type === 'item' ? unit : null,
			// In overall-cost mode the lines are a manifest of what was bought; the
			// amount lives on the parent, so no line carries one.
			unitCost: costMode === 'overall' ? null : unitCost,
			supplier: lineSupplier,
			itemUrl: lineUrl,
		});
	}

	let total: number;

	if (costMode === 'overall') {
		const overall = toNumber(body.overallCost);
		if (Number.isNaN(overall) || overall == null) {
			return { error: 'Total cost is required' };
		}
		if (overall < 0) {
			return { error: 'Total cost cannot be negative' };
		}
		total = overall;
	} else {
		total = lines.reduce((sum, line) => {
			const lineTotal = (line.quantity ?? 0) * (line.unitCost ?? 0);
			return line.type === 'discount' || line.type === 'refund' ? sum - lineTotal : sum + lineTotal;
		}, 0);

		if (total < 0) {
			return { error: 'Discounts and refunds exceed the items — record that as a separate refund instead' };
		}
		// Sub-cent float debris from summing line totals would otherwise be stored and
		// then shown back as a total that doesn't match the visible breakdown.
		total = Math.round(total * 100) / 100;
	}

	return {
		partyId,
		parent: {
			project_id: projectId,
			...partyColumns(partyId),
			related_member_id: null,
			related_ghost_member_id: null,
			group_id: null,
			transaction_date: transactionDate,
			type: 'bulk',
			item_name: label,
			quantity: 1,
			unit: null,
			unit_cost: total,
			supplier,
			item_url: itemUrl,
		},
		lines,
		total,
	};
}

export function lineRows(
	lines: BulkLine[],
	parentId: string,
	projectId: string,
	partyId: string,
	transactionDate: string,
): TransactionInsert[] {
	return lines.map((line) => ({
		project_id: projectId,
		...partyColumns(partyId),
		related_member_id: null,
		related_ghost_member_id: null,
		group_id: parentId,
		transaction_date: transactionDate,
		type: line.type,
		item_name: line.itemName,
		quantity: line.quantity,
		unit: line.unit,
		unit_cost: line.unitCost,
		supplier: line.supplier,
		item_url: line.itemUrl,
	}));
}
