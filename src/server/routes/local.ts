import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { BrowserTransport } from '../../infrastructure/transport/BrowserTransport.js';
import { createStt, createTts, createAgent, createEndpointer, createNotifier } from '../../infrastructure/factory.js';
import { CallSession } from '../../core/session/CallSession.js';
import { persona } from '../../persona.js';
import { log, error, subscribe } from '../../logger.js';

// ── AudioWorklet code (runs in browser, not Node) ────────────────────────────
// Converts the capture context's Float32 samples → 16kHz PCM s16le and buffers
// 20ms chunks. When the context already runs at 16kHz (ratio = 1) this is a pure
// passthrough; the ratio>1 decimation path is only a fallback if the browser
// refuses a 16kHz context.
const CAPTURE_WORKLET = `
class CaptureWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._phase = 0;
    this._ratio = sampleRate / 16000;
    this._buf = [];
    this._target = Math.round(16000 / 1000 * 20); // 320 samples = 20ms
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this._phase += 1;
      if (this._phase >= this._ratio) {
        this._phase -= this._ratio;
        this._buf.push(Math.max(-1, Math.min(1, ch[i])));
      }
    }
    while (this._buf.length >= this._target) {
      const slice = this._buf.splice(0, this._target);
      const out = new Int16Array(slice.map(s => Math.round(s * 32767)));
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('capture-worklet', CaptureWorklet);
`.trim();

// ── Browser page (served at GET /local) ──────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VA Voice — Local Dev</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: 'Courier New', monospace; max-width: 640px; margin: 60px auto;
           padding: 0 24px; background: #0f0f0f; color: #d4d4d4; }
    h1 { font-size: 16px; color: #fff; margin: 0 0 24px; letter-spacing: .05em; }
    #status { font-size: 13px; color: #6b7280; margin-bottom: 20px; }
    #status.active { color: #4ade80; }
    #btn { padding: 9px 20px; background: #2563eb; color: #fff; border: none;
           border-radius: 5px; font-size: 13px; font-family: inherit; cursor: pointer; }
    #btn:hover { background: #1d4ed8; }
    #btn.end { background: #dc2626; }
    #btn.end:hover { background: #b91c1c; }
    .panel-label { margin-top: 28px; font-size: 10px; letter-spacing: .1em;
                   color: #4b5563; text-transform: uppercase;
                   display: flex; justify-content: space-between; align-items: center; }
    .panel-label button { font-size: 10px; font-family: inherit; background: none;
                          border: 1px solid #1f2937; color: #6b7280; border-radius: 3px;
                          padding: 2px 8px; cursor: pointer; }
    .log { font-size: 11px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
           color: #6b7280; overflow-y: auto; border-top: 1px solid #1f2937; padding-top: 10px;
           margin-top: 6px; }
    #clientLog { max-height: 130px; }
    #serverLog { max-height: 340px; color: #9ca3af; }
    #serverLog .err { color: #f87171; }
    #serverLog .stt { color: #60a5fa; }
    #serverLog .tts { color: #c084fc; }
    #serverLog .session { color: #4ade80; }
    .sse-status { font-size: 10px; color: #4b5563; }
  </style>
</head>
<body>
  <h1>VA VOICE — LOCAL DEV</h1>
  <div id="status">Disconnected</div>
  <button id="btn" onclick="toggle()">Start Call</button>

  <div class="panel-label">Client events</div>
  <div id="clientLog" class="log"></div>

  <div class="panel-label">
    <span>Server logs <span id="sseStatus" class="sse-status">(connecting…)</span></span>
    <button onclick="document.getElementById('serverLog').textContent=''">clear</button>
  </div>
  <div id="serverLog" class="log"></div>

<script>
  let ws = null, captureCtx = null, playbackCtx = null, playbackGain = null, micStream = null, workletNode = null;
  let nextPlayTime = 0;
  let scheduledSources = [];

  function appendLog(msg) {
    const el = document.getElementById('clientLog');
    const ts = new Date().toISOString().slice(11, 19);
    el.textContent += ts + '  ' + msg + '\\n';
    el.scrollTop = el.scrollHeight;
  }

  // Live server logs via SSE — runs for the whole page lifetime, independent of call state.
  function startLogStream() {
    const box = document.getElementById('serverLog');
    const statusEl = document.getElementById('sseStatus');
    const es = new EventSource('/local-logs');
    es.onopen = () => { statusEl.textContent = '(live)'; };
    es.onerror = () => { statusEl.textContent = '(reconnecting…)'; };
    es.onmessage = (e) => {
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      const line = document.createElement('div');
      const lower = e.data.toLowerCase();
      if (lower.includes('[error]')) line.className = 'err';
      else if (lower.includes('[stt]')) line.className = 'stt';
      else if (lower.includes('[tts]')) line.className = 'tts';
      else if (lower.includes('[session]')) line.className = 'session';
      line.textContent = e.data;
      box.appendChild(line);
      while (box.childElementCount > 500) box.removeChild(box.firstChild);
      if (atBottom) box.scrollTop = box.scrollHeight;
    };
  }
  startLogStream();

  function setStatus(text, active) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.className = active ? 'active' : '';
  }

  async function toggle() {
    ws ? stop() : await start();
  }

  async function start() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      appendLog('Mic error: ' + e.message);
      return;
    }
    appendLog('Mic access granted');

    // Capture at native 16kHz so the browser's high-quality resampler does the
    // downsampling (with proper anti-aliasing) — NOT our naive decimation.
    // Playback gets its own 24kHz context so TTS plays at its native rate.
    captureCtx = new AudioContext({ sampleRate: 16000 });
    playbackCtx = new AudioContext({ sampleRate: 24000 });
    // All TTS audio plays through this gain node so barge-in can fade it out (soft
    // trail-off) instead of a hard stop (click).
    playbackGain = playbackCtx.createGain();
    playbackGain.connect(playbackCtx.destination);
    appendLog('Capture rate: ' + captureCtx.sampleRate + 'Hz, playback: ' + playbackCtx.sampleRate + 'Hz');
    nextPlayTime = 0;
    scheduledSources = [];

    const blob = new Blob([${JSON.stringify(CAPTURE_WORKLET)}], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      await captureCtx.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    workletNode = new AudioWorkletNode(captureCtx, 'capture-worklet');
    captureCtx.createMediaStreamSource(micStream).connect(workletNode);
    // deliberately not connecting workletNode to destination — avoid mic echo

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/local-stream');
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      appendLog('Connected');
      setStatus('Listening…', true);
      document.getElementById('btn').textContent = 'End Call';
      document.getElementById('btn').className = 'end';
      workletNode.port.onmessage = (e) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(e.data);
      };
    };

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data);
        if (msg.event === 'clear') {
          // Cheap "graceful stop": fade the gain to ~0 over ~18ms so the cut sounds
          // like a soft trail-off, not a hard click — then stop the sources and reset
          // the gain for the next reply. (Still technically mid-word; it just tricks
          // the ear into hearing it as natural.)
          const FADE = 0.018;
          const now = playbackCtx.currentTime;
          try {
            playbackGain.gain.cancelScheduledValues(now);
            playbackGain.gain.setValueAtTime(playbackGain.gain.value, now);
            playbackGain.gain.linearRampToValueAtTime(0, now + FADE);
          } catch {}
          const toStop = scheduledSources;
          scheduledSources = [];
          nextPlayTime = 0;
          setTimeout(() => {
            toStop.forEach(s => { try { s.stop(0); } catch {} });
            try { playbackGain.gain.setValueAtTime(1, playbackCtx.currentTime); } catch {}
          }, FADE * 1000 + 8);
          appendLog('Barge-in: audio faded + cleared');
        } else if (msg.event === 'stop') {
          appendLog('Session ended by agent');
          stop();
        }
        return;
      }
      // Binary: Float32 24kHz PCM from TTS
      const float32 = new Float32Array(e.data);
      const buf = playbackCtx.createBuffer(1, float32.length, 24000);
      buf.copyToChannel(float32, 0);
      const src = playbackCtx.createBufferSource();
      src.buffer = buf;
      src.connect(playbackGain);
      if (nextPlayTime === 0) nextPlayTime = playbackCtx.currentTime + 0.05; // 50ms buffer
      const startAt = Math.max(playbackCtx.currentTime, nextPlayTime);
      src.start(startAt);
      src.onended = () => { scheduledSources = scheduledSources.filter(s => s !== src); };
      scheduledSources.push(src);
      nextPlayTime = startAt + buf.duration;
    };

    ws.onclose = () => {
      appendLog('Disconnected');
      if (ws) stop();
    };

    ws.onerror = () => appendLog('WebSocket error — check server');
  }

  function stop() {
    scheduledSources.forEach(s => { try { s.stop(0); } catch {} });
    scheduledSources = [];
    workletNode?.disconnect();
    workletNode = null;
    micStream?.getTracks().forEach(t => t.stop());
    micStream = null;
    const _ws = ws; ws = null;
    _ws?.close();
    captureCtx?.close();
    captureCtx = null;
    playbackCtx?.close();
    playbackCtx = null;
    playbackGain = null;
    nextPlayTime = 0;
    setStatus('Disconnected', false);
    document.getElementById('btn').textContent = 'Start Call';
    document.getElementById('btn').className = '';
    appendLog('Call ended');
  }
