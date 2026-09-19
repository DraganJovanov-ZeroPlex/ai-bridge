/**
 * The credentials an installed bridge runs with, and the rule about replacing
 * them.
 *
 * Kept in a file of their own rather than inside the unit, on every platform
 * that has somewhere to put one: unit files are world readable and
 * `systemctl cat` prints them, so a token in there is a token on screen the
 * next time somebody debugs the service.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface BridgeConfig {
  server: string;
  token: string;
  /** Passed through to the bridge, so a reinstall does not quietly drop the
   *  folder somebody chose. */
  allowDir?: string | undefined;
}

/** The device this pairing is for, read out of the server url rather than
 *  stored twice. It is what makes "the same install" answerable. */
export function deviceOf(server: string): string | null {
  try {
    return new URL(server).searchParams.get('device');
  } catch {
    return null;
  }
}

export function readConfig(path: string): BridgeConfig | null {
  if (!existsSync(path)) return null;
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0 || line.trimStart().startsWith('#')) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  if (!out['AI_BRIDGE_SERVER'] || !out['AI_BRIDGE_TOKEN']) return null;
  return {
    server: out['AI_BRIDGE_SERVER'],
    token: out['AI_BRIDGE_TOKEN'],
    allowDir: out['AI_BRIDGE_ALLOW_DIR'] || undefined,
  };
}

export function writeConfig(path: string, config: BridgeConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = [
    `AI_BRIDGE_SERVER=${config.server}`,
    `AI_BRIDGE_TOKEN=${config.token}`,
    ...(config.allowDir ? [`AI_BRIDGE_ALLOW_DIR=${config.allowDir}`] : []),
    '',
  ].join('\n');
  writeFileSync(path, body, { mode: 0o600 });
  // Set again explicitly: the mode above applies on CREATE, and a file that
  // already existed keeps whatever it had.
  chmodSync(path, 0o600);
}

/**
 * Whether an install under this name may overwrite what is already there.
 *
 * The same server and the same device is the same install -- somebody re-running
 * the setup to change a folder, or after an upgrade -- and replacing it is what
 * they asked for.
 *
 * Anything else is a different pairing wearing the same name, and replacing it
 * silently is the bug this module exists to prevent: the credentials are gone,
 * the machine keeps answering the old server until it restarts, and nothing
 * anywhere said so.
 */
export function replaceable(existing: BridgeConfig, next: BridgeConfig): true | string {
  const was = deviceOf(existing.server);
  const now = deviceOf(next.server);
  const sameHost = hostOf(existing.server) === hostOf(next.server);
  if (!sameHost) {
    return `it is paired to ${hostOf(existing.server)}, and this would point it at ${hostOf(next.server)}`;
  }
  if (was && now && was !== now) {
    return `it is paired as a different machine on ${hostOf(next.server)} (device ${was.slice(0, 8)}…)`;
  }
  return true;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
