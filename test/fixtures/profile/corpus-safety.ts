import type { SafetyInputs } from '../../../src/contracts.ts';

/**
 * Workspace-specific safety inputs: a denied tracker CLI (`twg`) and its login dir, a shell-pattern deny, generated-code edit denies and two skill roots. The generic
 * defaults deliberately do not carry these, so every test that replays the workspace-specific corpus sections passes them in.
 */
export function corpusSafety(workspaceRoot: string, home: string): SafetyInputs {
  return {
    workspaceRoot,
    skillRoots: [`${home}/.claude/plugins/marketplaces`, `${home}/.agents/skills`],
    disabledSkills: [],
    deny: {
      commands: ['twg'],
      shellPatterns: ['*other-runner*'],
      secretPaths: ['.config/twg'],
      editPaths: ['**/api-spec.yaml', '**/libs/api-client/src/generated/**'],
    },
  };
}

/** Generic defaults only: what a run gets when the user's profile adds nothing. */
export function emptySafety(workspaceRoot: string): SafetyInputs {
  return { workspaceRoot, skillRoots: [], disabledSkills: [], deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] } };
}

/** The MCP server of the user's global config that the workspace-specific corpus probes (`deny|atlassian_*`) assume. */
export const WORKSPACE_MCP_SERVERS = ['atlassian'];
