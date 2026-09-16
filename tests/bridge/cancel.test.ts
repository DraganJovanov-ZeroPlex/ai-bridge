/**
 * Stopping a turn from the server, over a real socket.
 *
 * The other half of `ai_request`, and the bridge was not listening for it. The
 * server package has sent `{"type":"cancel"}` for as long as it has had a stop
 * button — and the bridge logged "unknown message type received" and let the
 * turn run to its end on somebody's machine, while the server sat waiting for a
 * `cancelled` frame that was never going to arrive.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Bridge } from '../../src/bridge.js';
import { ProviderAdapter, type AdapterStreamEvent, type ExecutionContext } from '../../src/providers/base.js';
import type { ModelInfo } from '../../src/protocol/types.js';
import { RequestRefusal } from '../../src/errors.js';

/** Runs until it is aborted, and reports what happened to it. */
class PatientAdapter extends ProviderAdapter {
  readonly providerName = 'fake';
  aborted = false;

  execute(context: ExecutionContext, onEvent: (e: AdapterStreamEvent) => void): Promise<string | null> {
    onEvent({ event: 'block_start', data: { block_index: 0, block_type: 'text' } });

    return new Promise((resolve) => {
      const finish = (): void => {
        this.aborted = true;
        onEvent({ event: 'done', data: {} });
        resolve('sess-1');
      };
      if (context.signal.aborted) { finish(); return; }
      context.signal.addEventListener('abort', finish, { once: true });
    });
  }
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }
}

/**
 * Fails the way the work before the CLI fails when a turn is stopped during it:
 * with a refusal, which carries its own terminal code.
 */
class FailsWhenStopped extends ProviderAdapter {
  readonly providerName = 'fake';

  execute(context: ExecutionContext): Promise<string | null> {
    return new Promise((_resolve, reject) => {
      const fail = (): void => reject(new RequestRefusal(
        'attachment_failed',
        'Attachment "invoice.pdf" could not be fetched: This operation was aborted',
      ));
      if (context.signal.aborted) { fail(); return; }
      context.signal.addEventListener('abort', fail, { once: true });
    });
  }
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }
}

let wss: WebSocketServer;
let url: string;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;

