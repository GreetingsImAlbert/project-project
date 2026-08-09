import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REORDER_ITEMS = 10_000;

export type TaskReorderPayload =
	| {
		type: 'category';
		category: string | null;
		taskIds: string[];
	}
	| {
		type: 'move';
		taskId: string;
		sourceCategory: string | null;
		destinationCategory: string | null;
		sourceTaskIds: string[];
		destinationTaskIds: string[];
	};

export interface CategoryReorderPayload {
	categoryNames: (string | null)[];
}

export interface TaskOrder {
	category: string | null;
	taskIds: string[];
}

export interface CanonicalCategoryPosition {
	id: string | null;
	categoryName: string | null;
	priorityPosition: number;
}

export type ParseResult<T> = { value: T } | { error: string };

interface TaskRankRow {
	id: string;
	category: string | null;
	priority_position: number;
}

interface CategoryPositionRow {
	id: string;
	category_name: string | null;
	priority_position: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): string | null {
	const allowedSet = new Set(allowed);
	const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
	return unknown ? `Unknown field: ${unknown}` : null;
}

function required(value: Record<string, unknown>, key: string): ParseResult<unknown> {
	if (!(key in value)) return { error: `${key} is required` };
	return { value: value[key] };
}

function parseCategory(value: unknown, field: string): ParseResult<string | null> {
	if (value !== null && typeof value !== 'string') return { error: `${field} must be a string or null` };
	const normalized = value === null ? null : value.trim() || null;
	if (normalized?.includes('\u0000')) return { error: `${field} contains an invalid character` };
	if (normalized && normalized.length > 100) return { error: `${field} is too long` };
	return { value: normalized };
}

function parseUuid(value: unknown, field: string): ParseResult<string> {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return { error: `${field} must be a UUID` };
	return { value: value.toLowerCase() };
}

function parseTaskIds(value: unknown, field: string): ParseResult<string[]> {
	if (!Array.isArray(value)) return { error: `${field} must be an array` };
	if (value.length > MAX_REORDER_ITEMS) return { error: `${field} has too many items` };

	const ids: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < value.length; index += 1) {
		const parsed = parseUuid(value[index], `${field}[${index}]`);
		if ('error' in parsed) return parsed;
		if (seen.has(parsed.value)) return { error: `${field} contains duplicate task IDs` };
		seen.add(parsed.value);
		ids.push(parsed.value);
	}
	return { value: ids };
}

export function isUuid(value: string | undefined): value is string {
	return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function normalizeCategory(value: string | null): string | null {
	return value?.trim() || null;
}

export function categoryKey(value: string | null): string {
	return value === null ? '\u0000' : value;
}

export async function readJsonObject(request: Request): Promise<ParseResult<Record<string, unknown>>> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return { error: 'Request body must be valid JSON' };
	}
	if (!isRecord(body)) return { error: 'Request body must be a JSON object' };
	return { value: body };
}

