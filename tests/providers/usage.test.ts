/**
 * The usage_request / usage_result pair, and the reading behind it.
 *
 * Two things are worth guarding. The wiring: a `usage_request` arriving on the WebSocket must
 * always produce exactly one `usage_result` carrying the same id, including when the machine
 * cannot help — an unanswered request is indistinguishable from a bridge too old to know the
 * question, and the asker can only find out by waiting out a timeout.
 *
 * And the labelling: a window kind this bridge has never met must still come back with
 * something readable on it. Which allowances exist, and which model gets one of its own, is
 * the vendor's to change; a row that renders as nothing is the failure mode to avoid.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../../src/bridge.js';
import type { ProviderAdapter } from '../../src/providers/base.js';
import type { BridgeToServerMessage, UsageResultMessage } from '../../src/protocol/types.js';
import { readClaudeUsage } from '../../src/providers/usage.js';

/** A bridge with its socket replaced by a list, so the real dispatch runs. */
function harness(providers: string[] = ['claude']) {
  const bridge = new Bridge({
    serverUrl: 'wss://example.test/bridge',
    token: 'irrelevant',
    providers: providers.map((name) => ({
      name,
      version: '1.0.0',
      available: true,
      supports_streaming: true,
    })) as never,
    adapters: new Map<string, ProviderAdapter>(),
    // Never the operator's real store — the suite must not overwrite it.
    sessionStorePath: null,
  });

  const sent: BridgeToServerMessage[] = [];
  const inner = bridge as unknown as {
    send(m: BridgeToServerMessage): void;
    onMessage(data: Buffer): void;
  };
  inner.send = (m) => {
    sent.push(m);
  };

  return {
    sent,
    deliver: (id: string, provider?: string) =>
      inner.onMessage(Buffer.from(JSON.stringify({ type: 'usage_request', id, ...(provider ? { provider } : {}) }))),
    answer: async (): Promise<UsageResultMessage> => {
      await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 15_000 });
      return sent[0] as UsageResultMessage;
    },
  };
}

/** Stand in for the vendor. `undefined` body means the credential read should fail first. */
function vendorReturns(status: number, body?: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body ?? {},
    })),
  );
}

describe('usage_request wiring', () => {
  const HOME = process.env['HOME'];

  beforeEach(() => {
    // BOTH of these are load-bearing. Without the home override this reads the operator's real
    // ~/.claude/.credentials.json, and without the fetch stub it makes a LIVE, AUTHENTICATED,
    // BILLABLE call to the vendor on every run of the suite — spending the developer's own
    // subscription to assert that a frame came back. An earlier version of this file did
    // exactly that, on the assumption that a build machine has no credential.
    process.env['HOME'] = '/nonexistent-home-for-tests';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the network is not available in tests'); }));
  });

  afterEach(() => {
    if (HOME === undefined) delete process.env['HOME'];
    else process.env['HOME'] = HOME;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('answers the same id, and says WHY it cannot help rather than merely answering', async () => {
    const h = harness();
    h.deliver('req-abc');

    const answer = await h.answer();

    expect(answer.type).toBe('usage_result');
    expect(answer.id).toBe('req-abc');
    // Asserting the actual outcome, not just that something came back: the previous version
    // checked only `typeof ok === 'boolean'`, which a completely broken bridge would satisfy.
    expect(answer.ok).toBe(false);
    expect(answer.reason).toBe('no_credential');
  });

  it('never sends the credential back, only figures', async () => {
    const h = harness();
    h.deliver('req-secret');

    const answer = await h.answer();

    expect(JSON.stringify(answer)).not.toMatch(/accessToken|Bearer|sk-ant|ghp_/i);
  });

  it('refuses to report when the CLI asked about is not Claude', async () => {
    const h = harness(['codex']);
    h.deliver('req-codex', 'codex');

    const answer = await h.answer();

    expect(answer).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('refuses to guess when a machine has several CLIs and the server named none', async () => {
    // Answering Claude's figures here would label one subscription as another's, which is
    // worse than reporting nothing because the number looks right.
    const h = harness(['claude', 'codex']);
    h.deliver('req-ambiguous');

    const answer = await h.answer();

    expect(answer).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('answers for Claude when the server names it, even on a multi-CLI machine', async () => {
    const h = harness(['claude', 'codex']);
    h.deliver('req-named', 'claude');

    const answer = await h.answer();

    // Gets as far as reading the credential, which the stubbed home does not have.
    expect(answer).toMatchObject({ ok: false, reason: 'no_credential' });
  });
});

describe('readClaudeUsage', () => {
  const HOME = process.env['HOME'];

  beforeEach(() => {
    // Point HOME at somewhere with no credentials file, so "not signed in" is deterministic
    // rather than depending on whoever runs the suite.
    process.env['HOME'] = '/nonexistent-home-for-tests';
  });

  afterEach(() => {
    if (HOME === undefined) delete process.env['HOME'];
    else process.env['HOME'] = HOME;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports no_credential when nobody is signed in, rather than failing', async () => {
    const answer = await readClaudeUsage();

    expect(answer).toEqual({ ok: false, reason: 'no_credential' });
  });

  it('labels the windows it knows, and still labels one it does not', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const home = mkdtempSync(join(tmpdir(), 'usage-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } }),
    );
    process.env['HOME'] = home;

    vendorReturns(200, {
      limits: [
        { kind: 'session', group: 'session', percent: 32, resets_at: '2026-09-21T11:10:00+00:00' },
        { kind: 'weekly_all', group: 'weekly', percent: 43, resets_at: '2026-09-24T00:00:00+00:00' },
        { kind: 'weekly_scoped', group: 'weekly', percent: 0, scope: { model: { display_name: 'Fable' } } },
        // A kind invented after this bridge shipped. It must still arrive, named.
        { kind: 'lunar_cycle', group: 'lunar', percent: 12 },
      ],
    });

    const answer = await readClaudeUsage();

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    expect(answer.limits.map((l) => l.label)).toEqual([
      'Current session',
      'This week',
      'Fable this week',
      'Lunar cycle',
    ]);
    expect(answer.limits[0]?.percent).toBe(32);
    expect(answer.limits[2]?.resets_at).toBeUndefined();
  });

  it('clamps and rounds a percentage, and drops a row with no figure', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const home = mkdtempSync(join(tmpdir(), 'usage-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } }),
    );
    process.env['HOME'] = home;

    vendorReturns(200, {
      limits: [
        { kind: 'a', percent: 140 },
        { kind: 'b', percent: -5 },
        { kind: 'c', percent: 42.6 },
        { kind: 'd' },
        'not an object',
      ],
    });

    const answer = await readClaudeUsage();

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.limits.map((l) => l.percent)).toEqual([100, 0, 43]);
  });

  it('separates a rejected credential from a broken call', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const home = mkdtempSync(join(tmpdir(), 'usage-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'expired' } }),
    );
    process.env['HOME'] = home;

    vendorReturns(401);
    await expect(readClaudeUsage()).resolves.toEqual({ ok: false, reason: 'no_credential' });

    vendorReturns(500);
    await expect(readClaudeUsage()).resolves.toEqual({ ok: false, reason: 'failed' });

    vendorReturns(200, { nothing: true });
    await expect(readClaudeUsage()).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});
