/**
 * launchd plist rendering (see docs/opencode-notes.md).
 */
import { dirname, join } from 'node:path';

import { LABEL_PREFIX } from './brand.ts';

/** Seconds launchd waits after SIGTERM before SIGKILL. The graceful stop (interrupt rounds, final reconcile) needs more than the 20 s default. */
export const EXIT_TIMEOUT_SECONDS = 120;

/** Neutral launchd label prefix. Runs launched by older versions keep the label in their RUN.json (`manifest.launchdLabel`). */
export { LABEL_PREFIX };

export function launchdLabel(slug: string): string {
  return `${LABEL_PREFIX}${slug}`;
}

export interface PlistInput {
  label: string;
  programArgs: string[];
  env: Record<string, string>;
  stdout: string;
  stderr: string;
  workingDir: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderPlist(input: PlistInput): string {
  const args = input.programArgs.map((a) => `    <string>${esc(a)}</string>`).join('\n');
  const env = Object.entries(input.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(input.workingDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>AbandonProcessGroup</key>
  <false/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ExitTimeOut</key>
  <integer>${EXIT_TIMEOUT_SECONDS}</integer>
  <key>StandardOutPath</key>
  <string>${esc(input.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(input.stderr)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
</dict>
</plist>
`;
}

/** `/usr/bin/caffeinate -ims <abs node> <orchestratorEntry> --slug <slug>` */
export function buildProgramArgs(opts: { nodePath: string; orchestratorEntry: string; slug: string }): string[] {
  return ['/usr/bin/caffeinate', '-ims', opts.nodePath, opts.orchestratorEntry, '--slug', opts.slug];
}

const BASE_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * Child environment for the job. Built from an allowlist (launchd gives a minimal env anyway), never from
 * a blanket copy: inherited `OPENCODE_*` is dropped except `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`.
 * PATH starts with the absolute node, opencode and git directories, then the system dirs and `~/go/bin` (Go-installed
 * verify tools). `~/.local/bin` is deliberately absent.
 */
export function buildJobEnv(opts: {
  parentEnv: Record<string, string | undefined>;
  home: string;
  nodePath: string;
  opencodePath: string;
  gitPath: string;
}): Record<string, string> {
  const dirs: string[] = [];
  for (const d of [dirname(opts.nodePath), dirname(opts.opencodePath), dirname(opts.gitPath), ...BASE_PATH, join(opts.home, 'go', 'bin')]) {
    if (!dirs.includes(d)) dirs.push(d);
  }
  const env: Record<string, string> = { PATH: dirs.join(':'), HOME: opts.home };
  for (const key of ['USER', 'LOGNAME', 'LANG', 'LC_ALL']) {
    const v = opts.parentEnv[key];
    if (v) env[key] = v;
  }
  const bg = opts.parentEnv.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
  if (bg !== undefined) env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = bg;
  return env;
}
