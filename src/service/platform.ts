/**
 * Making a bridge start with the machine, on each platform that can.
 *
 * One shape, three implementations: write a definition, register it, start it.
 * The differences that matter are about PATH and about what a restart means --
 * systemd will not reload a changed environment file on its own, and launchd
 * will not either, and that is precisely the bug that made a reinstall look
 * like it worked while the machine kept answering the old server.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname } from 'node:path';
import type { BridgeConfig } from './config.js';
import type { Paths } from './naming.js';

export type Supported = 'linux' | 'darwin';

export function supported(): Supported | null {
  const os = platform();
  return os === 'linux' || os === 'darwin' ? os : null;
}

/** Where `npx` actually is. A login shell's PATH is not a service's PATH, and
 *  node is usually somewhere only the former knows about. */
function npxPath(): string {
  try {
    return execFileSync('command', ['-v', 'npx'], { shell: true, encoding: 'utf8' }).trim()
      || 'npx';
  } catch {
    return 'npx';
  }
}

const run = (cmd: string, args: string[]): void => {
  execFileSync(cmd, args, { stdio: 'ignore' });
};

export function install(paths: Paths, config: BridgeConfig): void {
  const os = supported();
  if (os === 'darwin') return installLaunchd(paths, config);
  return installSystemd(paths, config);
}

function installSystemd(paths: Paths, config: BridgeConfig): void {
  const allow = config.allowDir ? ` --allow-dir "${config.allowDir}"` : '';
  mkdirSync(dirname(paths.unit), { recursive: true });
  writeFileSync(paths.unit, `[Unit]
Description=AI Bridge (${paths.label})
After=network-online.target

[Service]
Type=simple
EnvironmentFile=${paths.env}
# A login shell's PATH is not a service's PATH.
Environment=PATH=%h/.local/bin:%h/.nvm/versions/node/current/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${npxPath()} -y --ignore-scripts @tetrixdev/ai-bridge${allow}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`);
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', paths.label]);
  // `enable --now` does NOTHING to a unit that is already running, so a
  // reinstall wrote new credentials and left the old ones loaded. Restart is
  // the whole point of reinstalling.
  run('systemctl', ['--user', 'restart', paths.label]);
}

function installLaunchd(paths: Paths, config: BridgeConfig): void {
  const home = homedir();
  const args = ['-y', '--ignore-scripts', '@tetrixdev/ai-bridge'];
  if (config.allowDir) args.push('--allow-dir', config.allowDir);
  mkdirSync(dirname(paths.unit), { recursive: true });
  mkdirSync(dirname(paths.log), { recursive: true });
  // launchd has no EnvironmentFile, so the credentials go in the plist and the
  // plist is locked down. Mode is set on write rather than after: a plist is
  // readable by everyone by default and a token in it would be too.
  writeFileSync(paths.unit, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${paths.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${npxPath()}</string>${args.map((a) => `<string>${a}</string>`).join('')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AI_BRIDGE_SERVER</key><string>${config.server}</string>
    <key>AI_BRIDGE_TOKEN</key><string>${config.token}</string>
    <key>PATH</key><string>${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${paths.log}</string>
  <key>StandardErrorPath</key><string>${paths.log}</string>
</dict>
</plist>
`, { mode: 0o600 });
  // Unload first, for the same reason systemd gets a restart: a loaded agent
  // holds its old environment until it is told otherwise.
  try { run('launchctl', ['unload', paths.unit]); } catch { /* not loaded yet */ }
  run('launchctl', ['load', paths.unit]);
}

export function uninstall(paths: Paths): void {
  const os = supported();
  if (os === 'darwin') {
    try { run('launchctl', ['unload', paths.unit]); } catch { /* already gone */ }
  } else {
    try { run('systemctl', ['--user', 'disable', '--now', paths.label]); } catch { /* already gone */ }
  }
  for (const file of [paths.unit, paths.env]) {
    if (existsSync(file)) rmSync(file);
  }
  if (os !== 'darwin') {
    try { run('systemctl', ['--user', 'daemon-reload']); } catch { /* best effort */ }
  }
}

/** What the operating system says this service is doing, for `list`. */
export function status(paths: Paths): string {
  try {
    if (supported() === 'darwin') {
      const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
      return out.split('\n').some((l) => l.endsWith(paths.label)) ? 'loaded' : 'not loaded';
    }
    return execFileSync('systemctl', ['--user', 'is-active', paths.label], { encoding: 'utf8' }).trim();
  } catch {
    return 'stopped';
  }
}
