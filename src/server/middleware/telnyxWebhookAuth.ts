import { verify } from 'crypto';
import type { FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import { log } from '../../logger.js';

// ASN.1 SPKI prefix for an Ed25519 public key. Telnyx publishes the public key
// as a base64-encoded 32-byte raw Ed25519 key; Node's crypto.verify with SPKI
// format needs the full 44-byte SPKI DER, so we prepend this when needed.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function toSpkiDer(publicKeyBase64: string): Buffer {
  const raw = Buffer.from(publicKeyBase64, 'base64');
  return raw.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, raw]) : raw;
}

/**
 * Builds a preHandler that verifies Telnyx webhook signatures (Ed25519).
 * Telnyx signs the bytes: `${timestamp}|${rawBody}`
 * Headers: Telnyx-Signature-Ed25519, Telnyx-Timestamp
 *
 * Fails closed: if no public key is configured, every request is rejected.
 * This prevents an env-var typo from silently disabling the gate.
 */
export function createWebhookAuth(publicKeyBase64: string | undefined): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!publicKeyBase64) {
      log('[auth] rejected: TELNYX_WEBHOOK_PUBLIC_KEY not configured');
      reply.code(503).send('Webhook auth not configured');
      return;
    }

    const signature = req.headers['telnyx-signature-ed25519'];
    const timestamp = req.headers['telnyx-timestamp'];

    if (!signature || Array.isArray(signature) || !timestamp || Array.isArray(timestamp)) {
      log('[auth] rejected: missing signature headers');
      reply.code(403).send('Forbidden');
      return;
    }

    // Reject requests older than 5 minutes (replay protection)
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (age > 300) {
      log(`[auth] rejected: timestamp too old (${age}s)`);
      reply.code(403).send('Forbidden');
      return;
    }

    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const message = Buffer.from(`${timestamp}|${rawBody}`);

    let valid = false;
    try {
      valid = verify(
        null,
        message,
        { key: toSpkiDer(publicKeyBase64), format: 'der', type: 'spki' },
        Buffer.from(signature, 'base64'),
      );
    } catch (err) {
      log(`[auth] rejected: verify threw — ${(err as Error).message}`);
      reply.code(403).send('Forbidden');
      return;
    }

    if (!valid) {
      log('[auth] rejected: invalid signature');
      reply.code(403).send('Forbidden');
    }
  };
}