</script>
</body>
</html>`;

// ── Routes ────────────────────────────────────────────────────────────────────

export const localRoute: FastifyPluginAsync = async (app) => {

  app.get('/local', async (_req, reply) => {
    reply.type('text/html').send(HTML);
  });

  // Server-Sent Events: stream every server log line to the browser as it's written.
  app.get('/local-logs', (_req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.write('retry: 2000\n\n');

    const unsubscribe = subscribe((line) => {
      // SSE frames are newline-delimited; strip the trailing newline and prefix each with "data: "
      reply.raw.write(`data: ${line.replace(/\n+$/, '')}\n\n`);
    });

    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 15000);

    reply.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.get('/local-stream', { websocket: true }, (socket: WebSocket, _req: FastifyRequest) => {
    log('[local] browser session started');

    const transport = new BrowserTransport(socket);
    const stt = createStt();
    const tts = createTts();
    const agent = createAgent('local');
    const endpointer = createEndpointer();
    const notifier = createNotifier();

    const session = new CallSession(transport, stt, tts, agent, endpointer, {
      maxDurationSec: persona.maxDurationSec,
      maxTurns: persona.maxTurns,
      silenceTimeoutSec: persona.silenceTimeoutSec,
      greeting: persona.greeting,
    });

    const startedAt = Date.now();

    session.run().catch((err: unknown) => {
      error(`[local] session error: ${String(err)}`);
    });

    socket.on('close', () => {
      log('[local] browser disconnected');
      session.stop();
      notifier.onCallEnded({
        callerNumber: 'local',
        transcript: session.getTranscript(),
        durationMs: Date.now() - startedAt,
      }).catch((err: unknown) => {
        error(`[local] notification failed: ${String(err)}`);
      });
    });
  });

};
