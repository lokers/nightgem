/**
 * `nightgem render`: render everything a launch would hand to the run server, WITHOUT launching and without
 * touching `.specs` or the control dir.
 *
 * `renderRunArtifacts` is pure: the renderers (config, sandbox, server env, prompts) are injected.
 * `writeRenderedFiles` is the only part that touches the filesystem, and it only writes under the given `--out` dir.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { APP } from './brand.ts';
import type { RunContextSnapshot, RunManifest } from './contracts.ts';
import { PROMPT_NAMES, promptVars, renderPrompt, type PromptVars } from './prompts.ts';
import { buildServerEnv, type BuildServerEnvInput } from './server.ts';
import { renderRunConfig, type AgentModelOverride, type RenderedRunConfig, type RenderRunConfigInput } from './profile.ts';
import { renderSandboxProfile, type SandboxProfileInput } from './sandbox.ts';
import { offeredSkillsText } from './skills.ts';
import { runPaths } from './paths.ts';
import { controlRootFor } from './userprofile.ts';

/** The functions `render` composes. Real ones: `realRenderers`. Tests inject fakes. */
export interface RenderRenderers {
  renderRunConfig(i: RenderRunConfigInput): RenderedRunConfig;
  renderSandboxProfile(i: SandboxProfileInput): string;
  buildServerEnv(i: BuildServerEnvInput): Record<string, string>;
  renderPrompt(name: string, vars: PromptVars): string;
  /** Every prompt name, in render order. Names ending in `_append` are the slim system appends. */
  promptNames: readonly string[];
  /** Vars the caller must supply for a prompt. */
  promptVars(name: string): string[];
}

export const realRenderers: RenderRenderers = {
  renderRunConfig,
  renderSandboxProfile,
  buildServerEnv,
  renderPrompt,
  promptNames: PROMPT_NAMES,
  promptVars: (name) => promptVars(name as (typeof PROMPT_NAMES)[number]),
};

export interface RenderInput {
  slug: string;
  home: string;
  context: RunContextSnapshot;
  /** What `launch` would write to RUN.json (built with `buildLaunchManifest`). */
  manifestPreview: RunManifest;
  /** Absolute path of `profile/guard`. */
  guardDir: string;
  /** Absolute path of `profile/git-ssh-fetch-only.sh`. */
  sshWrapper: string;
  /** The run's `$TMPDIR`. Fixed by the caller so renders are reproducible. */
  tmpDir: string;
  port: number;
  /** Stand-in for the server password: it is rendered into the env, then redacted. */
  password: string;
}

export interface RenderedFile {
  /** Relative to the output dir, posix separators. */
  path: string;
  content: string;
}

export const REDACTED = '<redacted>';
/** Env var names whose values are secrets (the safety env's `GH_TOKEN=invalid` placeholders are not). */
const SECRET_KEY_RE = /PASSWORD|SECRET|TOKEN|API_?KEY|CREDENTIAL/i;
const PLACEHOLDER_VALUES = new Set(['', 'invalid']);

