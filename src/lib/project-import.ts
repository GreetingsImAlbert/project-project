import { buildProjectArchiveLayout, sha256Hex, type ProjectExportManifestV1 } from './project-export';
import type { Database } from './supabase/database.types';
import { crc32 } from './zip';

type Tables = Database['public']['Tables'];
type Row<Name extends keyof Tables> = Tables[Name]['Row'];

export const PROJECT_IMPORT_LIMITS = {
	maxArchiveBytes: 90 * 1_000_000,
	maxZipEntries: 10_000,
	maxZipCompressedBytes: 90 * 1_000_000,
	maxZipUncompressedBytes: 100 * 1_000_000,
	maxFileBytes: 80 * 1_000_000,
	maxManifestBytes: 16 * 1_000_000,
	maxRecordRows: 50_000,
	maxPathLength: 1_024,
	maxStringLength: 100_000,
} as const;

const PROJECT_EXPORT_FORMAT = 'p2-project-export';
const PROJECT_EXPORT_VERSION = 1;
const PROJECT_EXPORT_CHECKSUM = 'sha256';
const REQUIRED_ENTRIES = ['README.txt', 'manifest.json', 'tasks.json', 'bom.json', 'transactions.json', 'members.json'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const TRANSACTION_TYPES = new Set(['item', 'shipping', 'discount', 'refund', 'payment', 'bulk']);

export class ProjectImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectImportError';
	}
}

export interface ProjectArchiveEntry {
	name: string;
	bytes: Uint8Array<ArrayBuffer>;
	isDirectory: boolean;
	compressedSize: number;
	uncompressedSize: number;
}

export interface ParsedProjectZip {
	entries: Map<string, ProjectArchiveEntry>;
	totalCompressedBytes: number;
	totalUncompressedBytes: number;
}

export interface ValidatedProjectImport {
	manifest: ProjectExportManifestV1;
	archive: ParsedProjectZip;
	projectName: string;
	fileBytes: number;
}

function fail(message: string): never {
	throw new ProjectImportError(message);
}

function ensureRange(bytes: Uint8Array<ArrayBuffer>, offset: number, length: number, label: string) {
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
		fail(`Malformed ZIP: ${label} is outside the archive.`);
	}
}

function readU16(view: DataView, offset: number, label: string): number {
	try {
		return view.getUint16(offset, true);
	} catch {
		fail(`Malformed ZIP: could not read ${label}.`);
	}
}

function readU32(view: DataView, offset: number, label: string): number {
	try {
		return view.getUint32(offset, true);
	} catch {
		fail(`Malformed ZIP: could not read ${label}.`);
	}
}

function decodeUtf8(bytes: Uint8Array<ArrayBuffer>, label: string): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		fail(`Malformed ZIP: ${label} is not valid UTF-8.`);
	}
}

function equalBytes(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBuffer>): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
	return true;
}

function validateEntryName(name: string): boolean {
	if (!name || name.length > PROJECT_IMPORT_LIMITS.maxPathLength || name.includes('\\') || name.startsWith('/')) {
		fail('Malformed ZIP: unsafe archive path.');
	}
	for (const character of name) if (character.codePointAt(0)! < 0x20 || character === '\u007f') fail('Malformed ZIP: unsafe archive path.');

	const isDirectory = name.endsWith('/');
	const parts = (isDirectory ? name.slice(0, -1) : name).split('/');
	if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
		fail('Malformed ZIP: unsafe archive path.');
	}
	return isDirectory;
}

function findEndOfCentralDirectory(bytes: Uint8Array<ArrayBuffer>): number {
	const minimumOffset = Math.max(0, bytes.length - 65_557);
	for (let offset = bytes.length - 22; offset >= minimumOffset; offset--) {
		if (offset >= 0 && bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) {
			return offset;
		}
	}
	fail('Malformed ZIP: end-of-central-directory record is missing.');
}

