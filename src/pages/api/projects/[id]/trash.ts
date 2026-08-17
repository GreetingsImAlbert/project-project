import { env } from 'cloudflare:workers';
import { errorResponse } from '../../../../lib/error-report';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';
import { canDeleteJournal, journalSchemaClient, type JournalKind, type JournalVisibility } from '../../../../lib/journal';

export const prerender = false;

interface FileRow {
	id: string;
	filename: string;
	size_bytes: number | null;
	deleted_at: string;
	canRestore: boolean;
	canPurge: boolean;
}

interface FolderRow {
	id: string;
	name: string;
	deleted_at: string;
	isJournalsFolder: boolean;
	canRestore: boolean;
	canPurge: boolean;
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
	const { data: membership } = await locals.supabase
		.from('project_members')
		.select('role')
		.eq('project_id', projectId)
		.eq('user_id', locals.user.id)
		.maybeSingle();
	if (!membership) return new Response('Project not found', { status: 404 });
	const admin = getSupabaseAdmin(env);
	const canEditFiles = membership.role === 'owner' || membership.role === 'editor';

	const [{ data: fileRows, error: filesError }, { data: folders, error: foldersError }, { data: tasks, error: tasksError }, { data: bomItems, error: bomError }, { data: transactions, error: transactionsError }] = await Promise.all([
		journalSchemaClient(admin)
			.from('files')
			.select('id, filename, size_bytes, uploaded_by, uploader_deleted_at, is_journal, journal_kind, journal_visibility, deleted_at')
			.eq('project_id', projectId)
			.not('deleted_at', 'is', null)
			.order('deleted_at', { ascending: false }),
		journalSchemaClient(locals.supabase)
			.from('folders')
			.select('id, name, deleted_at, is_journals_folder')
			.eq('project_id', projectId)
			.not('deleted_at', 'is', null)
			.order('deleted_at', { ascending: false }),
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
	const files: FileRow[] = (fileRows ?? []).flatMap((file: any) => {
		if (!file.is_journal) return [{
			id: file.id,
			filename: file.filename,
			size_bytes: file.size_bytes,
			deleted_at: file.deleted_at,
			canRestore: canEditFiles,
			canPurge: canEditFiles,
		}];
		if (file.journal_kind === 'personal' && file.uploader_deleted_at) return [];
		const canManage = file.journal_kind === 'personal' && canDeleteJournal({
			kind: file.journal_kind as JournalKind,
			creatorId: file.uploaded_by,
			visibility: file.journal_visibility as JournalVisibility | null,
		}, { viewerId: locals.user!.id, isProjectMember: true, role: membership.role });
		return canManage ? [{
			id: file.id,
			filename: file.filename,
			size_bytes: file.size_bytes,
			deleted_at: file.deleted_at,
			canRestore: true,
			canPurge: true,
		}] : [];
	});
	const visibleFolders: FolderRow[] = (folders ?? []).map((folder: any) => ({
		id: folder.id,
		name: folder.name,
		deleted_at: folder.deleted_at,
		isJournalsFolder: folder.is_journals_folder,
		canRestore: canEditFiles && !folder.is_journals_folder,
		canPurge: canEditFiles && !folder.is_journals_folder,
	}));

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
		{ files, folders: visibleFolders, tasks: tasks ?? [], bomItems: bomItems ?? [], transactions: transactions ?? [] },
		{ headers: { 'cache-control': 'private, no-store' } },
	);
}