export function parseTaskReorderPayload(body: Record<string, unknown>): ParseResult<TaskReorderPayload> {
	const unknownField = exactKeys(body, [
		'type',
		'category',
		'taskIds',
		'taskId',
		'sourceCategory',
		'destinationCategory',
		'sourceTaskIds',
		'destinationTaskIds',
	]);
	if (unknownField) return { error: unknownField };

	if (body.type === 'category') {
		const categoryKeys = exactKeys(body, ['type', 'category', 'taskIds']);
		if (categoryKeys) return { error: categoryKeys };
		const categoryValue = required(body, 'category');
		if ('error' in categoryValue) return categoryValue;
		const taskIdsValue = required(body, 'taskIds');
		if ('error' in taskIdsValue) return taskIdsValue;
		const category = parseCategory(categoryValue.value, 'category');
		if ('error' in category) return category;
		const taskIds = parseTaskIds(taskIdsValue.value, 'taskIds');
		if ('error' in taskIds) return taskIds;
		return { value: { type: 'category', category: category.value, taskIds: taskIds.value } };
	}

	if (body.type === 'move') {
		const moveKeys = exactKeys(body, [
			'type',
			'taskId',
			'sourceCategory',
			'destinationCategory',
			'sourceTaskIds',
			'destinationTaskIds',
		]);
		if (moveKeys) return { error: moveKeys };
		const taskIdValue = required(body, 'taskId');
		if ('error' in taskIdValue) return taskIdValue;
		const sourceCategoryValue = required(body, 'sourceCategory');
		if ('error' in sourceCategoryValue) return sourceCategoryValue;
		const destinationCategoryValue = required(body, 'destinationCategory');
		if ('error' in destinationCategoryValue) return destinationCategoryValue;
		const sourceTaskIdsValue = required(body, 'sourceTaskIds');
		if ('error' in sourceTaskIdsValue) return sourceTaskIdsValue;
		const destinationTaskIdsValue = required(body, 'destinationTaskIds');
		if ('error' in destinationTaskIdsValue) return destinationTaskIdsValue;

		const taskId = parseUuid(taskIdValue.value, 'taskId');
		if ('error' in taskId) return taskId;
		const sourceCategory = parseCategory(sourceCategoryValue.value, 'sourceCategory');
		if ('error' in sourceCategory) return sourceCategory;
		const destinationCategory = parseCategory(destinationCategoryValue.value, 'destinationCategory');
		if ('error' in destinationCategory) return destinationCategory;
		if (categoryKey(sourceCategory.value) === categoryKey(destinationCategory.value)) {
			return { error: 'sourceCategory and destinationCategory must differ' };
		}

		const sourceTaskIds = parseTaskIds(sourceTaskIdsValue.value, 'sourceTaskIds');
		if ('error' in sourceTaskIds) return sourceTaskIds;
		const destinationTaskIds = parseTaskIds(destinationTaskIdsValue.value, 'destinationTaskIds');
		if ('error' in destinationTaskIds) return destinationTaskIds;
		if (sourceTaskIds.value.includes(taskId.value)) return { error: 'taskId must not remain in sourceTaskIds' };
		if (!destinationTaskIds.value.includes(taskId.value)) return { error: 'destinationTaskIds must include taskId' };
		if (sourceTaskIds.value.some((id) => destinationTaskIds.value.includes(id))) {
			return { error: 'sourceTaskIds and destinationTaskIds must not overlap' };
		}

		return {
			value: {
				type: 'move',
				taskId: taskId.value,
				sourceCategory: sourceCategory.value,
				destinationCategory: destinationCategory.value,
				sourceTaskIds: sourceTaskIds.value,
				destinationTaskIds: destinationTaskIds.value,
			},
		};
	}

	return { error: 'type must be category or move' };
}

export function parseCategoryReorderPayload(body: Record<string, unknown>): ParseResult<CategoryReorderPayload> {
	const unknownField = exactKeys(body, ['categoryNames']);
	if (unknownField) return { error: unknownField };
	const categoryNamesValue = required(body, 'categoryNames');
	if ('error' in categoryNamesValue) return categoryNamesValue;
	if (!Array.isArray(categoryNamesValue.value)) return { error: 'categoryNames must be an array' };
	if (categoryNamesValue.value.length > MAX_REORDER_ITEMS) return { error: 'categoryNames has too many items' };

	const categoryNames: (string | null)[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < categoryNamesValue.value.length; index += 1) {
		const parsed = parseCategory(categoryNamesValue.value[index], `categoryNames[${index}]`);
		if ('error' in parsed) return parsed;
		const key = categoryKey(parsed.value);
		if (seen.has(key)) return { error: 'categoryNames contains duplicate categories' };
		seen.add(key);
		categoryNames.push(parsed.value);
	}

	return { value: { categoryNames } };
}

