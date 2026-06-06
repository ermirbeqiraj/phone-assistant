import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config.js';
import { createWebhookAuth } from '../middleware/telnyxWebhookAuth.js';
import { log } from '../../logger.js';

type CallEvent = {
  data: {
    event_type: string;
    payload: {
      call_control_id: string;
      from?: string;
      [key: string]: unknown;
    };
  };
};

export const callControlRoute: FastifyPluginAsync = async (app) => {
  const webhookAuth = createWebhookAuth(config.telnyxWebhookPublicKey);
  app.post('/webhook', { preHandler: webhookAuth }, async (req, reply) => {
    const event = req.body as CallEvent;
    const eventType = event?.data?.event_type;
    const callControlId = event?.data?.payload?.call_control_id;

    log(`[webhook] ${eventType} — ${callControlId}`);

    if (!callControlId || !config.telnyxApiKey) {
      reply.code(200).send({ received: true });
      return;
    }

    if (eventType === 'call.initiated') {
      await telnyxAction(callControlId, 'answer', {});
    }

    if (eventType === 'call.answered') {
      const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.hostname;
      const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
      const from = event?.data?.payload?.from ?? '';
      const auth = config.streamAuthToken ?? '';
      const wsUrl = `${proto === 'https' ? 'wss' : 'ws'}://${host}/media-stream?from=${encodeURIComponent(from)}&auth=${encodeURIComponent(auth)}&callControlId=${encodeURIComponent(callControlId)}`;

      await telnyxAction(callControlId, 'streaming_start', {
        stream_url: wsUrl,
        stream_track: 'inbound_track',
        stream_bidirectional_mode: 'rtp',
        stream_bidirectional_codec: 'PCMA',
      });
    }

    reply.code(200).send({ received: true });
  });
};

async function telnyxAction(callControlId: string, action: string, body: object): Promise<void> {
  const res = await fetch(
    `https://api.telnyx.com/v2/calls/${callControlId}/actions/${action}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.telnyxApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  const data = await res.json() as unknown;
  log(`[webhook] ${action} → ${res.status}: ${JSON.stringify(data)}`);
  if (!res.ok) throw new Error(`${action} HTTP ${res.status}`);
}
