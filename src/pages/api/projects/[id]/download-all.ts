import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { buildTaskExportPayload } from '../../../../lib/task-export';
import { normalizeTask, type RawTaskRow, type TaskCategoryPosition } from '../../../../lib/task-columns';
import {
	buildProjectArchiveLayout,
	PROJECT_EXPORT_CHECKSUM,
	PROJECT_EXPORT_FORMAT,
	PROJECT_EXPORT_VERSION,
	safeArchiveName,
	sha256Hex,
	type ProjectExportManifestV1,
} from '../../../../lib/project-export';
import type { Database } from '../../../../lib/supabase/database.types';
import { getSupabaseAdmin } from '../../../../lib/supabase/admin';
import { zip, type ZipEntry } from '../../../../lib/zip';

export const prerender = false;

// The Worker builds this stored ZIP in memory, so both the source bytes and the
// final archive coexist. Keep enough isolate headroom for JSON metadata and ZIP
// structures; larger projects need a future streaming exporter.
const MAX_DOWNLOAD_BYTES = 80 * 1_000_000;

type Tables = Database['public']['Tables'];
type Row<Name extends keyof Tables> = Tables[Name]['Row'];

const encoder = new TextEncoder();
const textEntry = (name: string, body: string): ZipEntry => ({ name, bytes: encoder.encode(body) });
const jsonEntry = (name: string, data: unknown): ZipEntry =>
	textEntry(name, `${JSON.stringify(data, null, 2)}\n`);

class MissingStoredFileError extends Error {}

function databaseFailure(area: string, error: { message: string }) {
	console.error(`[project-export] Failed to read ${area}: ${error.message}`);
	return new Response('Could not prepare the project download.', { status: 500 });
}

