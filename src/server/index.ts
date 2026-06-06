import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import { config } from '../config.js';
import { callControlRoute } from './routes/callControl.js';
import { streamRoute } from './routes/stream.js';
import { localRoute } from './routes/local.js';
import { log, error } from '../logger.js';

const app = Fastify({ logger: false });

app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    const bodyStr = typeof body === 'string' ? body : body.toString('utf8');
    (req as unknown as { rawBody: string }).rawBody = bodyStr;
    done(null, bodyStr.length === 0 ? {} : JSON.parse(bodyStr));
  } catch (err) {
    done(err as Error);
  }
});

await app.register(formbody);
await app.register(websocket);

app.addHook('onResponse', async (req, reply) => {
  log(`[http] ${req.method} ${req.url} -> ${reply.statusCode} (${reply.elapsedTime.toFixed(0)}ms)`);
});

app.setErrorHandler((err, req, reply) => {
  error(`[http] ${req.method} ${req.url} threw`, err);
  reply.code(500).send({ error: 'Internal Server Error' });
});

process.on('uncaughtException', (err) => {
  error('[process] uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  error('[process] unhandledRejection', reason);
});

app.get('/health', async () => ({ status: 'ok' }));

await app.register(callControlRoute);
await app.register(streamRoute);
await app.register(localRoute);

const address = await app.listen({ port: config.port, host: '0.0.0.0' });
log(`[server] listening on ${address}`);
