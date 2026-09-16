/**
 * One `claude -p` invocation, more than one turn.
 *
 * The CLI answers work it queued for ITSELF before it dequeues the message the
 * bridge sent, and every one of those turns ends with a `result` frame of its
 * own. Settling on the first one ended the turn roughly 70ms in: the server got
 * a `done` with zero tokens, the real answer was dropped frame by frame, and
 * the person saw an empty message — twice, because retrying re-queued nothing
 * and hit the same notification.
 *
 * The fixture is real. The two leading frames were captured by leaving a
 * background `sleep 300` running and resuming that session (Claude Code
 * 2.1.x); the turn after them is the captured two-tool turn the passthrough
 * tests use. Neither half was written by hand, which is the point: the
 * discriminator these tests assert on is the CLI's, not one this code invented.
 */

import { describe, it, expect, vi } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import type { AdapterStreamEvent } from '../../src/providers/base.js';
import type { AiRequestMessage } from '../../src/protocol/types.js';

vi.mock('../../src/providers/claude-capabilities.js', () => ({
  supportsPartialMessages: () => Promise.resolve(true),
  resetPartialMessageSupportCache: () => {},
  noteCliRejectedPartialFlag: () => false,
}));

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

interface Replayed {
  events: AdapterStreamEvent[];
  /** When `done` was emitted, relative to the child process exiting. */
  doneBeforeExitMs: number | null;
}

