import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

// MISTRAL_API_KEY is required by config.ts to load
process.env.MISTRAL_API_KEY = 'test-key';

const { default: Fastify } = await import('fastify');
const { createWebhookAuth } = await import('../src/server/middleware/webhookAuth.js');

function buildApp(publicKey: string | undefined) {
  const app = Fastify({ logger: false });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      const bodyStr = typeof body === 'string' ? body : (body as Buffer).toString('utf8');
      (req as unknown as { rawBody: string }).rawBody = bodyStr;
      done(null, bodyStr.length === 0 ? {} : JSON.parse(bodyStr));
    } catch (err) {
      done(err as Error);
    }
  });

  app.post('/webhook', { preHandler: createWebhookAuth(publicKey) }, async () => ({ received: true }));
  return app;
}

function signFor(timestamp: string, body: string): string {
  return sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString('base64');
}

// ─── fail-closed when no key configured ────────────────────────────────────────

test('FAIL-CLOSED: rejects every request when no public key is configured', async () => {
  const app = buildApp(undefined);
  const body = JSON.stringify({ foo: 'bar' });
  const ts = String(Math.floor(Date.now() / 1000));

  // Even a perfectly signed request should be rejected if the key is missing
  const res = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'telnyx-timestamp': ts,
      'telnyx-signature-ed25519': signFor(ts, body),
    },
    payload: body,
  });
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /not configured/);
});

test('FAIL-CLOSED: rejects unauthenticated request when no key configured', async () => {
  const app = buildApp(undefined);
  const res = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'content-type': 'application/json' },
    payload: { foo: 'bar' },
  });
  assert.equal(res.statusCode, 503);
});

// ─── normal behavior when key IS configured ────────────────────────────────────

test('rejects requests with no signature headers', async () => {
  const app = buildApp(publicKeyB64);
  const res = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'content-type': 'application/json' },
    payload: { foo: 'bar' },
  });
  assert.equal(res.statusCode, 403);
});

test('rejects requests with a stale timestamp (>5 min)', async () => {
  const app = buildApp(publicKeyB64);
  const body = JSON.stringify({ foo: 'bar' });
  const oldTs = String(Math.floor(Date.now() / 1000) - 400);
  const res = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'telnyx-timestamp': oldTs,
      'telnyx-signature-ed25519': signFor(oldTs, body),
    },
    payload: body,
  });
  assert.equal(res.statusCode, 403);
});

test('rejects requests with a forged signature', async () => {
  const app = buildApp(publicKeyB64);
  const body = JSON.stringify({ foo: 'bar' });
  const ts = String(Math.floor(Date.now() / 1000));
  const forged = signFor(ts, JSON.stringify({ other: 'data' }));
  const res = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'telnyx-timestamp': ts,
      'telnyx-signature-ed25519': forged,
    },
    payload: body,
  });
  assert.equal(res.statusCode, 403);
});

test('rejects requests when body is tampered after signing', async () => {
  const app = buildApp(publicKeyB64);
  const originalBody = JSON.stringify({ foo: 'bar' });
  const tamperedBody = JSON.stringify({ foo: 'evil' });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'telnyx-timestamp': ts,
      'telnyx-signature-ed25519': signFor(ts, originalBody),
    },
    payload: tamperedBody,
  });
  assert.equal(res.statusCode, 403);
});

test('accepts requests with a valid signature', async () => {
  const app = buildApp(publicKeyB64);
  const body = JSON.stringify({ foo: 'bar' });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'telnyx-timestamp': ts,
      'telnyx-signature-ed25519': signFor(ts, body),
    },
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { received: true });
});