export const GET: APIRoute = async ({ params, locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });

	const projectId = params.id;
	if (!projectId) return new Response('Project is required', { status: 400 });

	// Project archives contain all private records and member identity snapshots,
	// so the endpoint mirrors the owner-only Settings page that exposes the button.
	const { data: project, error: projectError } = await locals.supabase
		.from('projects')
		.select('*')
		.eq('id', projectId)
		.single();
	if (projectError || !project) return new Response('Project not found', { status: 404 });
	if (project.owner_id !== locals.user.id) return new Response('Forbidden', { status: 403 });

	// Authorization is settled above with the caller's RLS-scoped session. The
	// admin client then takes a consistent, complete snapshot, including Trash and
	// identities still referenced after a member leaves the project.
	const admin = getSupabaseAdmin(env);
	const [
		folderResult,
		fileResult,
		taskResult,
		categoryPositionResult,
		categoryResult,
		bomResult,
		transactionResult,
		memberResult,
		ghostResult,
		journalDraftResult,
	] = await Promise.all([
		admin.from('folders').select('*').eq('project_id', projectId).order('created_at').order('id'),
		admin.from('files').select('*').eq('project_id', projectId).order('created_at').order('id'),
		admin.from('tasks').select('*').eq('project_id', projectId).order('priority_position').order('id'),
		admin
			.from('task_category_positions')
			.select('*')
			.eq('project_id', projectId)
			.order('priority_position')
			.order('id'),
		admin.from('task_categories').select('*').eq('project_id', projectId).order('name'),
		admin.from('bom_items').select('*').eq('project_id', projectId).order('category').order('part_name').order('id'),
		admin
			.from('transactions')
			.select('*')
			.eq('project_id', projectId)
			.order('transaction_date')
			.order('created_at')
			.order('id'),
		admin.from('project_members').select('*').eq('project_id', projectId).order('user_id'),
		admin.from('ghost_members').select('*').eq('project_id', projectId).order('created_at').order('id'),
		admin.from('journal_drafts').select('*').eq('project_id', projectId).maybeSingle(),
	]);

	const snapshotResults = [
		['folders', folderResult],
		['files', fileResult],
		['tasks', taskResult],
		['task category positions', categoryPositionResult],
		['task categories', categoryResult],
		['BOM items', bomResult],
		['transactions', transactionResult],
		['project members', memberResult],
		['ghost members', ghostResult],
		['journal draft', journalDraftResult],
	] as const;
	for (const [area, result] of snapshotResults) {
		if (result.error) return databaseFailure(area, result.error);
	}

	const folderRows = folderResult.data ?? [];
	const fileRows = fileResult.data ?? [];
	const taskRows = taskResult.data ?? [];
	const categoryPositionRows = categoryPositionResult.data ?? [];
	const categoryRows = categoryResult.data ?? [];
	const bomRows = bomResult.data ?? [];
	const transactionRows = transactionResult.data ?? [];
	const memberRows = memberResult.data ?? [];
	const ghostRows = ghostResult.data ?? [];
	const journalDraft = journalDraftResult.data ?? null;

	let taskAssigneeRows: Row<'task_assignees'>[] = [];
	if (taskRows.length > 0) {
		const result = await admin
			.from('task_assignees')
			.select('*')
			.in('task_id', taskRows.map((task) => task.id))
			.order('id');
		if (result.error) return databaseFailure('task assignees', result.error);
		taskAssigneeRows = result.data ?? [];
	}

	const referencedUserIds = new Set<string>([project.owner_id]);
	for (const member of memberRows) referencedUserIds.add(member.user_id);
	for (const file of fileRows) if (file.uploaded_by) referencedUserIds.add(file.uploaded_by);
	for (const transaction of transactionRows) {
		if (transaction.member_id) referencedUserIds.add(transaction.member_id);
		if (transaction.related_member_id) referencedUserIds.add(transaction.related_member_id);
	}
	for (const assignee of taskAssigneeRows) if (assignee.user_id) referencedUserIds.add(assignee.user_id);
	if (journalDraft?.updated_by) referencedUserIds.add(journalDraft.updated_by);

	let profileRows: Pick<Row<'profiles'>, 'id' | 'display_name' | 'email'>[] = [];
	if (referencedUserIds.size > 0) {
		const result = await admin
			.from('profiles')
			.select('id, display_name, email')
			.in('id', [...referencedUserIds])
			.order('id');
		if (result.error) return databaseFailure('referenced profiles', result.error);
		profileRows = result.data ?? [];
	}

	let layout;
	try {
		layout = buildProjectArchiveLayout(folderRows, fileRows);
	} catch (error) {
		console.error('[project-export] Invalid project file hierarchy', error);
		return new Response('The project file hierarchy is invalid and cannot be exported.', { status: 409 });
	}

	const recordedFileBytes = fileRows.reduce((sum, file) => sum + Number(file.size_bytes ?? 0), 0);
	if (recordedFileBytes > MAX_DOWNLOAD_BYTES) {
		return new Response(
			`This project's files total ${recordedFileBytes.toLocaleString()} B, past the ${MAX_DOWNLOAD_BYTES.toLocaleString()} B cap for a single download.`,
			{ status: 413 },
		);
	}

	const bucket = env.R2_BUCKET;
	if (!bucket) return new Response('Project file storage is unavailable.', { status: 503 });

	let storedFiles: { file: Row<'files'>; bytes: Uint8Array<ArrayBuffer>; sha256: string }[];
	try {
		storedFiles = await Promise.all(
			fileRows.map(async (file) => {
				const object = await bucket.get(file.r2_key);
				if (!object) throw new MissingStoredFileError(`Missing stored content for ${file.filename}`);
				const bytes = new Uint8Array(await object.arrayBuffer());
				return { file, bytes, sha256: await sha256Hex(bytes) };
			}),
		);
	} catch (error) {
		if (error instanceof MissingStoredFileError) return new Response(error.message, { status: 409 });
		console.error('[project-export] Failed to read stored files', error);
		return new Response('Could not read the project files.', { status: 500 });
	}

	const actualFileBytes = storedFiles.reduce((sum, stored) => sum + stored.bytes.length, 0);
	if (actualFileBytes > MAX_DOWNLOAD_BYTES) {
		return new Response(
			`This project's files total ${actualFileBytes.toLocaleString()} B, past the ${MAX_DOWNLOAD_BYTES.toLocaleString()} B cap for a single download.`,
			{ status: 413 },
		);
	}

	const exportedAt = new Date().toISOString();
	const memberUserIds = new Set(memberRows.map((member) => member.user_id));
	const people = profileRows.map((profile) => ({
		sourceUserId: profile.id,
		displayName: profile.display_name,
		// Email is membership data already present in members.json. Do not expose a
		// removed account's email merely because an old record still references it.
		email: memberUserIds.has(profile.id) ? profile.email : null,
	}));
	const personById = new Map(people.map((person) => [person.sourceUserId, person]));
	const ghostById = new Map(ghostRows.map((ghost) => [ghost.id, ghost]));
	const storedFileById = new Map(storedFiles.map((stored) => [stored.file.id, stored]));

	const manifestFiles = fileRows.map((file) => {
		const stored = storedFileById.get(file.id)!;
		return {
			id: file.id,
			project_id: file.project_id,
			folder_id: file.folder_id,
			uploaded_by: file.uploaded_by,
			filename: file.filename,
			mime_type: file.mime_type,
			size_bytes: file.size_bytes,
			storage_provider: file.storage_provider,
			uploader_deleted_at: file.uploader_deleted_at,
			created_at: file.created_at,
			deleted_at: file.deleted_at,
			is_public: file.is_public,
			is_journal: file.is_journal,
			archive_path: layout.filePaths.get(file.id)!,
			content_size_bytes: stored.bytes.length,
			sha256: stored.sha256,
		};
	});

	const manifest: ProjectExportManifestV1 = {
		format: PROJECT_EXPORT_FORMAT,
		version: PROJECT_EXPORT_VERSION,
		exportedAt,
		checksumAlgorithm: PROJECT_EXPORT_CHECKSUM,
		project,
		people,
		recordCounts: {
			projectMembers: memberRows.length,
			ghostMembers: ghostRows.length,
			folders: folderRows.length,
			files: fileRows.length,
			bomItems: bomRows.length,
			transactions: transactionRows.length,
			tasks: taskRows.length,
			taskAssignees: taskAssigneeRows.length,
			taskCategories: categoryRows.length,
			taskCategoryPositions: categoryPositionRows.length,
			journalDrafts: journalDraft ? 1 : 0,
		},
		records: {
			projectMembers: memberRows,
			ghostMembers: ghostRows,
			folders: folderRows.map((folder) => ({
				...folder,
				archive_path: layout.folderArchivePaths.get(folder.id)!,
			})),
			files: manifestFiles,
			bomItems: bomRows,
			transactions: transactionRows,
			tasks: taskRows,
			taskAssignees: taskAssigneeRows,
			taskCategories: categoryRows,
			taskCategoryPositions: categoryPositionRows,
			journalDraft,
		},
	};

	// Keep the original readable exports alongside the authoritative manifest so
	// existing downloaded-archive workflows do not lose any files or JSON shapes.
	const assigneesByTask = new Map<string, Row<'task_assignees'>[]>();
	for (const assignee of taskAssigneeRows) {
		const rows = assigneesByTask.get(assignee.task_id) ?? [];
		rows.push(assignee);
		assigneesByTask.set(assignee.task_id, rows);
	}
	const normalizedTasks = taskRows
		.filter((task) => !task.deleted_at)
		.map((task) => normalizeTask({
			id: task.id,
			name: task.name,
			category: task.category,
			priority_position: task.priority_position,
			description: task.description,
			start_date: task.start_date,
			start_time: task.start_time,
			deadline: task.deadline,
			deadline_time: task.deadline_time,
			status: task.status,
			task_assignees: (assigneesByTask.get(task.id) ?? []).map((assignee) => ({
				id: assignee.id,
				user_id: assignee.user_id,
				ghost_member_id: assignee.ghost_member_id,
				deleted_display_name: assignee.deleted_display_name,
				profiles: assignee.user_id
					? { display_name: personById.get(assignee.user_id)?.displayName ?? '', avatar: null }
					: null,
				ghost_members: assignee.ghost_member_id
					? { display_name: ghostById.get(assignee.ghost_member_id)?.display_name ?? '' }
					: null,
			})),
		} satisfies RawTaskRow));
	const legacyCategoryPositions: TaskCategoryPosition[] = categoryPositionRows.map((position) => ({
		id: position.id,
		category_name: position.category_name,
		priority_position: position.priority_position,
	}));
	const tasksPayload = buildTaskExportPayload(project.name, exportedAt, normalizedTasks, legacyCategoryPositions);

	const membersPayload = {
		project: project.name,
		exportedAt,
		members: memberRows.map((member) => ({
			displayName: personById.get(member.user_id)?.displayName ?? null,
			email: personById.get(member.user_id)?.email ?? null,
			role: member.role,
			isAuditor: member.is_auditor,
			contributionPercent: member.contribution_percent,
			joinedAt: member.joined_at,
		})),
		ghostMembers: ghostRows.map((ghost) => ({
			displayName: ghost.display_name,
			note: ghost.note,
			contributionPercent: ghost.contribution_percent,
			isDeletedAccount: ghost.is_deleted_account,
		})),
	};

	const bomPayload = {
		project: project.name,
		currency: project.currency,
		exportedAt,
		items: bomRows.filter((item) => !item.deleted_at).map((item) => ({
			partName: item.part_name,
			category: item.category,
			description: item.description,
			quantity: item.quantity,
			unit: item.unit,
			unitCost: item.unit_cost,
			supplier: item.supplier,
			itemUrl: item.item_url,
			totalCost: item.total_cost,
		})),
	};

	function partyName(memberId: string | null, ghostId: string | null): string | null {
		if (memberId) return personById.get(memberId)?.displayName ?? null;
		if (ghostId) return ghostById.get(ghostId)?.display_name ?? null;
		return null;
	}
	const transactionsPayload = {
		project: project.name,
		currency: project.currency,
		exportedAt,
		transactions: transactionRows.filter((transaction) => !transaction.deleted_at).map((transaction) => ({
			id: transaction.id,
			date: transaction.transaction_date,
			type: transaction.type,
			itemName: transaction.item_name,
			quantity: transaction.quantity,
			unit: transaction.unit,
			unitCost: transaction.unit_cost,
			supplier: transaction.supplier,
			itemUrl: transaction.item_url,
			totalCost: transaction.total_cost,
			paidBy: partyName(transaction.member_id, transaction.ghost_member_id),
			paidTo: partyName(transaction.related_member_id, transaction.related_ghost_member_id),
			groupId: transaction.group_id,
		})),
	};

	const readme = [
		`Project: ${project.name}`,
		project.description ? `\nDescription:\n${project.description}` : '',
		`\nCurrency: ${project.currency}`,
		`Created: ${project.created_at}`,
		`Exported: ${exportedAt}`,
		'',
		'Contents:',
		'  manifest.json           — authoritative, versioned project snapshot for P2 import',
		'  files/…                 — active project files, mirroring the Files-page folder tree',
		'  trash/files/…           — recoverable trashed/orphaned file contents',
		'  tasks.json              — readable active-task export',
		'  bom.json                — readable active bill of materials',
		'  transactions.json       — readable active money transactions',
		'  members.json            — readable member and ghost-member summary',
		'  README.txt              — this file',
		'',
	].join('\n');

	const entries: ZipEntry[] = [
		textEntry('README.txt', readme),
		jsonEntry('manifest.json', manifest),
		jsonEntry('tasks.json', tasksPayload),
		jsonEntry('bom.json', bomPayload),
		jsonEntry('transactions.json', transactionsPayload),
		jsonEntry('members.json', membersPayload),
		...layout.directoryEntries.map((name) => ({ name, bytes: new Uint8Array() })),
		...storedFiles.map((stored) => ({
			name: layout.filePaths.get(stored.file.id)!,
			bytes: stored.bytes,
		})),
	];

	const bytes = zip(entries);
	return new Response(bytes.buffer as ArrayBuffer, {
		headers: {
			'content-type': 'application/zip',
			'content-length': String(bytes.length),
			'content-disposition': `attachment; filename="${safeArchiveName(project.name)}.zip"`,
			'cache-control': 'private, no-store',
		},
	});
};
