import type { AvatarId } from './avatars';
import type { Database } from './supabase/database.types';

export const PROJECT_EXPORT_FORMAT = 'p2-project-export' as const;
export const PROJECT_EXPORT_VERSION_V1 = 1 as const;
export const PROJECT_EXPORT_VERSION_V2 = 2 as const;
export const PROJECT_EXPORT_VERSION = PROJECT_EXPORT_VERSION_V2;
export const PROJECT_EXPORT_CHECKSUM = 'sha256' as const;
export const PROJECT_PICTURE_ARCHIVE_PATH = 'project-picture.img' as const;

type Tables = Database['public']['Tables'];
type Row<Name extends keyof Tables> = Tables[Name]['Row'];

// Section visibility is added to the database before the export format learns
// about it (see the public-section implementation checklist). Keep the current
// manifest shape stable until the import/export task updates its validation and
// private-by-default remapping together.
export type ProjectExportProject = Omit<
	Row<'projects'>,
	'avatar' | 'public_tasks_enabled' | 'public_journal_enabled' | 'public_money_enabled'
>;
export type ProjectPictureMimeType = 'image/jpeg' | 'image/png' | 'image/webp';
export type ProjectPictureDescriptor =
	| { kind: 'builtin'; id: AvatarId }
	| {
			kind: 'custom';
			archive_path: typeof PROJECT_PICTURE_ARCHIVE_PATH;
			mime_type: ProjectPictureMimeType;
			content_size_bytes: number;
			sha256: string;
	  };

export interface ProjectExportPerson {
	sourceUserId: string;
	displayName: string;
	email: string | null;
}

export type ProjectExportFolder = Row<'folders'> & {
	archive_path: string;
};

export type ProjectExportFile = Omit<Row<'files'>, 'r2_key'> & {
	archive_path: string;
	content_size_bytes: number;
	sha256: string;
};

interface ProjectExportManifestBase {
	format: typeof PROJECT_EXPORT_FORMAT;
	exportedAt: string;
	checksumAlgorithm: typeof PROJECT_EXPORT_CHECKSUM;
	project: ProjectExportProject;
	people: ProjectExportPerson[];
	recordCounts: {
		projectMembers: number;
		ghostMembers: number;
		folders: number;
		files: number;
		bomItems: number;
		transactions: number;
		tasks: number;
		taskAssignees: number;
		taskCategories: number;
		taskCategoryPositions: number;
		journalDrafts: number;
	};
	records: {
		projectMembers: Row<'project_members'>[];
		ghostMembers: Row<'ghost_members'>[];
		folders: ProjectExportFolder[];
		files: ProjectExportFile[];
		bomItems: Row<'bom_items'>[];
		transactions: Row<'transactions'>[];
		tasks: Row<'tasks'>[];
		taskAssignees: Row<'task_assignees'>[];
		taskCategories: Row<'task_categories'>[];
		taskCategoryPositions: Row<'task_category_positions'>[];
		journalDraft: Row<'journal_drafts'> | null;
	};
}

export interface ProjectExportManifestV1 extends ProjectExportManifestBase {
	version: typeof PROJECT_EXPORT_VERSION_V1;
}

export interface ProjectExportManifestV2 extends ProjectExportManifestBase {
	version: typeof PROJECT_EXPORT_VERSION_V2;
	projectPicture: ProjectPictureDescriptor | null;
}

export type ProjectExportManifest = ProjectExportManifestV1 | ProjectExportManifestV2;

interface FolderForLayout {
	id: string;
	name: string;
	parent_folder_id: string | null;
	created_at?: string | null;
	deleted_at?: string | null;
}

interface FileForLayout {
	id: string;
	filename: string;
	folder_id: string | null;
	created_at?: string | null;
	deleted_at?: string | null;
	uploader_deleted_at?: string | null;
}

export interface ProjectArchiveLayout {
	folderPaths: Map<string, string>;
	folderArchivePaths: Map<string, string>;
	filePaths: Map<string, string>;
	directoryEntries: string[];
}

