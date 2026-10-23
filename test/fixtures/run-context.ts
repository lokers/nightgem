/** A schema-valid `RunContextSnapshot` for tests, with neutral fixture values. */
import { RunContextSnapshot } from '../../src/contracts.ts';
import { UserProfile } from '../../src/userprofile.ts';

export function makeRunContext(workspaceRoot: string, over: Partial<RunContextSnapshot> = {}): RunContextSnapshot {
  return RunContextSnapshot.parse({
    version: 1,
    workspaceRoot,
    model: 'anthropic/claude-opus-5-5',
    smallModel: 'anthropic/claude-haiku-5-5',
    profile: {
      path: '/Users/alice/.config/nightgem/profile.json',
      sha256: 'a'.repeat(64),
      data: UserProfile.parse({ version: 1, workspaceRoot }),
    },
    skills: {},
    instructions: { text: 'Follow each repo AGENTS.md.', sha256: 'b'.repeat(64) },
    models: { orchestrator: { model: 'anthropic/claude-opus-5-5', variant: 'high' } },
    safety: { workspaceRoot, skillRoots: [], disabledSkills: [], deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] } },
    ...over,
  });
}