export function parseProjectZip(bytes: Uint8Array<ArrayBuffer>): ParsedProjectZip {
	if (bytes.length === 0) fail('The uploaded archive is empty.');
	if (bytes.length > PROJECT_IMPORT_LIMITS.maxArchiveBytes) fail('The uploaded archive is too large.');

	const eocdOffset = findEndOfCentralDirectory(bytes);
	ensureRange(bytes, eocdOffset, 22, 'end-of-central-directory record');
	const eocd = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const diskNumber = readU16(eocd, eocdOffset + 4, 'disk number');
	const centralDiskNumber = readU16(eocd, eocdOffset + 6, 'central-directory disk number');
	const diskEntries = readU16(eocd, eocdOffset + 8, 'disk entry count');
	const totalEntries = readU16(eocd, eocdOffset + 10, 'entry count');
	const centralSize = readU32(eocd, eocdOffset + 12, 'central-directory size');
	const centralOffset = readU32(eocd, eocdOffset + 16, 'central-directory offset');
	const commentLength = readU16(eocd, eocdOffset + 20, 'comment length');

	if (eocdOffset + 22 + commentLength !== bytes.length) fail('Malformed ZIP: trailing data or invalid comment length.');
	if (diskNumber !== 0 || centralDiskNumber !== 0 || diskEntries !== totalEntries) fail('Malformed ZIP: multi-disk archives are not supported.');
	if (totalEntries === 0 || totalEntries > PROJECT_IMPORT_LIMITS.maxZipEntries) fail('Malformed ZIP: invalid entry count.');
	if (centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('ZIP64 archives are not supported.');
	if (centralOffset + centralSize !== eocdOffset) fail('Malformed ZIP: invalid central-directory bounds.');
	ensureRange(bytes, centralOffset, centralSize, 'central directory');

	interface CentralRecord {
		name: string;
		nameBytes: Uint8Array<ArrayBuffer>;
		isDirectory: boolean;
		flags: number;
		method: number;
		crc: number;
		compressedSize: number;
		uncompressedSize: number;
		localOffset: number;
	}

	const records: CentralRecord[] = [];
	const names = new Set<string>();
	let cursor = centralOffset;
	let totalCompressedBytes = 0;
	let totalUncompressedBytes = 0;
	for (let index = 0; index < totalEntries; index++) {
		ensureRange(bytes, cursor, 46, 'central-directory entry');
		if (readU32(eocd, cursor, 'central-directory signature') !== 0x02014b50) fail('Malformed ZIP: invalid central-directory signature.');
		const versionNeeded = readU16(eocd, cursor + 6, 'version needed');
		const flags = readU16(eocd, cursor + 8, 'flags');
		const method = readU16(eocd, cursor + 10, 'compression method');
		const crc = readU32(eocd, cursor + 16, 'CRC');
		const compressedSize = readU32(eocd, cursor + 20, 'compressed size');
		const uncompressedSize = readU32(eocd, cursor + 24, 'uncompressed size');
		const nameLength = readU16(eocd, cursor + 28, 'filename length');
		const extraLength = readU16(eocd, cursor + 30, 'extra-field length');
		const entryCommentLength = readU16(eocd, cursor + 32, 'entry comment length');
		const entryDisk = readU16(eocd, cursor + 34, 'entry disk number');
		const localOffset = readU32(eocd, cursor + 42, 'local-header offset');
		const headerLength = 46 + nameLength + extraLength + entryCommentLength;
		ensureRange(bytes, cursor, headerLength, 'central-directory entry data');

		if (versionNeeded !== 20 || flags !== 0x0800 || method !== 0 || extraLength !== 0 || entryCommentLength !== 0 || entryDisk !== 0) {
			fail('Unsupported ZIP: only P2 stored archives are accepted.');
		}
		if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) fail('ZIP64 archives are not supported.');
		if (compressedSize !== uncompressedSize) fail('Unsupported ZIP: compressed entries are not accepted.');
		if (compressedSize > PROJECT_IMPORT_LIMITS.maxFileBytes || uncompressedSize > PROJECT_IMPORT_LIMITS.maxFileBytes) fail('ZIP entry is too large.');

		const nameBytes = bytes.slice(cursor + 46, cursor + 46 + nameLength);
		const name = decodeUtf8(nameBytes, 'filename');
		const isDirectory = validateEntryName(name);
		if (names.has(name)) fail('Malformed ZIP: duplicate archive entry.');
		names.add(name);
		if (isDirectory && uncompressedSize !== 0) fail('Malformed ZIP: directory entry contains data.');
		totalCompressedBytes += compressedSize;
		totalUncompressedBytes += uncompressedSize;
		if (totalCompressedBytes > PROJECT_IMPORT_LIMITS.maxZipCompressedBytes || totalUncompressedBytes > PROJECT_IMPORT_LIMITS.maxZipUncompressedBytes) {
			fail('ZIP archive exceeds the allowed size.');
		}

		records.push({ name, nameBytes, isDirectory, flags, method, crc, compressedSize, uncompressedSize, localOffset });
		cursor += headerLength;
	}
	if (cursor !== centralOffset + centralSize) fail('Malformed ZIP: central-directory entry count does not match its size.');

	const ranges: { start: number; end: number }[] = [];
	const entries = new Map<string, ProjectArchiveEntry>();
	for (const record of records) {
		ensureRange(bytes, record.localOffset, 30, 'local header');
		if (readU32(eocd, record.localOffset, 'local-header signature') !== 0x04034b50) fail('Malformed ZIP: invalid local-header signature.');
		const localVersion = readU16(eocd, record.localOffset + 4, 'local version');
		const localFlags = readU16(eocd, record.localOffset + 6, 'local flags');
		const localMethod = readU16(eocd, record.localOffset + 8, 'local compression method');
		const localCrc = readU32(eocd, record.localOffset + 14, 'local CRC');
		const localCompressedSize = readU32(eocd, record.localOffset + 18, 'local compressed size');
		const localUncompressedSize = readU32(eocd, record.localOffset + 22, 'local uncompressed size');
		const localNameLength = readU16(eocd, record.localOffset + 26, 'local filename length');
		const localExtraLength = readU16(eocd, record.localOffset + 28, 'local extra-field length');
		if (localVersion !== 20 || localFlags !== record.flags || localMethod !== record.method || localCrc !== record.crc || localCompressedSize !== record.compressedSize || localUncompressedSize !== record.uncompressedSize || localExtraLength !== 0 || localNameLength !== record.nameBytes.length) {
			fail('Malformed ZIP: local and central entry headers differ.');
		}
		ensureRange(bytes, record.localOffset + 30, localNameLength, 'local filename');
		if (!equalBytes(bytes.slice(record.localOffset + 30, record.localOffset + 30 + localNameLength), record.nameBytes)) fail('Malformed ZIP: local filename differs from central filename.');
		const dataStart = record.localOffset + 30 + localNameLength;
		const dataEnd = dataStart + record.compressedSize;
		if (dataEnd > centralOffset) fail('Malformed ZIP: entry overlaps the central directory.');
		const data = bytes.slice(dataStart, dataEnd);
		if (crc32(data) !== record.crc) fail('Malformed ZIP: CRC check failed.');
		ranges.push({ start: record.localOffset, end: dataEnd });
		entries.set(record.name, {
			name: record.name,
			bytes: data,
			isDirectory: record.isDirectory,
			compressedSize: record.compressedSize,
			uncompressedSize: record.uncompressedSize,
		});
	}

	ranges.sort((left, right) => left.start - right.start);
	if (ranges.length === 0 || ranges[0].start !== 0) fail('Malformed ZIP: local entries do not start at the archive beginning.');
	for (let index = 1; index < ranges.length; index++) {
		if (ranges[index].start < ranges[index - 1].end) fail('Malformed ZIP: overlapping local entries.');
		if (ranges[index].start !== ranges[index - 1].end) fail('Malformed ZIP: unexpected data between local entries.');
	}
	if (ranges[ranges.length - 1].end !== centralOffset) fail('Malformed ZIP: local entries do not end at the central directory.');

	return { entries, totalCompressedBytes, totalUncompressedBytes };
}