/** Replace the password and any other secret env value by `<redacted>`; the (large) config JSON is a pointer to its own file. */
export function redactEnv(env: Readonly<Record<string, string>>, password: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const value = env[key] as string;
    if (key === 'OPENCODE_CONFIG_CONTENT') out[key] = '<see opencode.config.json>';
    else if ((password !== '' && value.includes(password)) || (SECRET_KEY_RE.test(key) && !PLACEHOLDER_VALUES.has(value))) {
      out[key] = REDACTED;
    } else out[key] = value;
  }
  return out;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function renderRunArtifacts(input: RenderInput, r: RenderRenderers): RenderedFile[] {
  const { slug, home, context } = input;
  const paths = runPaths(slug, { home, workspaceRoot: context.workspaceRoot });
  const agentModels: Record<string, AgentModelOverride> = {};
  for (const [agent, m] of Object.entries(context.models)) agentModels[agent] = m.variant ? { model: m.model, variant: m.variant } : { model: m.model };

  const rendered = r.renderRunConfig({
    slug,
    home,
    workspaceRoot: context.workspaceRoot,
    runDir: paths.runDir,
    controlDir: paths.controlDir,
    tmpDir: input.tmpDir,
    model: context.model,
    smallModel: context.smallModel,
    guardDir: input.guardDir,
    agentModels,
    safety: context.safety,
    mcpServerNames: context.safety.mcpServerNames ?? [],
  });
  const sandbox = r.renderSandboxProfile({
    home,
    workspaceRoot: context.workspaceRoot,
    tmpDir: input.tmpDir,
    xdgDataHome: paths.xdgDataHome,
    port: input.port,
    safety: context.safety,
  });
  const env = r.buildServerEnv({
    baseEnv: {},
    slug,
    home,
    workspaceRoot: context.workspaceRoot,
    safety: context.safety,
    password: input.password,
    port: input.port,
    paths,
    tmpDir: input.tmpDir,
    configContentJson: rendered.configContentJson,
    sshWrapper: input.sshWrapper,
  });

  // the vars the orchestrator hands every prompt; anything else a prompt needs (phase, cost, ...) is shown as <name>
  const baseVars: PromptVars = {
    slug,
    specsDir: paths.specsDir,
    specMd: paths.specMd,
    planMd: paths.planMd,
    statusMd: paths.statusMd,
    decisionsMd: paths.decisionsMd,
    decisionsJsonl: paths.decisionsJsonl,
    tasksJsonl: paths.tasksJsonl,
    reportMd: paths.reportMd,
    eventsDir: paths.runDir,
    workspaceRoot: context.workspaceRoot,
    workspaceInstructions: context.instructions.text,
    skillsList: offeredSkillsText(context),
  };

  const files: RenderedFile[] = [
    { path: 'opencode.config.json', content: json(rendered.configContent) },
    { path: 'oh-my-opencode-slim.jsonc', content: `// Generated by ${APP}. Read-only. Do not edit.\n${json(rendered.slimOverrides)}` },
    { path: 'sandbox.sb', content: sandbox.endsWith('\n') ? sandbox : `${sandbox}\n` },
    { path: 'guard-env.json', content: json(redactEnv(env, input.password)) },
  ];
  for (const name of r.promptNames) {
    const vars: PromptVars = { ...baseVars };
    for (const v of r.promptVars(name)) if (!(v in vars)) vars[v] = `<${v}>`;
    const dir = name.endsWith('_append') ? 'appends' : 'prompts';
    files.push({ path: `${dir}/${name}.md`, content: r.renderPrompt(name, vars) });
  }
  files.push({ path: 'run-context.json', content: json(context) });
  files.push({ path: 'manifest-preview.json', content: json(input.manifestPreview) });
  return files;
}

const within = (outer: string, inner: string): boolean => {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * `--out` must not be (inside) the workspace's `.specs` or the control root: render never writes run state.
 * @returns the resolved output dir.
 */
export function assertSafeOutDir(out: string, ctx: { home: string; workspaceRoot: string }): string {
  const dir = resolve(out);
  const forbidden = [join(ctx.workspaceRoot, '.specs'), controlRootFor(ctx.home)];
  for (const f of forbidden) {
    if (within(f, dir)) throw new Error(`Refusing to render into ${dir}: it is inside ${f}`);
  }
  return dir;
}

/** Write the files under `outDir` (created). Paths that escape `outDir` are refused. */
export function writeRenderedFiles(outDir: string, files: readonly RenderedFile[]): string[] {
  const written: string[] = [];
  for (const f of files) {
    const target = resolve(outDir, f.path);
    if (!target.startsWith(resolve(outDir) + sep)) throw new Error(`Refusing to write outside ${outDir}: ${f.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, { mode: 0o644 });
    written.push(f.path);
  }
  return written;
}
