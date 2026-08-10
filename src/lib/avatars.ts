// The built-in set of profile pictures a member can pick. Custom pictures are stored
// unchanged in Supabase Storage; profiles.avatar and projects.avatar hold only a
// built-in id or validated object path.
//
// To add one: drop `public/avatars/<id>.svg` in and add the id here — nothing else
// keys off the list. Swapping the art for an existing id needs no code change at all.
export const AVATAR_IDS = [
	'dot',
	'ring',
	'square',
	'diamond',
	'triangle',
	'cross',
	'bars',
	'grid',
] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];

export const CUSTOM_AVATAR_MARKER = 'custom-avatar';
export const CUSTOM_AVATAR_BUCKET = 'avatars';
export const CUSTOM_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const CUSTOM_AVATAR_MAX_SOURCE_BYTES = CUSTOM_AVATAR_MAX_BYTES;
// Kept temporarily for the one-time migration of legacy data URLs.
export const CUSTOM_AVATAR_MAX_DATA_URL_LENGTH = 7_000_000;
export const CUSTOM_AVATAR_MAX_REQUEST_BYTES = 7_500_000;
// These bounds apply to every upload, including legacy data URLs during the
// one-time migration.
export const CUSTOM_AVATAR_MAX_DIMENSION = 4096;
export const CUSTOM_AVATAR_MAX_PIXELS = 8 * 1024 * 1024;
export const CUSTOM_AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

type CustomAvatarMimeType = (typeof CUSTOM_AVATAR_MIME_TYPES)[number];

const CUSTOM_AVATAR_DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const CUSTOM_AVATAR_STORAGE_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:img|jpg|jpeg|png|webp)$/i;
const PROJECT_AVATAR_STORAGE_PATH_RE = /^projects\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.img$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CUSTOM_AVATAR_EXTENSION_MIME_TYPES: Record<string, CustomAvatarMimeType> = {
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
};

type ImageDimensions = { width: number; height: number };

function safeDimensions(width: number, height: number): ImageDimensions | null {
	return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= CUSTOM_AVATAR_MAX_DIMENSION && height <= CUSTOM_AVATAR_MAX_DIMENSION && width * height <= CUSTOM_AVATAR_MAX_PIXELS
		? { width, height }
		: null;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
	return bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
	return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16) + bytes[offset + 3] * 0x1000000;
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
	return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
	let offset = 2;

	while (offset < bytes.length) {
		if (bytes[offset++] !== 0xff) return null;
		while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
		if (offset >= bytes.length) return null;

		const marker = bytes[offset++];
		if (marker === 0xd9 || marker === 0xda || marker === 0x00) return null;
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (offset + 2 > bytes.length) return null;

		const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
		if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;

		const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
		if (isStartOfFrame) {
			if (segmentLength < 7) return null;
			const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
			const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
			return safeDimensions(width, height);
		}

		offset += segmentLength;
	}

	return null;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
	if (bytes.length < 24 || readUint32BE(bytes, 8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
	return safeDimensions(readUint32BE(bytes, 16), readUint32BE(bytes, 20));
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
	if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'WEBP') return null;

	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const chunkType = String.fromCharCode(...bytes.subarray(offset, offset + 4));
		const chunkSize = readUint32LE(bytes, offset + 4);
		const payload = offset + 8;
		if (payload + chunkSize > bytes.length) return null;

		if (chunkType === 'VP8X' && chunkSize >= 10) {
			return safeDimensions(1 + readUint24LE(bytes, payload + 4), 1 + readUint24LE(bytes, payload + 7));
		}
		if (chunkType === 'VP8 ' && chunkSize >= 10) {
			if (bytes[payload + 3] !== 0x9d || bytes[payload + 4] !== 0x01 || bytes[payload + 5] !== 0x2a) return null;
			return safeDimensions(bytes[payload + 6] | (bytes[payload + 7] << 8), bytes[payload + 8] | (bytes[payload + 9] << 8));
		}
		if (chunkType === 'VP8L' && chunkSize >= 5) {
			if (bytes[payload] !== 0x2f) return null;
			const bits = readUint32LE(bytes, payload + 1);
			return safeDimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
		}

		offset = payload + chunkSize + (chunkSize & 1);
	}

	return null;
}

function imageDimensions(mimeType: CustomAvatarMimeType, bytes: Uint8Array): ImageDimensions | null {
	if (mimeType === 'image/jpeg') return jpegDimensions(bytes);
	if (mimeType === 'image/png') return pngDimensions(bytes);
	return webpDimensions(bytes);
}

function detectedAvatarMimeType(bytes: Uint8Array): CustomAvatarMimeType | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (bytes.length >= 8 && bytes.subarray(0, 8).every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) return 'image/png';
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).every((byte, index) => byte === [0x52, 0x49, 0x46, 0x46][index]) &&
		bytes.subarray(8, 12).every((byte, index) => byte === [0x57, 0x45, 0x42, 0x50][index])
	)
		return 'image/webp';
	return null;
}