function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export async function readCanonicalTaskOrders(
	supabase: SupabaseClient,
	projectId: string,
	categories: (string | null)[],
): Promise<{ data: TaskOrder[]; error: null } | { data: null; error: PostgrestError }> {
	const { data: rows, error } = await supabase
		.from('tasks')
		.select('id, category, priority_position')
		.eq('project_id', projectId)
		.is('deleted_at', null)
		.neq('status', 'done')
		.order('priority_position', { ascending: true })
		.order('id', { ascending: true });
	if (error) return { data: null, error };

	const orderedRows = ((rows ?? []) as TaskRankRow[]).sort((a, b) =>
		a.priority_position - b.priority_position || compareIds(a.id, b.id),
	);
	const requested = new Map<string, TaskOrder>();
	for (const category of categories) {
		const normalized = normalizeCategory(category);
		const key = categoryKey(normalized);
		if (!requested.has(key)) requested.set(key, { category: normalized, taskIds: [] });
	}
	for (const row of orderedRows) {
		const category = normalizeCategory(row.category);
		const order = requested.get(categoryKey(category));
		if (order) order.taskIds.push(row.id);
	}

	return { data: [...requested.values()], error: null };
}

export async function readCanonicalCategoryOrder(
	supabase: SupabaseClient,
	projectId: string,
): Promise<
	| { data: { categoryNames: (string | null)[]; categoryPositions: CanonicalCategoryPosition[] }; error: null }
	| { data: null; error: PostgrestError }
> {
	const [{ data: taskRows, error: taskError }, { data: positionRows, error: positionError }] = await Promise.all([
		supabase.from('tasks').select('category').eq('project_id', projectId).is('deleted_at', null).neq('status', 'done'),
		supabase
			.from('task_category_positions')
			.select('id, category_name, priority_position')
			.eq('project_id', projectId)
			.order('priority_position', { ascending: true })
			.order('id', { ascending: true }),
	]);
	if (taskError) return { data: null, error: taskError };
	if (positionError) return { data: null, error: positionError };

	const activeCategories = new Set<string>();
	for (const row of (taskRows ?? []) as Array<{ category: string | null }>) {
		activeCategories.add(categoryKey(normalizeCategory(row.category)));
	}

	const positions = ((positionRows ?? []) as CategoryPositionRow[]).filter((position) =>
		activeCategories.has(categoryKey(normalizeCategory(position.category_name))),
	);
	const positionByCategory = new Map<string, CategoryPositionRow>();
	for (const position of positions) {
		positionByCategory.set(categoryKey(normalizeCategory(position.category_name)), position);
	}

	const names = [...activeCategories].map((key) => (key === '\u0000' ? null : key));
	names.sort((a, b) => {
		const aPosition = positionByCategory.get(categoryKey(a));
		const bPosition = positionByCategory.get(categoryKey(b));
		const aRank = aPosition?.priority_position ?? Number.MAX_SAFE_INTEGER;
		const bRank = bPosition?.priority_position ?? Number.MAX_SAFE_INTEGER;
		if (aRank !== bRank) return aRank < bRank ? -1 : 1;
		if (aPosition && bPosition && aPosition.id !== bPosition.id) return compareIds(aPosition.id, bPosition.id);
		return (a ?? '').localeCompare(b ?? '');
	});

	return {
		data: {
			categoryNames: names,
			categoryPositions: names.map((category, index) => {
				const position = positionByCategory.get(categoryKey(category));
				return {
					id: position?.id ?? null,
					categoryName: category,
					priorityPosition: position?.priority_position ?? index,
				};
			}),
		},
		error: null,
	};
}

export function expectedRpcErrorResponse(message: string): { message: string; status: 400 | 403 | 404 } | null {
	const normalized = message.toLowerCase();
	if (normalized.includes('forbidden')) return { message: 'Forbidden', status: 403 };
	if (normalized.includes('project not found')) return { message: 'Project not found', status: 404 };
	if (normalized.includes('invalid task order')) return { message: 'Invalid task order', status: 400 };
	if (normalized.includes('invalid task move')) return { message: 'Invalid task move', status: 400 };
	if (normalized.includes('invalid category order')) return { message: 'Invalid category order', status: 400 };
	if (normalized.includes('source and destination categories must differ')) {
		return { message: 'Source and destination categories must differ', status: 400 };
	}
	return null;
}
