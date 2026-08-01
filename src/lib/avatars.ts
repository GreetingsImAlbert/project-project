// The built-in set of profile pictures a member can pick. Custom pictures are also
// accepted, but only as validated, compressed data URLs (see below) so an arbitrary
// URL never reaches an <img src>.
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
export const CUSTOM_AVATAR_MAX_BYTES = 120_000;
export const CUSTOM_AVATAR_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const CUSTOM_AVATAR_MAX_DATA_URL_LENGTH = 170_000;
export const CUSTOM_AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

type CustomAvatarMimeType = (typeof CUSTOM_AVATAR_MIME_TYPES)[number];

const CUSTOM_AVATAR_DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export function isAvatarId(value: unknown): value is AvatarId {
	return typeof value === 'string' && (AVATAR_IDS as readonly string[]).includes(value);
}

// This cheap client-safe check is used while rendering. The API uses the stricter
// byte-signature check below before writing anything to the database.
export function isCustomAvatarDataUrl(value: unknown): value is string {
	return typeof value === 'string' && value.length <= CUSTOM_AVATAR_MAX_DATA_URL_LENGTH && CUSTOM_AVATAR_DATA_URL_RE.test(value);
}

export function parseCustomAvatarDataUrl(value: unknown): { mimeType: CustomAvatarMimeType; bytes: Uint8Array } | null {
	if (!isCustomAvatarDataUrl(value)) return null;

	const match = CUSTOM_AVATAR_DATA_URL_RE.exec(value);
	if (!match) return null;

	let binary: string;
	try {
		binary = atob(match[2]);
	} catch {
		return null;
	}

	if (binary.length === 0 || binary.length > CUSTOM_AVATAR_MAX_BYTES) return null;

	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	const mimeType = match[1] as CustomAvatarMimeType;
	const hasSignature =
		(bytes.length >= 3 && mimeType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
		(bytes.length >= 8 && mimeType === 'image/png' && bytes.subarray(0, 8).every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) ||
		(bytes.length >= 12 && mimeType === 'image/webp' &&
			bytes.subarray(0, 4).every((byte, index) => byte === [0x52, 0x49, 0x46, 0x46][index]) &&
			bytes.subarray(8, 12).every((byte, index) => byte === [0x57, 0x45, 0x42, 0x50][index]));

	return hasSignature ? { mimeType, bytes } : null;
}

export function avatarSrc(id: AvatarId): string {
	return `/avatars/${id}.svg`;
}

// A member who has never picked one shows their initial instead (see Avatar.svelte) —
// null is a real state, not a missing value to paper over with a stock image.
export function normalizeAvatar(value: unknown): AvatarId | string | null {
	return isAvatarId(value) || isCustomAvatarDataUrl(value) ? value : null;
}
