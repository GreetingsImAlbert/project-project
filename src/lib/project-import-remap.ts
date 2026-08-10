import type { Database } from './supabase/database.types';
import { ProjectImportError } from './project-import';
import type { ProjectImportOwnershipPlan } from './project-import-policy';
import { safeArchiveName } from './project-export';
import type { ProjectExportManifestV1 } from './project-export';

type Tables = Database['public']['Tables'];
type Row<Name extends keyof Tables> = Tables[Name]['Row'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ImportProjectRow = Pick<
	Row<'projects'>,
	'name' | 'description' | 'owner_id' | 'currency' | 'is_public' | 'public_files_enabled' | 'created_at' | 'updated_at'
> & { id: string };

export type ImportMemberRow = Pick<
	Row<'project_members'>,
	'project_id' | 'user_id' | 'role' | 'is_auditor' | 'contribution_percent' | 'joined_at'
>;

export type ImportGhostRow = Pick<
	Row<'ghost_members'>,
	'id' | 'project_id' | 'display_name' | 'note' | 'contribution_percent' | 'is_deleted_account' | 'created_at'
>;

export type ImportFolderRow = Row<'folders'>;
export type ImportFileRow = Row<'files'>;
export type ImportBomRow = Omit<Row<'bom_items'>, 'total_cost'>;
export type ImportTransactionRow = Omit<Row<'transactions'>, 'total_cost'>;
export type ImportTaskRow = Row<'tasks'>;
export type ImportTaskAssigneeRow = Row<'task_assignees'>;
export type ImportTaskCategoryRow = Row<'task_categories'>;
export type ImportTaskCategoryPositionRow = Row<'task_category_positions'>;
export type ImportJournalDraftRow = Row<'journal_drafts'>;

export interface ProjectImportRemappedPayload {
	project: ImportProjectRow;
	projectMember: ImportMemberRow;
	ghostMembers: ImportGhostRow[];
	folders: ImportFolderRow[];
	files: ImportFileRow[];
	bomItems: ImportBomRow[];
	transactions: ImportTransactionRow[];
	tasks: ImportTaskRow[];
	taskAssignees: ImportTaskAssigneeRow[];
	taskCategories: ImportTaskCategoryRow[];
	taskCategoryPositions: ImportTaskCategoryPositionRow[];
	journalDraft: ImportJournalDraftRow | null;
}

export interface ProjectImportIdMaps {
	projectId: string;
	ghostIdsBySourceKey: Map<string, string>;
	folderIdsBySourceId: Map<string, string>;
	fileIdsBySourceId: Map<string, string>;
	bomIdsBySourceId: Map<string, string>;
	transactionIdsBySourceId: Map<string, string>;
	taskIdsBySourceId: Map<string, string>;
	assigneeIdsBySourceId: Map<string, string>;
	categoryPositionIdsBySourceId: Map<string, string>;
}

export interface RemappedProjectImport {
	payload: ProjectImportRemappedPayload;
	maps: ProjectImportIdMaps;
}

export interface ProjectImportRemapOptions {
	idFactory?: () => string;
	now?: string;
}

function defaultIdFactory(): string {
	return crypto.randomUUID();
}

function newId(
	factory: () => string,
	used: Set<string>,
	label: string,
): string {
	const id = factory();
	if (!UUID_PATTERN.test(id) || used.has(id)) throw new ProjectImportError(`Could not generate a unique ID for ${label}.`);
	used.add(id);
	return id;
}

function requiredMapValue<T>(map: Map<string, T>, key: string, label: string): T {
	const value = map.get(key);
	if (value === undefined) throw new ProjectImportError(`Invalid import relationship: ${label} is missing.`);
	return value;
}

function remapGhostId(
	plan: ProjectImportOwnershipPlan,
	maps: ProjectImportIdMaps,
	userId: string | null,
	ghostId: string | null,
	label: string,
): string | null {
	if (userId !== null) {
		const sourceKey = plan.personGhostKeys[userId];
		if (!sourceKey) throw new ProjectImportError(`Invalid import relationship: ${label} person is missing.`);
		return requiredMapValue(maps.ghostIdsBySourceKey, sourceKey, label);
	}
	if (ghostId !== null) {
		const sourceKey = plan.exportedGhostKeys[ghostId];
		if (!sourceKey) throw new ProjectImportError(`Invalid import relationship: ${label} ghost is missing.`);
		return requiredMapValue(maps.ghostIdsBySourceKey, sourceKey, label);
	}
	return null;
}

function fileKey(projectId: string, fileId: string, filename: string): string {
	return `${projectId}/${fileId}-${safeArchiveName(filename)}`;
}

/**
 * Creates the destination-only database payload. Source IDs are used only in
 * short-lived maps while this function runs; no source ID is emitted in the
 * payload. Profile references that have no ghost-capable column are assigned to
 * the importer, which also makes every imported file byte count against them.
 */
export function remapProjectImport(
	manifest: ProjectExportManifestV1,
	ownership: ProjectImportOwnershipPlan,
	options: ProjectImportRemapOptions = {},
): RemappedProjectImport {
	const policy = planOrThrow(ownership);
	const factory = options.idFactory ?? defaultIdFactory;
	const now = options.now ?? new Date().toISOString();
	const usedIds = new Set<string>();
	const projectId = newId(factory, usedIds, 'project');

	const maps: ProjectImportIdMaps = {
		projectId,
		ghostIdsBySourceKey: new Map(),
		folderIdsBySourceId: new Map(),
		fileIdsBySourceId: new Map(),
		bomIdsBySourceId: new Map(),
		transactionIdsBySourceId: new Map(),
		taskIdsBySourceId: new Map(),
		assigneeIdsBySourceId: new Map(),
		categoryPositionIdsBySourceId: new Map(),
	};

	const project: ImportProjectRow = {
		id: projectId,
		name: ownership.project.name,
		description: ownership.project.description,
		owner_id: policy.project.owner_id,
		currency: ownership.project.currency,
		is_public: false,
		public_files_enabled: false,
		created_at: manifest.project.created_at,
		updated_at: manifest.project.updated_at,
	};

	const ghostMembers: ImportGhostRow[] = ownership.ghostMembers.map((ghost) => {
		const id = newId(factory, usedIds, 'ghost member');
		maps.ghostIdsBySourceKey.set(ghost.sourceKey, id);
		return {
			id,
			project_id: projectId,
			display_name: ghost.display_name,
			note: ghost.note,
			contribution_percent: ghost.contribution_percent,
			is_deleted_account: ghost.is_deleted_account,
			created_at: ghost.created_at,
		};
	});

	const foldersBySourceId = new Map(manifest.records.folders.map((folder) => {
		const id = newId(factory, usedIds, 'folder');
		maps.folderIdsBySourceId.set(folder.id, id);
		return [folder.id, id] as const;
	}));
	const folders: ImportFolderRow[] = manifest.records.folders.map((folder) => ({
		id: requiredMapValue(foldersBySourceId, folder.id, 'folder'),
		project_id: projectId,
		name: folder.name,
		parent_folder_id: folder.parent_folder_id
			? requiredMapValue(foldersBySourceId, folder.parent_folder_id, 'folder parent')
			: null,
		created_at: folder.created_at,
		deleted_at: folder.deleted_at,
	}));

	const filesBySourceId = new Map(manifest.records.files.map((file) => {
		const id = newId(factory, usedIds, 'file');
		maps.fileIdsBySourceId.set(file.id, id);
		return [file.id, id] as const;
	}));
	const files: ImportFileRow[] = manifest.records.files.map((file) => {
		const id = requiredMapValue(filesBySourceId, file.id, 'file');
		return {
			id,
			project_id: projectId,
			folder_id: file.folder_id ? requiredMapValue(foldersBySourceId, file.folder_id, 'file folder') : null,
			// There is no ghost uploader column. The importer owns every imported byte.
			uploaded_by: policy.realMember.user_id,
			filename: file.filename,
			mime_type: file.mime_type,
			size_bytes: file.content_size_bytes,
			storage_provider: 'r2',
			uploader_deleted_at: null,
			created_at: file.created_at,
			deleted_at: file.deleted_at,
			is_public: false,
			is_journal: file.is_journal,
			r2_key: fileKey(projectId, id, file.filename),
		};
	});

	const bomIdsBySourceId = new Map(manifest.records.bomItems.map((item) => {
		const id = newId(factory, usedIds, 'BOM item');
		maps.bomIdsBySourceId.set(item.id, id);
		return [item.id, id] as const;
	}));
	const bomItems: ImportBomRow[] = manifest.records.bomItems.map((item) => ({
		id: requiredMapValue(bomIdsBySourceId, item.id, 'BOM item'),
		project_id: projectId,
		part_name: item.part_name,
		category: item.category,
		description: item.description,
		quantity: item.quantity,
		unit: item.unit,
		unit_cost: item.unit_cost,
		supplier: item.supplier,
		item_url: item.item_url,
		created_at: item.created_at,
		deleted_at: item.deleted_at,
	}));

	const transactionIdsBySourceId = new Map(manifest.records.transactions.map((transaction) => {
		const id = newId(factory, usedIds, 'transaction');
		maps.transactionIdsBySourceId.set(transaction.id, id);
		return [transaction.id, id] as const;
	}));
	const transactions: ImportTransactionRow[] = manifest.records.transactions.map((transaction) => ({
		id: requiredMapValue(transactionIdsBySourceId, transaction.id, 'transaction'),
		project_id: projectId,
		member_id: null,
		related_member_id: null,
		ghost_member_id: remapGhostId(policy, maps, transaction.member_id, transaction.ghost_member_id, 'transaction payer'),
		related_ghost_member_id: remapGhostId(policy, maps, transaction.related_member_id, transaction.related_ghost_member_id, 'transaction payee'),
		group_id: transaction.group_id ? requiredMapValue(transactionIdsBySourceId, transaction.group_id, 'transaction group') : null,
		transaction_date: transaction.transaction_date,
		type: transaction.type,
		item_name: transaction.item_name,
		quantity: transaction.quantity,
		unit: transaction.unit,
		unit_cost: transaction.unit_cost,
		supplier: transaction.supplier,
		item_url: transaction.item_url,
		created_at: transaction.created_at,
		deleted_at: transaction.deleted_at,
	}));

	const taskIdsBySourceId = new Map(manifest.records.tasks.map((task) => {
		const id = newId(factory, usedIds, 'task');
		maps.taskIdsBySourceId.set(task.id, id);
		return [task.id, id] as const;
	}));
	const tasks: ImportTaskRow[] = manifest.records.tasks.map((task) => ({
		id: requiredMapValue(taskIdsBySourceId, task.id, 'task'),
		project_id: projectId,
		name: task.name,
		category: task.category,
		priority_position: task.priority_position,
		description: task.description,
		start_date: task.start_date,
		start_time: task.start_time,
		deadline: task.deadline,
		deadline_time: task.deadline_time,
		status: task.status,
		created_at: task.created_at,
		deleted_at: task.deleted_at,
	}));

	const assigneeIdsBySourceId = new Map(manifest.records.taskAssignees.map((assignee) => {
		const id = newId(factory, usedIds, 'task assignee');
		maps.assigneeIdsBySourceId.set(assignee.id, id);
		return [assignee.id, id] as const;
	}));
	const taskAssignees: ImportTaskAssigneeRow[] = manifest.records.taskAssignees.map((assignee) => ({
		id: requiredMapValue(assigneeIdsBySourceId, assignee.id, 'task assignee'),
		task_id: requiredMapValue(taskIdsBySourceId, assignee.task_id, 'task assignee task'),
		user_id: null,
		ghost_member_id: remapGhostId(policy, maps, assignee.user_id, assignee.ghost_member_id, 'task assignee'),
		deleted_display_name: assignee.deleted_display_name,
	}));

	const categoryNames = new Set<string>();
	const taskCategories: ImportTaskCategoryRow[] = manifest.records.taskCategories.map((category) => {
		if (categoryNames.has(category.name)) throw new ProjectImportError('Invalid import relationship: duplicate task category.');
		categoryNames.add(category.name);
		return {
			project_id: projectId,
			name: category.name,
			color_index: category.color_index,
		};
	});

	const categoryPositionIdsBySourceId = new Map(manifest.records.taskCategoryPositions.map((position) => {
		const id = newId(factory, usedIds, 'task category position');
		maps.categoryPositionIdsBySourceId.set(position.id, id);
		return [position.id, id] as const;
	}));
	const taskCategoryPositions: ImportTaskCategoryPositionRow[] = manifest.records.taskCategoryPositions.map((position) => ({
		id: requiredMapValue(categoryPositionIdsBySourceId, position.id, 'task category position'),
		project_id: projectId,
		category_name: position.category_name,
		priority_position: position.priority_position,
		created_at: position.created_at,
	}));

	const journalDraft: ImportJournalDraftRow | null = manifest.records.journalDraft
		? {
			project_id: projectId,
			draft_date: manifest.records.journalDraft.draft_date,
			content: manifest.records.journalDraft.content,
			updated_at: manifest.records.journalDraft.updated_at,
			// This profile-only relationship cannot point to a ghost member.
			updated_by: policy.realMember.user_id,
		}
		: null;

	return {
		payload: {
			project,
			projectMember: {
				project_id: projectId,
				user_id: policy.realMember.user_id,
				role: 'owner',
				is_auditor: false,
				contribution_percent: null,
				joined_at: now,
			},
			ghostMembers,
			folders,
			files,
			bomItems,
			transactions,
			tasks,
			taskAssignees,
			taskCategories,
			taskCategoryPositions,
			journalDraft,
		},
		maps,
	};
}

// The ownership plan is already validated by task 6. Keeping this tiny helper
// makes the relationship remappers read as data-only operations and gives later
// callers one place to add a defensive policy assertion.
function planOrThrow(plan: ProjectImportOwnershipPlan): ProjectImportOwnershipPlan {
	if (plan.realMember.role !== 'owner' || plan.realMember.is_auditor || plan.project.is_public || plan.project.public_files_enabled) {
		throw new ProjectImportError('Invalid import ownership policy.');
	}
	return plan;
}