export function safeArchiveName(raw: string): string {
	const cleaned = raw
		.replace(/[<>:"/\\|?*]/g, '-')
		.split('')
		.filter((character) => character.codePointAt(0)! >= 0x20)
		.join('')
		.replace(/\s+/g, ' ')
		.replace(/^[\s.]+|[\s.]+$/g, '');
	return cleaned || 'untitled';
}

function dedupeName(taken: Set<string>, name: string): string {
	if (!taken.has(name)) {
		taken.add(name);
		return name;
	}

	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : '';
	for (let suffix = 2; ; suffix++) {
		const candidate = `${stem} (${suffix})${extension}`;
		if (!taken.has(candidate)) {
			taken.add(candidate);
			return candidate;
		}
	}
}

function stableRecordOrder(a: { id: string; created_at?: string | null }, b: { id: string; created_at?: string | null }) {
	return (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id);
}

function addDirectoryTree(entries: Set<string>, path: string) {
	const parts = path.replace(/\/$/, '').split('/');
	for (let index = 1; index <= parts.length; index++) {
		entries.add(`${parts.slice(0, index).join('/')}/`);
	}
}

export function buildProjectArchiveLayout(
	folders: FolderForLayout[],
	files: FileForLayout[],
): ProjectArchiveLayout {
	const folderById = new Map<string, FolderForLayout>();
	for (const folder of folders) {
		if (folderById.has(folder.id)) throw new Error(`Duplicate folder id: ${folder.id}`);
		folderById.set(folder.id, folder);
	}

	const childrenByParent = new Map<string | null, FolderForLayout[]>();
	for (const folder of folders) {
		if (folder.parent_folder_id && !folderById.has(folder.parent_folder_id)) {
			throw new Error(`Folder ${folder.id} has a missing parent`);
		}
		const siblings = childrenByParent.get(folder.parent_folder_id) ?? [];
		siblings.push(folder);
		childrenByParent.set(folder.parent_folder_id, siblings);
	}

	const segmentById = new Map<string, string>();
	for (const siblings of childrenByParent.values()) {
		const taken = new Set<string>();
		for (const folder of [...siblings].sort(stableRecordOrder)) {
			segmentById.set(folder.id, dedupeName(taken, safeArchiveName(folder.name)));
		}
	}

	const folderPaths = new Map<string, string>();
	const folderTrashState = new Map<string, boolean>();
	const visiting = new Set<string>();
	function resolveFolder(id: string): { path: string; trashed: boolean } {
		const cachedPath = folderPaths.get(id);
		if (cachedPath !== undefined) return { path: cachedPath, trashed: folderTrashState.get(id)! };
		if (visiting.has(id)) throw new Error(`Folder hierarchy contains a cycle at ${id}`);

		visiting.add(id);
		const folder = folderById.get(id)!;
		const parent = folder.parent_folder_id ? resolveFolder(folder.parent_folder_id) : null;
		const path = parent ? `${parent.path}/${segmentById.get(id)!}` : segmentById.get(id)!;
		const trashed = Boolean(folder.deleted_at) || Boolean(parent?.trashed);
		visiting.delete(id);
		folderPaths.set(id, path);
		folderTrashState.set(id, trashed);
		return { path, trashed };
	}

	for (const folder of folders) resolveFolder(folder.id);

	const directoryEntrySet = new Set<string>();
	const folderArchivePaths = new Map<string, string>();
	addDirectoryTree(directoryEntrySet, 'files/');
	for (const folder of folders) {
		const root = folderTrashState.get(folder.id) ? 'trash/files' : 'files';
		const archivePath = `${root}/${folderPaths.get(folder.id)!}/`;
		folderArchivePaths.set(folder.id, archivePath);
		addDirectoryTree(directoryEntrySet, archivePath);
	}

	const filePaths = new Map<string, string>();
	const takenByDirectory = new Map<string, Set<string>>();
	const seenFileIds = new Set<string>();
	for (const file of [...files].sort(stableRecordOrder)) {
		if (seenFileIds.has(file.id)) throw new Error(`Duplicate file id: ${file.id}`);
		seenFileIds.add(file.id);
		if (file.folder_id && !folderById.has(file.folder_id)) {
			throw new Error(`File ${file.id} has a missing folder`);
		}

		const folderPath = file.folder_id ? folderPaths.get(file.folder_id)! : '';
		const isTrashed = Boolean(file.deleted_at || file.uploader_deleted_at)
			|| Boolean(file.folder_id && folderTrashState.get(file.folder_id));
		const root = isTrashed ? 'trash/files' : 'files';
		const directory = folderPath ? `${root}/${folderPath}` : root;
		const taken = takenByDirectory.get(directory) ?? new Set<string>();
		takenByDirectory.set(directory, taken);
		const filename = dedupeName(taken, safeArchiveName(file.filename));
		filePaths.set(file.id, `${directory}/${filename}`);
		addDirectoryTree(directoryEntrySet, `${directory}/`);
	}

	return {
		folderPaths,
		folderArchivePaths,
		filePaths,
		directoryEntries: [...directoryEntrySet].sort(),
	};
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}
