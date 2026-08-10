import assert from 'node:assert/strict';
import test from 'node:test';
import { feedbackKindFromContext, parseFeedbackInput } from '../src/lib/feedback.ts';

test('feedback input defaults legacy Help submissions to help', () => {
	assert.deepEqual(parseFeedbackInput({ message: '  Need help  ', path: '/login' }), {
		message: 'Need help',
		path: '/login',
		kind: 'help',
	});
});

test('feedback input accepts and preserves suggestion submissions', () => {
	assert.deepEqual(parseFeedbackInput({ message: '  Add tags  ', path: '/', kind: 'suggestion' }), {
		message: 'Add tags',
		path: '/',
		kind: 'suggestion',
	});
});

test('feedback input rejects missing messages and unknown kinds', () => {
	assert.equal(parseFeedbackInput({ message: '   ', kind: 'suggestion' }), null);
	assert.equal(parseFeedbackInput({ message: 'Hello', kind: 'complaint' }), null);
	assert.equal(parseFeedbackInput(null), null);
});

test('feedback kind is read only from the expected context field', () => {
	assert.equal(feedbackKindFromContext({ feedbackKind: 'suggestion' }), 'suggestion');
	assert.equal(feedbackKindFromContext({ feedbackKind: 'server' }), null);
	assert.equal(feedbackKindFromContext(null), null);
});
