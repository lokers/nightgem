/**
 * MCP server names from opencode config files.
 *
 * `opencode.json` holds provider API keys and MCP server credentials (`headers`, `environment`, `command` arguments). Only the
 * KEY NAMES of the servers are ever read, from the JSONC syntax tree: no value is materialised, returned, logged or stored.
 * The names feed `SafetyInputs.mcpServerNames`, which switches those servers off for the run.
 *
 * Two layouts exist in 2.0.29 (a v1-style file is migrated on load): `mcp: { <name>: {...} }` and
 * `mcp: { servers: { <name>: {...} } }`. A server literally named `servers` in the first layout is told apart by its `type`
 * (a string): the second layout's `servers` holds only objects.
 */
import { findNodeAtLocation, parseTree } from 'jsonc-parser';

/** The slice of `node:fs` this module uses. */
export interface McpFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  existsSync(path: string): boolean;
}

/**
 * Key names of the `mcp` object of one config text. A missing/non-object `mcp` or unparsable text gives `[]` (the file's
 * other keys are irrelevant here, and doctor reports a broken config elsewhere).
 */
export function mcpServerNamesFromText(text: string): string[] {
  let tree;
  try {
    tree = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  } catch {
    return [];
  }
  const node = tree ? findNodeAtLocation(tree, ['mcp']) : undefined;
  if (!node || node.type !== 'object') return [];
  const keysOf = (obj: typeof node): string[] =>
    (obj.children ?? []).flatMap((prop) => {
      const key = prop.children?.[0];
      return key && key.type === 'string' && typeof key.value === 'string' ? [key.value] : [];
    });
  const names: string[] = [];
  for (const prop of node.children ?? []) {
    const key = prop.children?.[0];
    const value = prop.children?.[1];
    if (!key || key.type !== 'string' || typeof key.value !== 'string') continue;
    const wrapsServers = key.value === 'servers' && value?.type === 'object' && (value.children ?? []).every((p) => p.children?.[1]?.type === 'object');
    if (wrapsServers && value) names.push(...keysOf(value));
    else names.push(key.value);
  }
  return names;
}

/** Distinct server names over several config files, in file order. Unreadable or missing files contribute nothing. */
export function readMcpServerNames(files: readonly string[], fs: McpFs): string[] {
  const out = new Set<string>();
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const n of mcpServerNamesFromText(text)) out.add(n);
  }
  return [...out];
}