type RecordObject = Record<string, unknown>;

function object(value: unknown, label: string): RecordObject {
	if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Invalid manifest: ${label} must be an object.`);
	return value as RecordObject;
}

function exactKeys(value: RecordObject, label: string, keys: string[]) {
	const expected = new Set(keys);
	for (const key of keys) if (!Object.hasOwn(value, key)) fail(`Invalid manifest: ${label}.${key} is missing.`);
	for (const key of Object.keys(value)) if (!expected.has(key)) fail(`Invalid manifest: unexpected ${label}.${key}.`);
}

function string(value: unknown, label: string, max: number = PROJECT_IMPORT_LIMITS.maxStringLength): string {
	if (typeof value !== 'string' || value.length > max) fail(`Invalid manifest: ${label} must be a bounded string.`);
	return value;
}

function nullableString(value: unknown, label: string, max: number = PROJECT_IMPORT_LIMITS.maxStringLength): string | null {
	return value === null ? null : string(value, label, max);
}

function uuid(value: unknown, label: string): string {
	const result = string(value, label, 64);
	if (!UUID_PATTERN.test(result)) fail(`Invalid manifest: ${label} is not a UUID.`);
	return result;
}

function bool(value: unknown, label: string): boolean {
	if (typeof value !== 'boolean') fail(`Invalid manifest: ${label} must be boolean.`);
	return value;
}

function number(value: unknown, label: string, integer = false): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) fail(`Invalid manifest: ${label} must be a finite number.`);
	return value;
}

function nullableNumber(value: unknown, label: string): number | null {
	return value === null ? null : number(value, label);
}

function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value) || value.length > PROJECT_IMPORT_LIMITS.maxRecordRows) fail(`Invalid manifest: ${label} must be a bounded array.`);
	return value;
}

function projectRow(value: unknown): ProjectExportManifestV1['project'] {
	const row = object(value, 'project');
	exactKeys(row, 'project', ['id', 'name', 'description', 'owner_id', 'currency', 'created_at', 'updated_at', 'is_public', 'public_files_enabled']);
	uuid(row.id, 'project.id');
	string(row.name, 'project.name', 200);
	nullableString(row.description, 'project.description', 2_000);
	uuid(row.owner_id, 'project.owner_id');
	if (row.currency !== 'PHP' && row.currency !== 'USD') fail('Invalid manifest: unsupported project currency.');
	nullableString(row.created_at, 'project.created_at', 100);
	nullableString(row.updated_at, 'project.updated_at', 100);
	bool(row.is_public, 'project.is_public');
	bool(row.public_files_enabled, 'project.public_files_enabled');
	return row as ProjectExportManifestV1['project'];
}

function peopleRows(value: unknown): ProjectExportManifestV1['people'] {
	return array(value, 'people').map((item, index) => {
		const row = object(item, `people[${index}]`);
		exactKeys(row, `people[${index}]`, ['sourceUserId', 'displayName', 'email']);
		return {
			sourceUserId: uuid(row.sourceUserId, `people[${index}].sourceUserId`),
			displayName: string(row.displayName, `people[${index}].displayName`, 200),
			email: nullableString(row.email, `people[${index}].email`, 320),
		};
	});
}

function projectMembers(value: unknown): Row<'project_members'>[] {
	return array(value, 'records.projectMembers').map((item, index) => {
		const row = object(item, `records.projectMembers[${index}]`);
		exactKeys(row, `records.projectMembers[${index}]`, ['project_id', 'user_id', 'role', 'is_auditor', 'contribution_percent', 'joined_at']);
		uuid(row.project_id, `records.projectMembers[${index}].project_id`);
		uuid(row.user_id, `records.projectMembers[${index}].user_id`);
		if (row.role !== 'owner' && row.role !== 'editor' && row.role !== 'viewer') fail('Invalid manifest: unsupported member role.');
		bool(row.is_auditor, `records.projectMembers[${index}].is_auditor`);
		nullableNumber(row.contribution_percent, `records.projectMembers[${index}].contribution_percent`);
		nullableString(row.joined_at, `records.projectMembers[${index}].joined_at`, 100);
		return row as Row<'project_members'>;
	});
}

function ghostMembers(value: unknown): Row<'ghost_members'>[] {
	return array(value, 'records.ghostMembers').map((item, index) => {
		const row = object(item, `records.ghostMembers[${index}]`);
		exactKeys(row, `records.ghostMembers[${index}]`, ['id', 'project_id', 'display_name', 'note', 'contribution_percent', 'is_deleted_account', 'created_at']);
		uuid(row.id, `records.ghostMembers[${index}].id`);
		uuid(row.project_id, `records.ghostMembers[${index}].project_id`);
		string(row.display_name, `records.ghostMembers[${index}].display_name`, 200);
		nullableString(row.note, `records.ghostMembers[${index}].note`, 200);
		nullableNumber(row.contribution_percent, `records.ghostMembers[${index}].contribution_percent`);
		bool(row.is_deleted_account, `records.ghostMembers[${index}].is_deleted_account`);
		nullableString(row.created_at, `records.ghostMembers[${index}].created_at`, 100);
		return row as Row<'ghost_members'>;
	});
}

function folders(value: unknown): ProjectExportManifestV1['records']['folders'] {
	return array(value, 'records.folders').map((item, index) => {
		const row = object(item, `records.folders[${index}]`);
		exactKeys(row, `records.folders[${index}]`, ['id', 'project_id', 'name', 'parent_folder_id', 'created_at', 'deleted_at', 'archive_path']);
		uuid(row.id, `records.folders[${index}].id`);
		uuid(row.project_id, `records.folders[${index}].project_id`);
		string(row.name, `records.folders[${index}].name`, 255);
		if (row.parent_folder_id !== null) uuid(row.parent_folder_id, `records.folders[${index}].parent_folder_id`);
		nullableString(row.created_at, `records.folders[${index}].created_at`, 100);
		nullableString(row.deleted_at, `records.folders[${index}].deleted_at`, 100);
		string(row.archive_path, `records.folders[${index}].archive_path`, PROJECT_IMPORT_LIMITS.maxPathLength);
		return row as ProjectExportManifestV1['records']['folders'][number];
	});
}

function files(value: unknown): ProjectExportManifestV1['records']['files'] {
	return array(value, 'records.files').map((item, index) => {
		const row = object(item, `records.files[${index}]`);
		exactKeys(row, `records.files[${index}]`, ['id', 'project_id', 'folder_id', 'uploaded_by', 'filename', 'mime_type', 'size_bytes', 'storage_provider', 'uploader_deleted_at', 'created_at', 'deleted_at', 'is_public', 'is_journal', 'archive_path', 'content_size_bytes', 'sha256']);
		uuid(row.id, `records.files[${index}].id`);
		uuid(row.project_id, `records.files[${index}].project_id`);
		if (row.folder_id !== null) uuid(row.folder_id, `records.files[${index}].folder_id`);
		if (row.uploaded_by !== null) uuid(row.uploaded_by, `records.files[${index}].uploaded_by`);
		string(row.filename, `records.files[${index}].filename`, 255);
		nullableString(row.mime_type, `records.files[${index}].mime_type`, 255);
		if (row.size_bytes !== null && number(row.size_bytes, `records.files[${index}].size_bytes`, true) < 0) fail('Invalid manifest: file size cannot be negative.');
		string(row.storage_provider, `records.files[${index}].storage_provider`, 50);
		nullableString(row.uploader_deleted_at, `records.files[${index}].uploader_deleted_at`, 100);
		nullableString(row.created_at, `records.files[${index}].created_at`, 100);
		nullableString(row.deleted_at, `records.files[${index}].deleted_at`, 100);
		bool(row.is_public, `records.files[${index}].is_public`);
		bool(row.is_journal, `records.files[${index}].is_journal`);
		string(row.archive_path, `records.files[${index}].archive_path`, PROJECT_IMPORT_LIMITS.maxPathLength);
		const contentSize = number(row.content_size_bytes, `records.files[${index}].content_size_bytes`, true);
		if (contentSize < 0 || contentSize > PROJECT_IMPORT_LIMITS.maxFileBytes) fail('Invalid manifest: file content size is outside the allowed range.');
		const checksum = string(row.sha256, `records.files[${index}].sha256`, 64);
		if (!SHA256_PATTERN.test(checksum)) fail('Invalid manifest: file checksum is invalid.');
		return row as ProjectExportManifestV1['records']['files'][number];
	});
}

function bomItems(value: unknown): Row<'bom_items'>[] {
	return array(value, 'records.bomItems').map((item, index) => {
		const row = object(item, `records.bomItems[${index}]`);
		exactKeys(row, `records.bomItems[${index}]`, ['id', 'project_id', 'part_name', 'category', 'description', 'quantity', 'unit', 'unit_cost', 'supplier', 'item_url', 'total_cost', 'created_at', 'deleted_at']);
		uuid(row.id, `records.bomItems[${index}].id`);
		uuid(row.project_id, `records.bomItems[${index}].project_id`);
		string(row.part_name, `records.bomItems[${index}].part_name`, 500);
		nullableString(row.category, `records.bomItems[${index}].category`, 200);
		nullableString(row.description, `records.bomItems[${index}].description`, 10_000);
		nullableNumber(row.quantity, `records.bomItems[${index}].quantity`);
		nullableString(row.unit, `records.bomItems[${index}].unit`, 100);
		nullableNumber(row.unit_cost, `records.bomItems[${index}].unit_cost`);
		nullableString(row.supplier, `records.bomItems[${index}].supplier`, 500);
		nullableString(row.item_url, `records.bomItems[${index}].item_url`, 2_048);
		nullableNumber(row.total_cost, `records.bomItems[${index}].total_cost`);
		nullableString(row.created_at, `records.bomItems[${index}].created_at`, 100);
		nullableString(row.deleted_at, `records.bomItems[${index}].deleted_at`, 100);
		return row as Row<'bom_items'>;
	});
}

function transactions(value: unknown): Row<'transactions'>[] {
	return array(value, 'records.transactions').map((item, index) => {
		const row = object(item, `records.transactions[${index}]`);
		exactKeys(row, `records.transactions[${index}]`, ['id', 'project_id', 'member_id', 'related_member_id', 'ghost_member_id', 'related_ghost_member_id', 'group_id', 'transaction_date', 'type', 'item_name', 'quantity', 'unit', 'unit_cost', 'supplier', 'item_url', 'total_cost', 'created_at', 'deleted_at']);
		uuid(row.id, `records.transactions[${index}].id`);
		uuid(row.project_id, `records.transactions[${index}].project_id`);
		for (const key of ['member_id', 'related_member_id', 'ghost_member_id', 'related_ghost_member_id', 'group_id'] as const) if (row[key] !== null) uuid(row[key], `records.transactions[${index}].${key}`);
		if (row.member_id !== null && row.ghost_member_id !== null) fail('Invalid manifest: transaction payer has two identities.');
		if (row.member_id === null && row.ghost_member_id === null) fail('Invalid manifest: transaction payer is missing.');
		if (row.related_member_id !== null && row.related_ghost_member_id !== null) fail('Invalid manifest: transaction payee has two identities.');
		string(row.transaction_date, `records.transactions[${index}].transaction_date`, 30);
		const transactionType = string(row.type, `records.transactions[${index}].type`, 30);
		if (!TRANSACTION_TYPES.has(transactionType)) fail('Invalid manifest: unsupported transaction type.');
		nullableString(row.item_name, `records.transactions[${index}].item_name`, 500);
		nullableNumber(row.quantity, `records.transactions[${index}].quantity`);
		nullableString(row.unit, `records.transactions[${index}].unit`, 100);
		nullableNumber(row.unit_cost, `records.transactions[${index}].unit_cost`);
		nullableString(row.supplier, `records.transactions[${index}].supplier`, 500);
		nullableString(row.item_url, `records.transactions[${index}].item_url`, 2_048);
		nullableNumber(row.total_cost, `records.transactions[${index}].total_cost`);
		nullableString(row.created_at, `records.transactions[${index}].created_at`, 100);
		nullableString(row.deleted_at, `records.transactions[${index}].deleted_at`, 100);
		return row as Row<'transactions'>;
	});
}

function tasks(value: unknown): Row<'tasks'>[] {
	return array(value, 'records.tasks').map((item, index) => {
		const row = object(item, `records.tasks[${index}]`);
		exactKeys(row, `records.tasks[${index}]`, ['id', 'project_id', 'name', 'category', 'priority_position', 'description', 'start_date', 'start_time', 'deadline', 'deadline_time', 'status', 'created_at', 'deleted_at']);
		uuid(row.id, `records.tasks[${index}].id`);
		uuid(row.project_id, `records.tasks[${index}].project_id`);
		string(row.name, `records.tasks[${index}].name`, 500);
		nullableString(row.category, `records.tasks[${index}].category`, 100);
		const taskPriority = number(row.priority_position, `records.tasks[${index}].priority_position`, true);
		if (taskPriority < 0) fail('Invalid manifest: task priority cannot be negative.');
		nullableString(row.description, `records.tasks[${index}].description`, 10_000);
		nullableString(row.start_date, `records.tasks[${index}].start_date`, 30);
		string(row.start_time, `records.tasks[${index}].start_time`, 30);
		nullableString(row.deadline, `records.tasks[${index}].deadline`, 30);
		string(row.deadline_time, `records.tasks[${index}].deadline_time`, 30);
		string(row.status, `records.tasks[${index}].status`, 20);
		if (row.status !== 'ongoing' && row.status !== 'done') fail('Invalid manifest: unsupported task status.');
		nullableString(row.created_at, `records.tasks[${index}].created_at`, 100);
		nullableString(row.deleted_at, `records.tasks[${index}].deleted_at`, 100);
		return row as Row<'tasks'>;
	});
}

function taskAssignees(value: unknown): Row<'task_assignees'>[] {
	return array(value, 'records.taskAssignees').map((item, index) => {
		const row = object(item, `records.taskAssignees[${index}]`);
		exactKeys(row, `records.taskAssignees[${index}]`, ['id', 'task_id', 'user_id', 'ghost_member_id', 'deleted_display_name']);
		uuid(row.id, `records.taskAssignees[${index}].id`);
		uuid(row.task_id, `records.taskAssignees[${index}].task_id`);
		if (row.user_id !== null) uuid(row.user_id, `records.taskAssignees[${index}].user_id`);
		if (row.ghost_member_id !== null) uuid(row.ghost_member_id, `records.taskAssignees[${index}].ghost_member_id`);
		if (row.user_id !== null && row.ghost_member_id !== null) fail('Invalid manifest: task assignee has two identities.');
		nullableString(row.deleted_display_name, `records.taskAssignees[${index}].deleted_display_name`, 200);
		return row as Row<'task_assignees'>;
	});
}

function taskCategories(value: unknown): Row<'task_categories'>[] {
	return array(value, 'records.taskCategories').map((item, index) => {
		const row = object(item, `records.taskCategories[${index}]`);
		exactKeys(row, `records.taskCategories[${index}]`, ['project_id', 'name', 'color_index']);
		uuid(row.project_id, `records.taskCategories[${index}].project_id`);
		string(row.name, `records.taskCategories[${index}].name`, 100);
		const color = number(row.color_index, `records.taskCategories[${index}].color_index`, true);
		if (color < 0 || color > 9) fail('Invalid manifest: category color is outside the supported palette.');
		return row as Row<'task_categories'>;
	});
}

function taskCategoryPositions(value: unknown): Row<'task_category_positions'>[] {
	return array(value, 'records.taskCategoryPositions').map((item, index) => {
		const row = object(item, `records.taskCategoryPositions[${index}]`);
		exactKeys(row, `records.taskCategoryPositions[${index}]`, ['id', 'project_id', 'category_name', 'priority_position', 'created_at']);
		uuid(row.id, `records.taskCategoryPositions[${index}].id`);
		uuid(row.project_id, `records.taskCategoryPositions[${index}].project_id`);
		nullableString(row.category_name, `records.taskCategoryPositions[${index}].category_name`, 100);
		const priority = number(row.priority_position, `records.taskCategoryPositions[${index}].priority_position`, true);
		if (priority < 0) fail('Invalid manifest: category priority cannot be negative.');
		string(row.created_at, `records.taskCategoryPositions[${index}].created_at`, 100);
		return row as Row<'task_category_positions'>;
	});
}

function journalDraft(value: unknown): Row<'journal_drafts'> | null {
	if (value === null) return null;
	const row = object(value, 'records.journalDraft');
	exactKeys(row, 'records.journalDraft', ['project_id', 'draft_date', 'content', 'updated_at', 'updated_by']);
	uuid(row.project_id, 'records.journalDraft.project_id');
	string(row.draft_date, 'records.journalDraft.draft_date', 30);
	string(row.content, 'records.journalDraft.content', 50_000);
	string(row.updated_at, 'records.journalDraft.updated_at', 100);
	if (row.updated_by !== null) uuid(row.updated_by, 'records.journalDraft.updated_by');
	return row as Row<'journal_drafts'>;
}

function validateManifest(raw: unknown): ProjectExportManifestV1 {
	const root = object(raw, 'manifest');
	exactKeys(root, 'manifest', ['format', 'version', 'exportedAt', 'checksumAlgorithm', 'project', 'people', 'recordCounts', 'records']);
	if (root.format !== PROJECT_EXPORT_FORMAT || root.version !== PROJECT_EXPORT_VERSION || root.checksumAlgorithm !== PROJECT_EXPORT_CHECKSUM) fail('Unsupported project export format or version.');
	string(root.exportedAt, 'manifest.exportedAt', 100);
	const project = projectRow(root.project);
	const people = peopleRows(root.people);
	const members = projectMembers(object(root.records, 'records').projectMembers);
	const ghosts = ghostMembers(object(root.records, 'records').ghostMembers);
	const folderRows = folders(object(root.records, 'records').folders);
	const fileRows = files(object(root.records, 'records').files);
	const bomRows = bomItems(object(root.records, 'records').bomItems);
	const transactionRows = transactions(object(root.records, 'records').transactions);
	const taskRows = tasks(object(root.records, 'records').tasks);
	const assigneeRows = taskAssignees(object(root.records, 'records').taskAssignees);
	const categoryRows = taskCategories(object(root.records, 'records').taskCategories);
	const positionRows = taskCategoryPositions(object(root.records, 'records').taskCategoryPositions);
	const draft = journalDraft(object(root.records, 'records').journalDraft);
	const records = object(root.records, 'records');
	exactKeys(records, 'records', ['projectMembers', 'ghostMembers', 'folders', 'files', 'bomItems', 'transactions', 'tasks', 'taskAssignees', 'taskCategories', 'taskCategoryPositions', 'journalDraft']);

	const counts = object(root.recordCounts, 'recordCounts');
	exactKeys(counts, 'recordCounts', ['projectMembers', 'ghostMembers', 'folders', 'files', 'bomItems', 'transactions', 'tasks', 'taskAssignees', 'taskCategories', 'taskCategoryPositions', 'journalDrafts']);
	const countValues = {
		projectMembers: number(counts.projectMembers, 'recordCounts.projectMembers', true),
		ghostMembers: number(counts.ghostMembers, 'recordCounts.ghostMembers', true),
		folders: number(counts.folders, 'recordCounts.folders', true),
		files: number(counts.files, 'recordCounts.files', true),
		bomItems: number(counts.bomItems, 'recordCounts.bomItems', true),
		transactions: number(counts.transactions, 'recordCounts.transactions', true),
		tasks: number(counts.tasks, 'recordCounts.tasks', true),
		taskAssignees: number(counts.taskAssignees, 'recordCounts.taskAssignees', true),
		taskCategories: number(counts.taskCategories, 'recordCounts.taskCategories', true),
		taskCategoryPositions: number(counts.taskCategoryPositions, 'recordCounts.taskCategoryPositions', true),
		journalDrafts: number(counts.journalDrafts, 'recordCounts.journalDrafts', true),
	};
	const actualCounts = {
		projectMembers: members.length,
		ghostMembers: ghosts.length,
		folders: folderRows.length,
		files: fileRows.length,
		bomItems: bomRows.length,
		transactions: transactionRows.length,
		tasks: taskRows.length,
		taskAssignees: assigneeRows.length,
		taskCategories: categoryRows.length,
		taskCategoryPositions: positionRows.length,
		journalDrafts: draft ? 1 : 0,
	};
	for (const key of Object.keys(actualCounts) as (keyof typeof actualCounts)[]) if (countValues[key] !== actualCounts[key]) fail(`Invalid manifest: record count mismatch for ${key}.`);

	const peopleIds = new Set(people.map((person) => person.sourceUserId));
	if (peopleIds.size !== people.length) fail('Invalid manifest: duplicate person identity.');
	const memberIds = new Set(members.map((member) => member.user_id));
	const ghostIds = new Set(ghosts.map((ghost) => ghost.id));
	const folderIds = new Set(folderRows.map((folder) => folder.id));
	const fileIds = new Set(fileRows.map((file) => file.id));
	const taskIds = new Set(taskRows.map((task) => task.id));
	const transactionIds = new Set(transactionRows.map((transaction) => transaction.id));
	if (memberIds.size !== members.length || ghostIds.size !== ghosts.length || folderIds.size !== folderRows.length || fileIds.size !== fileRows.length || taskIds.size !== taskRows.length || transactionIds.size !== transactionRows.length) fail('Invalid manifest: duplicate record identity.');
	if (!memberIds.has(project.owner_id) || !peopleIds.has(project.owner_id)) fail('Invalid manifest: project owner is not represented as a member.');
	if (members.filter((member) => member.role === 'owner').length !== 1 || !members.some((member) => member.user_id === project.owner_id && member.role === 'owner')) fail('Invalid manifest: project owner membership is invalid.');
	for (const member of members) if (member.project_id !== project.id || !peopleIds.has(member.user_id)) fail('Invalid manifest: member relationship is invalid.');
	for (const ghost of ghosts) if (ghost.project_id !== project.id) fail('Invalid manifest: ghost-member relationship is invalid.');
	for (const row of [...folderRows, ...fileRows, ...bomRows, ...transactionRows, ...taskRows, ...categoryRows, ...positionRows]) {
		if ('project_id' in row && row.project_id !== project.id) fail('Invalid manifest: record belongs to a different project.');
	}
	for (const folder of folderRows) if (folder.parent_folder_id === folder.id || (folder.parent_folder_id && !folderIds.has(folder.parent_folder_id))) fail('Invalid manifest: folder parent relationship is invalid.');
	for (const file of fileRows) {
		if (file.folder_id && !folderIds.has(file.folder_id)) fail('Invalid manifest: file folder relationship is invalid.');
		if (file.uploaded_by && !peopleIds.has(file.uploaded_by)) fail('Invalid manifest: file uploader identity is missing.');
	}
	for (const task of assigneeRows) {
		if (!taskIds.has(task.task_id)) fail('Invalid manifest: task-assignee relationship is invalid.');
		if (task.user_id && !peopleIds.has(task.user_id)) fail('Invalid manifest: task-assignee person is missing.');
		if (task.ghost_member_id && !ghostIds.has(task.ghost_member_id)) fail('Invalid manifest: task-assignee ghost member is missing.');
	}
	for (const transaction of transactionRows) {
		for (const id of [transaction.member_id, transaction.related_member_id]) if (id && !peopleIds.has(id)) fail('Invalid manifest: transaction person is missing.');
		for (const id of [transaction.ghost_member_id, transaction.related_ghost_member_id]) if (id && !ghostIds.has(id)) fail('Invalid manifest: transaction ghost member is missing.');
		if (transaction.group_id && (!transactionIds.has(transaction.group_id) || transaction.group_id === transaction.id)) fail('Invalid manifest: transaction group relationship is invalid.');
	}
	if (draft && (draft.project_id !== project.id || (draft.updated_by && !peopleIds.has(draft.updated_by)))) fail('Invalid manifest: journal draft relationship is invalid.');

	let layout;
	try {
		layout = buildProjectArchiveLayout(folderRows, fileRows);
	} catch {
		fail('Invalid manifest: file hierarchy cannot be reconstructed.');
	}
	for (const folder of folderRows) if (layout.folderArchivePaths.get(folder.id) !== folder.archive_path) fail('Invalid manifest: folder archive path does not match its hierarchy.');
	for (const file of fileRows) if (layout.filePaths.get(file.id) !== file.archive_path) fail('Invalid manifest: file archive path does not match its hierarchy.');

	return {
		format: PROJECT_EXPORT_FORMAT,
		version: PROJECT_EXPORT_VERSION,
		exportedAt: root.exportedAt as string,
		checksumAlgorithm: PROJECT_EXPORT_CHECKSUM,
		project,
		people,
		recordCounts: countValues,
		records: {
			projectMembers: members,
			ghostMembers: ghosts,
			folders: folderRows,
			files: fileRows,
			bomItems: bomRows,
			transactions: transactionRows,
			tasks: taskRows,
			taskAssignees: assigneeRows,
			taskCategories: categoryRows,
			taskCategoryPositions: positionRows,
			journalDraft: draft,
		},
	};
}

function parseJsonEntry(archive: ParsedProjectZip, name: string): unknown {
	const entry = archive.entries.get(name);
	if (!entry || entry.isDirectory) fail(`Malformed P2 archive: ${name} is missing.`);
	if (entry.bytes.length > PROJECT_IMPORT_LIMITS.maxManifestBytes) fail(`P2 archive: ${name} is too large.`);
	try {
		return JSON.parse(decodeUtf8(entry.bytes, name));
	} catch {
		fail(`Malformed P2 archive: ${name} is not valid JSON.`);
	}
}

export async function validateP2ProjectArchive(bytes: Uint8Array<ArrayBuffer>): Promise<ValidatedProjectImport> {
	const archive = parseProjectZip(bytes);
	for (const name of REQUIRED_ENTRIES) {
		const entry = archive.entries.get(name);
		if (!entry || entry.isDirectory) fail(`Malformed P2 archive: required entry ${name} is missing.`);
	}

	const manifest = validateManifest(parseJsonEntry(archive, 'manifest.json'));
	const readme = decodeUtf8(archive.entries.get('README.txt')!.bytes, 'README.txt');
	if (!readme.startsWith(`Project: ${manifest.project.name}`)) fail('Invalid P2 archive: README project name does not match the manifest.');
	for (const name of ['tasks.json', 'bom.json', 'transactions.json', 'members.json']) {
		const legacy = object(parseJsonEntry(archive, name), name);
		if (legacy.project !== manifest.project.name) fail(`Invalid P2 archive: ${name} project name does not match the manifest.`);
	}

	const layout = buildProjectArchiveLayout(manifest.records.folders, manifest.records.files);
	const allowedDirectories = new Set(layout.directoryEntries);
	const expectedFilePaths = new Set(manifest.records.files.map((file) => file.archive_path));
	let archiveFileBytes = 0;
	for (const entry of archive.entries.values()) {
		if (REQUIRED_ENTRIES.includes(entry.name)) continue;
		if (entry.isDirectory) {
			if (!allowedDirectories.has(entry.name)) fail('Invalid P2 archive: unexpected directory entry.');
			continue;
		}
		if (!expectedFilePaths.has(entry.name)) fail('Invalid P2 archive: unexpected file entry.');
	}
	for (const file of manifest.records.files) {
		const entry = archive.entries.get(file.archive_path);
		if (!entry || entry.isDirectory) fail('Invalid P2 archive: manifest file content is missing.');
		if (entry.bytes.length !== file.content_size_bytes) fail('Invalid P2 archive: file size checksum input does not match the manifest.');
		const checksum = await sha256Hex(entry.bytes);
		if (checksum.toLowerCase() !== file.sha256.toLowerCase()) fail('Invalid P2 archive: file checksum failed.');
		archiveFileBytes += entry.bytes.length;
		if (archiveFileBytes > PROJECT_IMPORT_LIMITS.maxFileBytes) fail('P2 archive: total file content is too large.');
	}

	return { manifest, archive, projectName: manifest.project.name, fileBytes: archiveFileBytes };
}
