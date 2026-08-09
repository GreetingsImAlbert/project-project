import assert from 'node:assert/strict';
import test from 'node:test';
import { authErrorResponse, wantsJson } from '../src/lib/auth-response.ts';
import { consumeQueryFlag, readAuthResponse, responseErrorMessage, withBusy } from '../src/lib/auth-client.ts';
import { rateLimitResponse } from '../src/lib/auth-rate-limit.ts';

test('auth API errors negotiate JSON without changing status', async () => {
	const request = new Request('https://p2.test/api/auth/login', {
		headers: { Accept: 'application/json' },
	});
	const response = authErrorResponse(request, 'Login failed: invalid credentials', 401);

	assert.equal(wantsJson(request), true);
	assert.equal(response.status, 401);
	assert.deepEqual(await response.json(), { error: 'Login failed: invalid credentials' });
});

test('auth API errors keep the native text fallback', async () => {
	const request = new Request('https://p2.test/api/auth/login', {
		headers: { Accept: 'text/html,application/xhtml+xml' },
	});
	const response = authErrorResponse(request, 'Missing email or password', 400);

	assert.equal(wantsJson(request), false);
	assert.equal(response.status, 400);
	assert.equal(await response.text(), 'Missing email or password');
});

test('auth client reads JSON outcomes and plain-text rate-limit failures', async () => {
	const confirmation = await readAuthResponse(
		new Response(JSON.stringify({ requiresEmailConfirmation: true, message: 'Check your email' }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		}),
	);
	assert.deepEqual(confirmation, { requiresEmailConfirmation: true, message: 'Check your email' });

	const rateLimit = await readAuthResponse(new Response('Too many requests. Try again in a minute.', { status: 429 }));
	assert.equal(responseErrorMessage(rateLimit, 'Fallback'), 'Too many requests. Try again in a minute.');

	const empty = await readAuthResponse(new Response('', { status: 500 }));
	assert.equal(responseErrorMessage(empty, 'Fallback'), 'Fallback');
});

test('rate-limit responses use the same JSON contract for hydrated auth forms', async () => {
	const request = new Request('https://p2.test/api/auth/login', {
		headers: { Accept: 'application/json' },
	});
	const response = rateLimitResponse(request);

	assert.equal(response.status, 429);
	assert.equal(response.headers.get('Retry-After'), '60');
	assert.deepEqual(await response.json(), { error: 'Too many requests. Try again in a minute.' });
});

test('auth notices are consumed once and busy state always recovers', async () => {
	const first = consumeQueryFlag('https://p2.test/login?checkEmail=1', 'checkEmail');
	assert.equal(first.active, true);
	assert.equal(new URL(`https://p2.test${first.cleanUrl}`).search, '');
	assert.equal(consumeQueryFlag(`https://p2.test${first.cleanUrl}`, 'checkEmail').active, false);

	const states: boolean[] = [];
	await assert.rejects(
		withBusy((busy) => states.push(busy), async () => {
			throw new Error('request failed');
		}),
		/request failed/,
	);
	assert.deepEqual(states, [true, false]);
});
