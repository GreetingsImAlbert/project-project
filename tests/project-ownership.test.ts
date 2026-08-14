import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ownershipTransferStatus, parseOwnershipTransfer } from '../src/lib/project-ownership.ts';

const ownerId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';

function formWith(newOwnerId?: string): FormData {
	const form = new FormData();
	if (newOwnerId) form.set('newOwnerId', newOwnerId);
	return form;
}

test('ownership transfer input requires a different valid member id', () => {
	assert.deepEqual(parseOwnershipTransfer(formWith(), ownerId), { error: 'Choose a project member' });
	assert.deepEqual(parseOwnershipTransfer(formWith('not-an-id'), ownerId), { error: 'Choose a project member' });
	assert.deepEqual(parseOwnershipTransfer(formWith(ownerId), ownerId), {
		error: 'Choose another project member as the new owner',
	});
	assert.deepEqual(parseOwnershipTransfer(formWith(memberId), ownerId), { newOwnerId: memberId });
});

test('expected ownership conflicts map to client errors', () => {
	assert.equal(ownershipTransferStatus('Project not found'), 404);
	assert.equal(ownershipTransferStatus('Only the current project owner can transfer ownership'), 403);
	assert.equal(ownershipTransferStatus('The new owner must be a current project member'), 400);
	assert.equal(ownershipTransferStatus('unexpected database outage'), null);
});

test('ownership transfer migration keeps canonical ownership and roles atomic', () => {
	const sql = readFileSync(
		new URL('../supabase/migrations/20260814033042_transfer_project_ownership.sql', import.meta.url),
		'utf8',
	);

	assert.match(sql, /security definer/i);
	assert.match(sql, /owner_id is distinct from auth\.uid\(\)/i);
	assert.match(sql, /for update/i);
	assert.match(sql, /join public\.profiles/i);
	assert.match(sql, /set role = 'owner'/i);
	assert.match(sql, /set role = 'editor'/i);
	assert.match(sql, /set owner_id = p_new_owner_id/i);
	assert.match(sql, /and is_journal/i);
	assert.match(sql, /revoke all .* from public/i);
});
