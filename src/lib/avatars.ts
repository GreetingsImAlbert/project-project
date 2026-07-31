// The whole set of profile pictures a member can pick. No custom uploads: an avatar
// is an id from this list, never a URL or an R2 key, so nothing user-controlled ever
// reaches an <img src> and the stored value stays valid across a redesign of the art.
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

export function isAvatarId(value: unknown): value is AvatarId {
	return typeof value === 'string' && (AVATAR_IDS as readonly string[]).includes(value);
}

export function avatarSrc(id: AvatarId): string {
	return `/avatars/${id}.svg`;
}

// A member who has never picked one shows their initial instead (see Avatar.svelte) —
// null is a real state, not a missing value to paper over with a stock image.
export function normalizeAvatar(value: unknown): AvatarId | null {
	return isAvatarId(value) ? value : null;
}