/** Replay NDJSON — a fixture file, or lines given inline — through the adapter. */
async function replay(
  source: ({ fixture: string } | { lines: unknown[] }) & { holdOpenMs?: number },
): Promise<Replayed> {
  let path: string;
  let scratch: string | null = null;
  if ('fixture' in source) {
    path = join(FIXTURES, source.fixture);
  } else {
    scratch = mkdtempSync(join(tmpdir(), 'queued-'));
    path = join(scratch, 'stream.ndjson');
    writeFileSync(path, source.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  class Replay extends ClaudeAdapter {
    protected override spawnCli(): ChildProcessByStdio<Writable | null, Readable, Readable> {
      return spawn(
        process.execPath,
        [
          '-e',
          // Holds the process open after the last line when asked. Without that
          // every `done` would land "before exit" for free and the test that
          // says the common case does not wait for exit would prove nothing.
          'const fs = require("fs");'
          + 'process.stdout.write(fs.readFileSync(process.argv[1], "utf8"));'
          + 'const hold = Number(process.argv[2] || 0);'
          + 'if (hold > 0) setTimeout(() => {}, hold);',
          path,
          String(source.holdOpenMs ?? 0),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    }
  }

  const request: AiRequestMessage = {
    type: 'ai_request',
    request_id: 'req_queued',
    conversation_id: 'c',
    provider: 'claude',
    message: 'go',
    system_prompt: null,
    options: {},
    cli_session_id: null,
  };

  const events: AdapterStreamEvent[] = [];
  let doneAt: number | null = null;
  try {
    await new Replay().execute({
      request,
      requestId: request.request_id,
      tools: [],
      mcp: null,
      cliIsolation: 'native',
      workingDir: process.cwd(),
      signal: new AbortController().signal,
      requestTimeoutSeconds: 30,
      silenceTimeoutSeconds: 0,
      cliSessionId: null,
      attachmentDir: null,
    }, (e) => {
      if (e.event === 'done') doneAt = Date.now();
      events.push(e);
    });
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }

  return { events, doneBeforeExitMs: doneAt === null ? null : Date.now() - doneAt };
}

const of = (events: AdapterStreamEvent[], name: string) => events.filter((e) => e.event === name);

/** The `result` frame of the real turn in the fixture, verbatim from the CLI. */
const REAL_TURN = {
  num_turns: 3,
  subtype: 'success',
  stop_reason: 'end_turn',
  input_tokens: 6,
  cache_creation_input_tokens: 5429,
  output_tokens: 183,
};

/** The `result` the CLI emits for the `<task-notification>` it queued itself. */
const NOTIFICATION_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  origin: { kind: 'task-notification' },
  session_id: 's1',
  num_turns: 0,
  duration_ms: 71,
  duration_api_ms: 0,
  total_cost_usd: 0,
  stop_reason: null,
  result: '',
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
};

describe('a turn the CLI queued for itself', () => {
  it('does not end the turn the server asked for', async () => {
    const { events } = await replay({ fixture: 'claude-queued-notification-turn.ndjson' });
    const done = of(events, 'done');

    expect(done).toHaveLength(1);
    // The REAL turn's numbers. The notification's are all zero, so a `done`
    // built from it would still be one `done` — and would report a turn that
    // cost nothing and said nothing.
    const data = done[0]!.data as unknown as {
      num_turns: number; subtype: string; stop_reason: string;
      usage: Record<string, number>;
    };
    expect(data.num_turns).toBe(REAL_TURN.num_turns);
    expect(data.stop_reason).toBe(REAL_TURN.stop_reason);
    expect(data.usage['input_tokens']).toBe(REAL_TURN.input_tokens);
    expect(data.usage['cache_creation_input_tokens']).toBe(REAL_TURN.cache_creation_input_tokens);
    expect(data.usage['output_tokens']).toBe(REAL_TURN.output_tokens);
  });

  it('delivers the whole answer that followed it', async () => {
    // What the incident actually cost: two tools ran and their output never
    // reached the server, one warning line per result.
    const { events } = await replay({ fixture: 'claude-queued-notification-turn.ndjson' });
    const results = of(events, 'tool_result').map((e) => (e.data as { result: string }).result);

    expect(results).toHaveLength(2);
    expect(results[0]).toContain('hello');
    expect(results[1]).toContain('TN-7781');
    expect(of(events, 'error')).toHaveLength(0);
  });

  it('changes nothing about the turn it precedes', async () => {
    // The strongest form of "it is ignored": the same stream with the two
    // notification frames spliced off the front produces the same events.
    const withNotification = await replay({ fixture: 'claude-queued-notification-turn.ndjson' });
    const without = await replay({ fixture: 'claude-tool-results-turn.ndjson' });

    expect(withNotification.events).toEqual(without.events);
  });

  it('is reported if the CLI never answers our prompt at all', async () => {
    // The fallback that makes holding a frame back safe. If the CLI stops after
    // its own queued work — or stamps an `origin` on a result that IS ours —
    // the turn ends on what we have, not on "the AI returned no response".
    const { events } = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-x', claude_code_version: '2.1.0' },
        NOTIFICATION_RESULT,
      ],
    });

    expect(of(events, 'error')).toHaveLength(0);
    expect(of(events, 'done')).toHaveLength(1);
    expect((of(events, 'done')[0]!.data as { num_turns: number }).num_turns).toBe(0);
  });

  it('reports a held result that failed as a failure', async () => {
    // Falling back to it must not launder it. A queued turn that errored, with
    // nothing of ours after it, is a turn that failed — not one that was empty.
    const { events } = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-x', claude_code_version: '2.1.0' },
        { ...NOTIFICATION_RESULT, is_error: true, subtype: 'error_during_execution' },
      ],
    });

    expect(of(events, 'error')).toHaveLength(1);
    expect((of(events, 'error')[0]!.data as { message: string }).message).toBe('error_during_execution');
    expect(of(events, 'done')).toHaveLength(1);
  });

  it('holds back an origin it has never seen before', async () => {
    // Keyed on `origin` being there at all, not on the one kind we captured. A
    // new kind of queued work must not be able to end somebody's turn.
    const { events } = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-x', claude_code_version: '2.1.0' },
        { ...NOTIFICATION_RESULT, origin: { kind: 'some-future-thing' } },
        { ...NOTIFICATION_RESULT, origin: undefined, num_turns: 2, result: 'the answer' },
      ],
    });

    expect(of(events, 'done')).toHaveLength(1);
    expect((of(events, 'done')[0]!.data as { num_turns: number }).num_turns).toBe(2);
  });

  it('still ends an ordinary turn without waiting for the process to exit', async () => {
    // The cost of the fallback, bounded. A result that is ours settles the turn
    // where it always did; only a held one waits for the exit.
    const { events, doneBeforeExitMs } = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-x', claude_code_version: '2.1.0' },
        { ...NOTIFICATION_RESULT, origin: undefined, num_turns: 1 },
      ],
      holdOpenMs: 400,
    });

    expect(of(events, 'done')).toHaveLength(1);
    expect(doneBeforeExitMs).toBeGreaterThan(200);
  });
});

describe('why a turn ended', () => {
  it('carries the subtype the CLI reported, so an empty turn can say what happened', async () => {
    const { events } = await replay({
      lines: [
        { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-x', claude_code_version: '2.1.0' },
        { ...NOTIFICATION_RESULT, origin: undefined, subtype: 'error_max_turns', num_turns: 9 },
      ],
    });

    expect((of(events, 'done')[0]!.data as { subtype: string }).subtype).toBe('error_max_turns');
  });
});
