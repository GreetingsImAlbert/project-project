import { errorResponse } from '../../../../lib/error-report';

export const prerender = false;

interface FileRow {
	id: string;
	filename: string;
	size_bytes: number | null;
	deleted_at: string;
}

interface FolderRow {
	id: string;
	name: string;
	deleted_at: string;
}

interface TaskRow {
	id: string;
	name: string;
	category: string | null;
	deleted_at: string;
}

interface BomItemRow {
	id: string;
	part_name: string;
	category: string | null;
	total_cost: number | null;
	deleted_at: string;
}

interface TransactionRow {
	id: string;
	type: string;
	item_name: string | null;
	transaction_date: string;
	total_cost: number | null;
	deleted_at: string;
}

export async function GET({ locals, params, request }: { locals: App.Locals; params: Record<string, string | undefined>; request: Request }) {
	if (!locals.user) return new Response('Not signed in', { status: 401 });

	const projectId = params.id;
	if (!projectId) return new Response('Project not found', { status: 404 });

	const [{ data: files, error: filesError }, { data: folders, error: foldersError }, { data: tasks, error: tasksError }, { data: bomItems, error: bomError }, { data: transactions, error: transactionsError }] = await Promise.all([
		locals.supabase
			.from('files')
			.select('id, filename, size_bytes, deleted_at')
			.eq('project_id', projectId)
			.not('deleted_at', 'is', null)
			.order('deleted_at', { ascending: false })
			.overrideTypes<FileRow[]>(),
		locals.supabase
			.from('folders')
			.select('id, name, deleted_at')
			.eq('project_id', projectId)
			.not('deleted_at', 'is', null)
			.order('deleted_at', { ascending: false })
			.overrideTypes<FolderRow[]>(),
		locals.supabase
			.from('tasks')
			.select('id, name, category, deleted_at')
			.eq('project_id', projectId)
			.not('deleted_at', 'is', null)
			.order('deleted_at', { ascending: false })
			.overrideTypes<TaskRow[]>(),
		locals.supabase
			.from('bom_items')
			.select('id, part_name, category, total_cost, deleted_at')
			.eq('project_id', projectId)
			.not('deleted_at', 'is', null)
			.order('deleted_at', { ascending: false })
			.overrideTypes<BomItemRow[]>(),
		locals.supabase
			.from('transactions')
			.select('id, type, item_name, transaction_date, total_cost, deleted_at')
			.eq('project_id', projectId)
			.is('group_id', null)
			.not('deleted_at', 'is', null)
			.order('deleted_at', { ascending: false })
			.overrideTypes<TransactionRow[]>(),
	]);

	if (filesError || foldersError || tasksError || bomError || transactionsError) {
		return errorResponse({
			request,
			userId: locals.user.id,
			privateMessage: `Could not load trash: ${[filesError, foldersError, tasksError, bomError, transactionsError].find((e) => e !== null)?.message ?? 'unknown error'}`,
			action: 'Could not load trash.',
			context: { projectId: projectId ?? null },
		});
	}

	return Response.json(
		{ files: files ?? [], folders: folders ?? [], tasks: tasks ?? [], bomItems: bomItems ?? [], transactions: transactions ?? [] },
		{ headers: { 'cache-control': 'private, no-store' } },
	);
}
