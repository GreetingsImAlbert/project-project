import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CUSTOM_AVATAR_MAX_BYTES,
	CUSTOM_AVATAR_MAX_DIMENSION,
	CUSTOM_AVATAR_MAX_PIXELS,
	isProjectPictureOwner,
	isStoredAvatarPath,
	isStoredProjectAvatarPath,
	normalizeProjectAvatar,
	parseCustomAvatarBytes,
	parseCustomAvatarDataUrl,
	projectAvatarCleanupPath,
	projectAvatarReplacementPath,
	projectAvatarStoragePath,
	resolveProjectAvatar,
} from '../src/lib/avatars.ts';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OBJECT_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_AVATAR_PATH = `${OWNER_ID}/${OBJECT_ID}.img`;
const PROJECT_AVATAR_PATH = `projects/${PROJECT_ID}/${OBJECT_ID}.img`;

function pngHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes[11] = 13;
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	for (const [offset, value] of [[16, width], [20, height]] as const) {
		bytes[offset] = (value >>> 24) & 0xff;
		bytes[offset + 1] = (value >>> 16) & 0xff;
		bytes[offset + 2] = (value >>> 8) & 0xff;
		bytes[offset + 3] = value & 0xff;
	}
	return bytes;
}

test('project storage paths stay scoped and strictly shaped', () => {
	const generated = projectAvatarStoragePath(PROJECT_ID);
	assert.match(generated, new RegExp(`^projects/${PROJECT_ID}/[0-9a-f-]+\\.img$`));
	assert.equal(isStoredProjectAvatarPath(generated), true);
	assert.equal(isStoredProjectAvatarPath(PROJECT_AVATAR_PATH), true);
	assert.throws(() => projectAvatarStoragePath('not-a-uuid'), /Invalid project id/);
});

test('project upload parser trusts supported signatures and enforces dimensions and limits', () => {
	const parsed = parseCustomAvatarBytes(pngHeader(320, 240));
	assert.equal(parsed?.mimeType, 'image/png');
	assert.deepEqual(parsed?.dimensions, { width: 320, height: 240 });

	const encoded = Buffer.from(pngHeader(10, 20)).toString('base64');
	assert.equal(parseCustomAvatarDataUrl(`data:image/png;base64,${encoded}`)?.mimeType, 'image/png');
	assert.equal(parseCustomAvatarBytes(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), null);
	assert.equal(parseCustomAvatarBytes(pngHeader(CUSTOM_AVATAR_MAX_DIMENSION + 1, 1)), null);
	assert.equal(parseCustomAvatarBytes(pngHeader(4096, Math.ceil(CUSTOM_AVATAR_MAX_PIXELS / 4096) + 1)), null);
	assert.equal(parseCustomAvatarBytes(new Uint8Array(CUSTOM_AVATAR_MAX_BYTES + 1)), null);
});

test('default project picture resolves to the owner picture and overrides win', () => {
	assert.equal(isStoredAvatarPath(OWNER_AVATAR_PATH), true);
	assert.equal(normalizeProjectAvatar(OWNER_AVATAR_PATH), null);
	assert.equal(resolveProjectAvatar(null, OWNER_AVATAR_PATH), OWNER_AVATAR_PATH);
	assert.equal(resolveProjectAvatar('dot', OWNER_AVATAR_PATH), 'dot');
	assert.equal(resolveProjectAvatar(null, null), null);
});

test('project picture permission policy rejects non-owners', () => {
	assert.equal(isProjectPictureOwner(OWNER_ID, OWNER_ID), true);
	assert.equal(isProjectPictureOwner(OWNER_ID, '44444444-4444-4444-8444-444444444444'), false);
	assert.equal(isProjectPictureOwner(OWNER_ID, null), false);
});

test('picture replacement and deletion cleanup only target stored project objects', () => {
	assert.equal(projectAvatarCleanupPath(PROJECT_AVATAR_PATH), PROJECT_AVATAR_PATH);
	assert.equal(projectAvatarReplacementPath(PROJECT_AVATAR_PATH, 'dot'), PROJECT_AVATAR_PATH);
	assert.equal(projectAvatarReplacementPath(PROJECT_AVATAR_PATH, null), PROJECT_AVATAR_PATH);
	assert.equal(projectAvatarReplacementPath(PROJECT_AVATAR_PATH, PROJECT_AVATAR_PATH), null);
	assert.equal(projectAvatarCleanupPath('dot'), null);
	assert.equal(projectAvatarCleanupPath(OWNER_AVATAR_PATH), null);
	assert.equal(projectAvatarCleanupPath(null), null);
});