async function waitFor(
  match: (f: Record<string, unknown>) => boolean,
  what: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; saw: ${JSON.stringify(frames)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function startBridge(adapter: PatientAdapter): Promise<void> {
  bridge = new Bridge({
    serverUrl: url,
    token: 'tok',
    providers: [{
      name: 'fake', version: '1', available: true, supports_streaming: true,
      supports_tools: true, supports_thinking: false, supports_session_resume: true,
    }],
    adapters: new Map([['fake', adapter as unknown as ProviderAdapter]]),
    sessionStorePath: null,
    allowedRoots: [],
  });
  bridge.connect();
  await waitFor((f) => f['type'] === 'hello', 'hello');
  socket.send(JSON.stringify({
    type: 'welcome',
    session_id: 'conn-1',
    tools: [],
    // No bound of its own: this test is about the server ending the turn, and a
    // clock that could also end it would make the outcome ambiguous.
    config: { heartbeat_interval: 30, request_timeout: 0, silence_timeout: 0 },
    cli_isolation: 'workspace',
  }));
  await new Promise((r) => setTimeout(r, 50));
}

beforeEach(async () => {
  frames = [];
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
  wss.once('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => {
      frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
});

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

describe('cancel', () => {
  it('stops the turn it names, and the turn ends like any other', async () => {
    const adapter = new PatientAdapter();
    await startBridge(adapter);

    socket.send(JSON.stringify({
      type: 'ai_request',
      request_id: 'req_stop',
      conversation_id: 'conv-1',
      provider: 'fake',
      message: 'take your time',
      system_prompt: null,
      options: {},
      cli_session_id: null,
    }));
    await waitFor((f) => f['type'] === 'stream' && f['event'] === 'block_start', 'the turn starting');

    socket.send(JSON.stringify({ type: 'cancel', request_id: 'req_stop' }));

    // It ends as a turn, not as a fault: what it produced is kept and the end
    // of it is reported, which is what lets the next message carry on.
    await waitFor(
      (f) => f['type'] === 'stream' && f['event'] === 'done' && f['request_id'] === 'req_stop',
      'the turn ending',
    );
    expect(adapter.aborted).toBe(true);
  });

  it('tells the server the turn has stopped', async () => {
    // The frame the server has always been waiting for. Without it the stop
    // button on the other end never resolves: `BridgeStream::cancel()` sends
    // the cancel and keeps the pending request open for exactly this reply.
    const adapter = new PatientAdapter();
    await startBridge(adapter);

    socket.send(JSON.stringify({
      type: 'ai_request',
      request_id: 'req_stop',
      conversation_id: 'conv-1',
      provider: 'fake',
      message: 'take your time',
      system_prompt: null,
      options: {},
      cli_session_id: null,
    }));
    await waitFor((f) => f['type'] === 'stream' && f['event'] === 'block_start', 'the turn starting');

    socket.send(JSON.stringify({ type: 'cancel', request_id: 'req_stop' }));
    await waitFor((f) => f['type'] === 'cancelled' && f['request_id'] === 'req_stop', 'the cancelled reply');

    // AFTER the turn's own events, not on receipt of the cancel. The CLI is
    // asked to stop rather than shot, so it commonly writes a little more on
    // the way out — and the server treats `cancelled` as terminal, so a reply
    // that went out first would cut off the partial answer that stopping
    // cleanly exists to keep.
    const order = frames.map((f) => f['type'] === 'cancelled' ? 'cancelled' : `${String(f['type'])}:${String(f['event'] ?? '')}`);
    expect(order.indexOf('cancelled')).toBeGreaterThan(order.indexOf('stream:done'));
  });

  it('reports the cancel, not whatever the cancel broke', async () => {
    // Work that runs BEFORE the CLI takes the same signal: aborting during an
    // attachment download rejects the fetch, which arrives here as a refusal
    // saying the attachment could not be fetched — a server may read that as
    // transient and try again. On a resumed turn it is worse: any failure there
    // is turned into `session_lost`, so the server would wipe the session and
    // silently re-issue the turn somebody had just stopped.
    const adapter = new FailsWhenStopped();
    await startBridge(adapter as unknown as PatientAdapter);

    socket.send(JSON.stringify({
      type: 'ai_request',
      request_id: 'req_refuse',
      conversation_id: 'conv-1',
      provider: 'fake',
      // A resumed turn, which is the shape that would have been re-issued.
      cli_session_id: 'sess-earlier',
      message: 'take your time',
      system_prompt: null,
      options: {},
    }));
    await waitFor((f) => f['type'] === 'ai_request_ack', 'the request starting');

    socket.send(JSON.stringify({ type: 'cancel', request_id: 'req_refuse' }));
    await waitFor((f) => f['type'] === 'cancelled' && f['request_id'] === 'req_refuse', 'the cancelled reply');

    const errors = frames.filter((f) => f['type'] === 'stream' && f['event'] === 'error');
    expect(errors).toHaveLength(0);
    expect(frames.filter((f) => f['type'] === 'stream' && f['event'] === 'done')).toHaveLength(1);
  });

  it('ignores an id that is not running, because that race is the ordinary case', async () => {
    const adapter = new PatientAdapter();
    await startBridge(adapter);

    socket.send(JSON.stringify({ type: 'cancel', request_id: 'req_never_existed' }));
    await new Promise((r) => setTimeout(r, 100));

    // Somebody pressing stop as the answer lands is not worth a frame, and
    // answering would describe a turn that has already been reported.
    //
    // Named rather than counted: a handshake frame the bridge sends on its own
    // schedule once made this fail under the full suite and pass on its own,
    // which is a test reporting the timing of something it is not about.
    expect(frames.filter((f) => f['type'] === 'cancelled')).toHaveLength(0);
    expect(frames.filter((f) => f['type'] === 'error')).toHaveLength(0);
  });
});
