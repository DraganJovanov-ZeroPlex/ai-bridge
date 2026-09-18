/**
 * A turn somebody stopped on purpose is not a failure.
 *
 * The CLI is asked to stop with SIGINT rather than shot, and when that lands
 * while a tool is running it commonly exits non-zero. The finalizer read that
 * exit code the way it reads any other and reported `provider_error` — measured
 * against a real Claude, a turn cancelled three seconds in arrived as the
 * answer it had managed to write, followed by "claude CLI exited with code
 * 143". Somebody who pressed stop got an error they had caused and could do
 * nothing about, and a server cannot tell that apart from a CLI that crashed.
 */

import { describe, it, expect, vi } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import type { AdapterStreamEvent } from '../../src/providers/base.js';
import type { AiRequestMessage } from '../../src/protocol/types.js';

vi.mock('../../src/providers/claude-capabilities.js', () => ({
  supportsPartialMessages: () => Promise.resolve(true),
  resetPartialMessageSupportCache: () => {},
  noteCliRejectedPartialFlag: () => false,
}));

/**
 * Replay lines through the adapter with a child that behaves like the CLI does
 * when it is interrupted: it stays alive after its output and exits non-zero on
 * SIGINT, exactly as a `claude -p` stopped mid-tool does.
 */
async function run(opts: {
  lines: unknown[];
  abortAfterMs: number | null;
  exitCode?: number;
  /** Lines the CLI writes on its way out, after `lateAfterMs`. */
  lateLines?: unknown[];
  lateAfterMs?: number;
  /** A bound of the bridge's own, for the twin of the cancel case. */
  silenceTimeoutSeconds?: number;
}): Promise<AdapterStreamEvent[]> {
  const scratch = mkdtempSync(join(tmpdir(), 'cancelled-'));
  const path = join(scratch, 'stream.ndjson');
  writeFileSync(path, opts.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const latePath = join(scratch, 'late.ndjson');
  writeFileSync(latePath, (opts.lateLines ?? []).map((l) => JSON.stringify(l)).join('\n') + '\n');

  class Replay extends ClaudeAdapter {
    protected override spawnCli(): ChildProcessByStdio<Writable | null, Readable, Readable> {
      return spawn(
        process.execPath,
        [
          '-e',
          // The late file, when there is one, is written on the way out —
          // after the SIGINT — which is how a CLI that reports an error result
          // as it stops behaves.
          'const fs = require("fs");'
          + 'const late = fs.readFileSync(process.argv[4], "utf8").trim();'
          + 'const bye = () => { if (late) process.stdout.write(late + "\\n");'
          + '  setTimeout(() => process.exit(Number(process.argv[2])), 50); };'
          + 'process.on("SIGINT", bye);'
          + 'process.stdout.write(fs.readFileSync(process.argv[1], "utf8"));'
          + 'setTimeout(() => process.exit(Number(process.argv[3])), 3000);',
          path,
          String(opts.exitCode ?? 143),
          String(opts.exitCode ?? 0),
          latePath,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    }
  }

  const request: AiRequestMessage = {
    type: 'ai_request',
    request_id: 'req_cancelled',
    conversation_id: 'c',
    provider: 'claude',
    message: 'go',
    system_prompt: null,
    options: {},
    cli_session_id: null,
  };

  const controller = new AbortController();
  if (opts.abortAfterMs !== null) setTimeout(() => controller.abort(), opts.abortAfterMs);

  const events: AdapterStreamEvent[] = [];
  try {
    await new Replay().execute({
      request,
      requestId: request.request_id,
      tools: [],
      mcp: null,
      cliIsolation: 'native',
      workingDir: process.cwd(),
      signal: controller.signal,
      requestTimeoutSeconds: 30,
      silenceTimeoutSeconds: opts.silenceTimeoutSeconds ?? 0,
      cliSessionId: null,
      attachmentDir: null,
      bridgeEnv: {},
      bridgeAddendum: null,
    }, (e) => events.push(e));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  return events;
}

const INIT = { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-x', claude_code_version: '2.1.0' };
const SOME_ANSWER = {
  type: 'assistant',
  message: { id: 'msg_1', content: [{ type: 'text', text: 'partly written' }] },
};
/**
 * A block the CLI opened and never closed, which is what being interrupted
 * actually looks like.
 *
 * A whole `assistant` frame would not do: it opens, fills and closes its block
 * the moment it is parsed, so a test built on one passes whether or not
 * anything closes what the kill left open — it is asserting that a line written
 * before the abort was forwarded, which was true of the broken code too.
 */
const MID_SENTENCE = [
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_open', model: 'claude-x', usage: {} } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partly written' } } },
];

const of = (events: AdapterStreamEvent[], name: string) => events.filter((e) => e.event === name);

describe('a turn that was stopped on purpose', () => {
  it('ends without reporting a provider failure', async () => {
    const events = await run({ lines: [INIT, SOME_ANSWER], abortAfterMs: 150 });

    expect(of(events, 'error')).toHaveLength(0);
    expect(of(events, 'done')).toHaveLength(1);
  });

  it('closes the block the kill interrupted, so the last of the answer survives', async () => {
    // The reason for asking rather than shooting. A consumer that commits a
    // block when it stops — the reference chat UI does — drops everything in an
    // open one, so an unclosed block is the same as a lost answer.
    const events = await run({ lines: [INIT, ...MID_SENTENCE], abortAfterMs: 150 });
    const text = of(events, 'block_delta').map((e) => (e.data as { content: string }).content).join('');

    expect(text).toContain('partly written');
    expect(of(events, 'block_start')).toHaveLength(1);
    expect(of(events, 'block_stop')).toHaveLength(1);
    expect(of(events, 'error')).toHaveLength(0);
  });

  it('does not report an error result the CLI wrote on its way out', async () => {
    // A CLI leaving a SIGINT may write `is_error` as it goes. That path settles
    // the turn inside the adapter, so the finalizer never sees it — and without
    // its own check the server would be told the turn FAILED, when what
    // happened is that somebody stopped it. On a resumed turn that is worse
    // than cosmetic: an error there is what `session_lost` is read from.
    const events = await run({
      lines: [INIT, ...MID_SENTENCE],
      abortAfterMs: 150,
      lateLines: [{
        type: 'result', subtype: 'error_during_execution', is_error: true,
        session_id: 's1', num_turns: 1, duration_ms: 3, usage: {},
      }],
    });

    expect(of(events, 'error')).toHaveLength(0);
    expect(of(events, 'done')).toHaveLength(1);
    expect(of(events, 'block_stop')).toHaveLength(1);
  });

  it('keeps a turn the CLI queued for itself out of a cancelled turn report', async () => {
    // The order of two branches in the finalizer, which nothing else checks.
    // A cancel landing when the only `result` so far belonged to the CLI's own
    // queued work must not fall through to the recovery that settles from a
    // held frame: that would report `done` with zero turns and zero cost — an
    // empty reply that reads as a successful one, which is the fault this whole
    // release exists to remove, arriving by another road.
    const events = await run({
      lines: [
        INIT,
        {
          type: 'result', subtype: 'success', is_error: false, session_id: 's1',
          origin: { kind: 'task-notification' },
          num_turns: 0, duration_ms: 71, total_cost_usd: 0, result: '',
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        ...MID_SENTENCE,
      ],
      abortAfterMs: 150,
    });

    const done = of(events, 'done');
    expect(done).toHaveLength(1);
    expect(of(events, 'error')).toHaveLength(0);
    // Bare, not the notification's numbers. `undefined` and `0` are different
    // answers here: one says nothing was reported, the other reports a turn
    // that cost nothing.
    expect((done[0]!.data as Record<string, unknown>)['num_turns']).toBeUndefined();
  });

  it('reports a bound that stopped the turn, not the error the CLI wrote on the way out', async () => {
    // The twin of the cancel case, and the one that was still broken: a bound
    // kills with the same SIGINT, so the CLI writes the same error result — but
    // a bound never touches the abort signal, so the adapter settled the turn
    // with `provider_error` and the finalizer's timeout branch never ran. The
    // server was told the CLI had failed, and never learned the bridge had
    // stopped it or what the limit was.
    const events = await run({
      lines: [INIT, ...MID_SENTENCE],
      abortAfterMs: null,
      silenceTimeoutSeconds: 0.2,
      lateLines: [{
        type: 'result', subtype: 'error_during_execution', is_error: true,
        session_id: 's1', num_turns: 1, duration_ms: 3, usage: {},
      }],
    });

    const errors = of(events, 'error').map((e) => e.data as { code: string; limit_seconds?: number });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('silence_timeout_exceeded');
    expect(errors[0]!.limit_seconds).toBe(0.2);
    expect(of(events, 'done')).toHaveLength(1);
  });

  it('still reports a CLI that failed on its own', async () => {
    // The branch this sits in front of, and the reason it is not a blanket
    // "ignore the exit code": nobody stopped this one.
    const events = await run({ lines: [INIT, SOME_ANSWER], abortAfterMs: null, exitCode: 1 });

    expect(of(events, 'error')).toHaveLength(1);
    expect((of(events, 'error')[0]!.data as { code: string }).code).toBe('provider_error');
  });
});
