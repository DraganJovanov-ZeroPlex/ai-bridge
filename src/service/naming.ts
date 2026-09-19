/**
 * What an installed bridge is CALLED, and where that puts its files.
 *
 * A bridge used to be a singleton on a machine: one env file, one unit, fixed
 * paths. That is right until somebody runs a second server -- a test instance
 * beside production is the ordinary case, not an exotic one -- and then the
 * second install silently overwrites the first's credentials while reporting
 * success. The machine keeps answering the old server until something restarts
 * it, and then it answers the new one and the old pairing is gone.
 *
 * So every install has a name, and the name is what decides whether a second
 * install REPLACES or JOINS. Same name, same thing: replace it. Different name:
 * they sit beside each other.
 */
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** Characters a unit name, a launchd label and a filename all accept. */
const SAFE = /[^a-z0-9]+/g;

/**
 * A name from the server's address, which is the default because it is the
 * thing that actually distinguishes two bridges: one per Engram.
 *
 * Not the device label, though it reads better. A label can be renamed from the
 * web interface, and a rename would not move the service -- it would orphan the
 * old one and quietly install a second, which is the failure this whole module
 * exists to stop.
 */
export function nameFromServer(server: string): string {
  let host: string;
  try {
    host = new URL(server).hostname;
  } catch {
    host = server;
  }
  const slug = host.toLowerCase().replace(SAFE, '-').replace(/^-+|-+$/g, '');
  return slug || 'default';
}

/** A name somebody typed, held to the same shape. Rejected rather than mangled
 *  past recognition: a name is how they will find this service again. */
export function normaliseName(raw: string): string {
  const slug = raw.toLowerCase().replace(SAFE, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`"${raw}" has no letters or digits in it, so it cannot name a service.`);
  if (slug.length > 60) throw new Error(`"${raw}" is too long for a service name; 60 characters or fewer.`);
  return slug;
}

export interface Paths {
  /** Where the credentials live, readable only by their owner. */
  env: string;
  /** The unit, agent or task definition. */
  unit: string;
  /** What the operating system knows this service as. */
  label: string;
  /** Where its output goes, on the platforms that need telling. */
  log: string;
}

export function pathsFor(name: string): Paths {
  const home = homedir();
  const os = platform();
  if (os === 'darwin') {
    return {
      env: join(home, '.config', 'ai-bridge', `${name}.env`),
      unit: join(home, 'Library', 'LaunchAgents', `dev.aibridge.${name}.plist`),
      label: `dev.aibridge.${name}`,
      log: join(home, 'Library', 'Logs', `ai-bridge-${name}.log`),
    };
  }
  return {
    env: join(home, '.config', 'ai-bridge', `${name}.env`),
    unit: join(home, '.config', 'systemd', 'user', `ai-bridge-${name}.service`),
    label: `ai-bridge-${name}`,
    log: '',
  };
}
