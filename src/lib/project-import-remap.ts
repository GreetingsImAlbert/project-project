import type { Database } from './supabase/database.types';
import { ProjectImportError } from './project-import';
import type { ProjectImportOwnershipPlan } from './project-import-policy';
import { safeArchiveName } from './project-export';
import type { ProjectExportManifest, ProjectExportFileV3, ProjectExportFolderV3 } from './project-export';
import { projectAvatarStoragePath } from './avatars';

type Tables = Database['public']['Tables'];
type Row<Name extends keyof Tables> = Tables[Name]['Row'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ImportProjectRow = Pick<
	Row<'projects'>,
	'avatar' | 'name' | 'description' | 'owner_id' | 'currency' | 'is_public' | 'public_files_enabled' | 'created_at' | 'updated_at'
> & {
	id: string;
	public_tasks_enabled: boolean;
	public_journal_enabled: boolean;
	public_money_enabled: boolean;
};

export type ImportMemberRow = Pick<
	Row<'project_members'>,
	'project_id' | 'user_id' | 'role' | 'is_auditor' | 'contribution_percent' | 'joined_at'
>;

export type ImportGhostRow = Pick<
	Row<'ghost_members'>,
	'id' | 'project_id' | 'display_name' | 'note' | 'contribution_percent' | 'is_deleted_account' | 'created_at'
>;

// Import accepts legacy manifests that do not carry the post-journal-overhaul
// folder/file metadata; the import RPC applies the schema defaults.
export type ImportFolderRow = Omit<Row<'folders'>, 'is_journals_folder'> & {
	is_journals_folder: boolean;
};
export type ImportFileRow = Omit<Row<'files'>, 'journal_kind' | 'journal_visibility'> & {
	journal_kind: string | null;
	journal_visibility: string | null;
};
export type ImportBomRow = Omit<Row<'bom_items'>, 'total_cost'>;
export type ImportTransactionRow = Omit<Row<'transactions'>, 'total_cost'>;
export type ImportTaskRow = Row<'tasks'>;
export type ImportTaskAssigneeRow = Row<'task_assignees'>;
export type ImportTaskCategoryRow = Row<'task_categories'>;
export type ImportTaskCategoryPositionRow = Row<'task_category_positions'>;
export type ImportJournalDraftRow = Omit<Row<'journal_drafts'>, 'journal_file_id'> & {
	journal_file_id: string;
};

export type LegacyImportJournalDraftRow = Omit<ImportJournalDraftRow, 'journal_file_id'> & {
	journal_file_id?: string;
};

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
	journalDrafts: ImportJournalDraftRow[];
	/** @deprecated V1/V2 compatibility alias; new RPC payloads use journalDrafts. */
	journalDraft: LegacyImportJournalDraftRow | null;
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
	projectPicturePath: string | null;
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
	manifest: ProjectExportManifest,
	ownership: ProjectImportOwnershipPlan,
	options: ProjectImportRemapOptions = {},
): RemappedProjectImport {
	const policy = planOrThrow(ownership);
	const factory = options.idFactory ?? defaultIdFactory;
	const now = options.now ?? new Date().toISOString();
	const usedIds = new Set<string>();
	const projectId = newId(factory, usedIds, 'project');
	const projectPicturePath = manifest.version !== 1 && manifest.projectPicture?.kind === 'custom'
		? projectAvatarStoragePath(projectId)
		: null;
	const projectAvatar = manifest.version !== 1 && manifest.projectPicture?.kind === 'builtin'
		? manifest.projectPicture.id
		: projectPicturePath;

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
		avatar: projectAvatar,
		name: ownership.project.name,
		description: ownership.project.description,
		owner_id: policy.project.owner_id,
		currency: ownership.project.currency,
		is_public: false,
		public_files_enabled: false,
		public_tasks_enabled: false,
		public_journal_enabled: false,
		public_money_enabled: false,
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

	const sourceFolders = manifest.records.folders;
	const sourceFiles = manifest.records.files;
	const legacyManifest = manifest.version !== 3;
	const sourceGroupJournals = sourceFiles.filter((file) => file.is_journal && (legacyManifest || file.journal_kind === 'group'));
	if (legacyManifest && sourceGroupJournals.length > 1) {
		throw new ProjectImportError('Legacy import contains duplicate journal files.');
	}
	if (!legacyManifest) {
		const protectedFolders = sourceFolders.filter((folder) => folder.is_journals_folder);
		if (protectedFolders.length !== 1) throw new ProjectImportError('Invalid import: exactly one protected journals folder is required.');
		if (sourceGroupJournals.length !== 1 || sourceGroupJournals[0].deleted_at !== null) {
			throw new ProjectImportError('Invalid import: exactly one live group journal is required.');
		}
		for (const file of sourceFiles) {
			if (file.is_journal && file.folder_id !== protectedFolders[0].id) {
				throw new ProjectImportError('Invalid import: journal file is outside the protected journals folder.');
			}
		}
	}

	const foldersBySourceId = new Map(sourceFolders.map((folder) => {
		const id = newId(factory, usedIds, 'folder');
		maps.folderIdsBySourceId.set(folder.id, id);
		return [folder.id, id] as const;
	}));
	const folders: ImportFolderRow[] = sourceFolders.map((folder) => ({
		id: requiredMapValue(foldersBySourceId, folder.id, 'folder'),
		project_id: projectId,
		name: folder.name,
		parent_folder_id: folder.parent_folder_id
			? requiredMapValue(foldersBySourceId, folder.parent_folder_id, 'folder parent')
			: null,
		created_at: folder.created_at,
		deleted_at: folder.deleted_at,
		is_journals_folder: manifest.version === 3 ? (folder as ProjectExportFolderV3).is_journals_folder : false,
	}));
	let journalsFolderId: string;
	if (manifest.version === 3) {
		const sourceJournalsFolder = sourceFolders.find((folder) => folder.is_journals_folder);
		if (!sourceJournalsFolder) throw new ProjectImportError('Invalid import: protected journals folder is missing.');
		journalsFolderId = requiredMapValue(foldersBySourceId, sourceJournalsFolder.id, 'journals folder');
	} else if (sourceGroupJournals.length > 0) {
		journalsFolderId = newId(factory, usedIds, 'journals folder');
		folders.push({
			id: journalsFolderId,
			project_id: projectId,
			name: 'journals',
			parent_folder_id: null,
			created_at: now,
			deleted_at: null,
			is_journals_folder: true,
		});
	} else {
		// A few early fixtures contain a draft row without the legacy file row.
		// Preserve that compatibility shape for callers, but do not invent a
		// protected folder when there is no Markdown object to import.
		journalsFolderId = '';
	}

	const filesBySourceId = new Map(sourceFiles.map((file) => {
		const id = newId(factory, usedIds, 'file');
		maps.fileIdsBySourceId.set(file.id, id);
		return [file.id, id] as const;
	}));
	const activePersonalSourceId = manifest.version === 3
		? [...sourceFiles]
			.filter((file) => file.is_journal && file.journal_kind === 'personal' && file.deleted_at === null)
			.sort((left, right) => (left.created_at ?? '').localeCompare(right.created_at ?? '') || left.id.localeCompare(right.id))[0]?.id ?? null
		: null;
	const journalKindOf = (file: (typeof sourceFiles)[number]): string | null => {
		if (!file.is_journal) return null;
		return manifest.version === 3 ? (file as ProjectExportFileV3).journal_kind : 'group';
	};
	const journalVisibilityOf = (file: (typeof sourceFiles)[number]): string | null => {
		if (!file.is_journal || manifest.version !== 3) return null;
		return (file as ProjectExportFileV3).journal_visibility;
	};
	const historyOnlyPersonalIds = new Set(
		sourceFiles
			.filter((file) => journalKindOf(file) === 'personal' && file.deleted_at === null && file.id !== activePersonalSourceId)
			.map((file) => file.id),
	);
	const files: ImportFileRow[] = sourceFiles.map((file) => {
		const id = requiredMapValue(filesBySourceId, file.id, 'file');
		const journalKind = journalKindOf(file);
		const filename = legacyManifest && journalKind === 'group' ? 'JOURNAL.md' : file.filename;
		const historyOnly = historyOnlyPersonalIds.has(file.id);
		return {
			id,
			project_id: projectId,
			folder_id: file.is_journal
				? journalsFolderId
				: file.folder_id ? requiredMapValue(foldersBySourceId, file.folder_id, 'file folder') : null,
			// There is no ghost uploader column. The importer owns every imported byte.
			uploaded_by: policy.realMember.user_id,
			filename,
			mime_type: file.mime_type,
			size_bytes: file.content_size_bytes,
			storage_provider: 'r2',
			uploader_deleted_at: null,
			created_at: file.created_at,
			deleted_at: historyOnly ? now : file.deleted_at,
			is_public: false,
			is_journal: file.is_journal,
			journal_kind: journalKind,
			journal_visibility: journalVisibilityOf(file),
			r2_key: fileKey(projectId, id, filename),
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

	const legacyDraft = manifest.version === 3 ? null : manifest.records.journalDraft;
	const sourceDrafts = manifest.version === 3
		? manifest.records.journalDrafts
		: legacyDraft && sourceGroupJournals[0]
			? [{ ...legacyDraft, journal_file_id: sourceGroupJournals[0].id }]
			: [];
	const journalDrafts: ImportJournalDraftRow[] = sourceDrafts.flatMap((draft) => {
		const sourceFile = sourceFiles.find((file) => file.id === draft.journal_file_id);
		if (!sourceFile || !sourceFile.is_journal) throw new ProjectImportError('Invalid import relationship: journal draft file is missing.');
		if (historyOnlyPersonalIds.has(sourceFile.id)) return [];
		return [{
			journal_file_id: requiredMapValue(filesBySourceId, draft.journal_file_id, 'journal draft file'),
			project_id: projectId,
			draft_date: draft.draft_date,
			content: draft.content,
			updated_at: draft.updated_at,
			// This profile-only relationship cannot point to a ghost member.
			updated_by: policy.realMember.user_id,
		}];
	});
	const journalDraft: LegacyImportJournalDraftRow | null = legacyDraft
		? {
			...(sourceGroupJournals[0] ? { journal_file_id: requiredMapValue(filesBySourceId, sourceGroupJournals[0].id, 'legacy journal file') } : {}),
			project_id: projectId,
			draft_date: legacyDraft.draft_date,
			content: legacyDraft.content,
			updated_at: legacyDraft.updated_at,
			updated_by: policy.realMember.user_id,
		}
		: journalDrafts[0] ?? null;

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
			journalDrafts,
			journalDraft,
		},
		maps,
		projectPicturePath,
	};
}

// The ownership plan is already validated by task 6. Keeping this tiny helper
// makes the relationship remappers read as data-only operations and gives later
// callers one place to add a defensive policy assertion.
function planOrThrow(plan: ProjectImportOwnershipPlan): ProjectImportOwnershipPlan {
	if (
		plan.realMember.role !== 'owner'
		|| plan.realMember.is_auditor
		|| plan.project.is_public
		|| plan.project.public_files_enabled
		|| plan.project.public_tasks_enabled
		|| plan.project.public_journal_enabled
		|| plan.project.public_money_enabled
	) {
		throw new ProjectImportError('Invalid import ownership policy.');
	}
	return plan;
}