export function isAvatarId(value: unknown): value is AvatarId {
	return typeof value === 'string' && (AVATAR_IDS as readonly string[]).includes(value);
}

// This cheap shape check is useful before parsing user input. Rendering uses the
// stricter parser below so legacy values are bounded too.
export function isCustomAvatarDataUrl(value: unknown): value is string {
	return typeof value === 'string' && value.length <= CUSTOM_AVATAR_MAX_DATA_URL_LENGTH && CUSTOM_AVATAR_DATA_URL_RE.test(value);
}

export function isStoredAvatarPath(value: unknown): value is string {
	return typeof value === 'string' && CUSTOM_AVATAR_STORAGE_PATH_RE.test(value);
}

export function isStoredProjectAvatarPath(value: unknown): value is string {
	return typeof value === 'string' && PROJECT_AVATAR_STORAGE_PATH_RE.test(value);
}

export function isStoredPicturePath(value: unknown): value is string {
	return isStoredAvatarPath(value) || isStoredProjectAvatarPath(value);
}

export function avatarUploadMimeType(typeValue: unknown, fileNameValue: unknown): string | null {
	const declaredType = typeof typeValue === 'string' ? typeValue.trim().toLowerCase() : '';
	if ((CUSTOM_AVATAR_MIME_TYPES as readonly string[]).includes(declaredType)) return declaredType;

	const fileName = typeof fileNameValue === 'string' ? fileNameValue : '';
	const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
	return CUSTOM_AVATAR_EXTENSION_MIME_TYPES[extension] ?? null;
}

export function avatarStoragePath(userId: string, _mimeType: string): string {
	// Supabase serves the object using its stored content type; the extension is
	// deliberately opaque so every generated path stays within the safe path shape.
	return `${userId}/${crypto.randomUUID()}.img`;
}

export function projectAvatarStoragePath(projectId: string): string {
	if (!UUID_RE.test(projectId)) throw new Error('Invalid project id');
	return `projects/${projectId}/${crypto.randomUUID()}.img`;
}

export function parseCustomAvatarBytes(value: Uint8Array): { mimeType: CustomAvatarMimeType; bytes: Uint8Array; dimensions: ImageDimensions } | null {
	if (value.byteLength === 0 || value.byteLength > CUSTOM_AVATAR_MAX_BYTES) return null;

	const bytes = value;
	// Multipart MIME metadata is not reliable across runtimes. Trust the file
	// signature instead, then store using the detected type.
	const mimeType = detectedAvatarMimeType(bytes);
	if (!mimeType) return null;
	const dimensions = imageDimensions(mimeType, bytes);
	return dimensions ? { mimeType, bytes, dimensions } : null;
}

export function parseCustomAvatarDataUrl(value: unknown): { mimeType: CustomAvatarMimeType; bytes: Uint8Array; dimensions: ImageDimensions } | null {
	if (!isCustomAvatarDataUrl(value)) return null;

	const match = CUSTOM_AVATAR_DATA_URL_RE.exec(value);
	if (!match) return null;

	let binary: string;
	try {
		binary = atob(match[2]);
	} catch {
		return null;
	}

	const parsed = parseCustomAvatarBytes(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
	return parsed?.mimeType === match[1] ? parsed : null;
}

export function avatarSrc(id: AvatarId): string {
	return `/avatars/${id}.svg`;
}

export function avatarStorageSrc(path: string): string {
	const baseUrl = import.meta.env.PUBLIC_SUPABASE_URL.replace(/\/$/, '');
	const encodedPath = path.split('/').map((part) => encodeURIComponent(part)).join('/');
	return `${baseUrl}/storage/v1/object/public/${CUSTOM_AVATAR_BUCKET}/${encodedPath}`;
}

export function projectAvatarStorageSrc(path: string): string | null {
	return isStoredProjectAvatarPath(path) ? avatarStorageSrc(path) : null;
}

export function normalizeProjectAvatar(value: unknown): AvatarId | string | null {
	if (isAvatarId(value)) return value;
	if (isStoredProjectAvatarPath(value)) return value;
	return null;
}

export function resolveProjectAvatar(projectAvatar: unknown, ownerAvatar: unknown): AvatarId | string | null {
	return normalizeProjectAvatar(projectAvatar) ?? normalizeAvatar(ownerAvatar);
}

// A member who has never picked one shows their initial instead (see Avatar.svelte) —
// null is a real state, not a missing value to paper over with a stock image.
export function normalizeAvatar(value: unknown): AvatarId | string | null {
	if (isAvatarId(value)) return value;
	if (isStoredAvatarPath(value)) return value;
	return parseCustomAvatarDataUrl(value) ? (value as string) : null;
}
