import { describe, expect, it } from 'vitest';

import { mcpServerNamesFromText, readMcpServerNames } from '../src/mcp.ts';

const SECRET = 'SECRET-TOKEN-must-never-be-read';

describe('mcpServerNamesFromText', () => {
  it('returns the key names of the mcp object and nothing else', () => {
    const text = JSON.stringify({
      provider: { x: { options: { apiKey: SECRET } } },
      mcp: {
        atlassian: { type: 'remote', url: 'https://mcp.example.com/sse', headers: { Authorization: `Bearer ${SECRET}` } },
        github: { type: 'local', command: ['npx', 'server'], environment: { TOKEN: SECRET } },
      },
    });
    const names = mcpServerNamesFromText(text);
    expect(names).toEqual(['atlassian', 'github']);
    expect(JSON.stringify(names)).not.toContain(SECRET);
  });

  it('reads the servers layout (mcp.servers.<name>) and tells a v1 server named "servers" apart', () => {
    const v2 = JSON.stringify({ mcp: { servers: { atlassian: { type: 'remote', url: 'https://mcp.example.com', headers: { a: SECRET } }, github: {} } } });
    expect(mcpServerNamesFromText(v2)).toEqual(['atlassian', 'github']);
    expect(mcpServerNamesFromText(JSON.stringify({ mcp: { servers: {} } }))).toEqual([]);
    const v1Named = JSON.stringify({ mcp: { servers: { type: 'local', command: [SECRET] }, other: {} } });
    expect(mcpServerNamesFromText(v1Named)).toEqual(['servers', 'other']);
  });

  it('accepts JSONC (comments, trailing commas) and tolerates a missing, non-object or broken mcp', () => {
    expect(mcpServerNamesFromText('{ // c\n "mcp": { "a": {}, }, }')).toEqual(['a']);
    expect(mcpServerNamesFromText('{"provider": {}}')).toEqual([]);
    expect(mcpServerNamesFromText('{"mcp": ["a"]}')).toEqual([]);
    expect(mcpServerNamesFromText('{"mcp": "a"}')).toEqual([]);
    expect(mcpServerNamesFromText('')).toEqual([]);
    expect(mcpServerNamesFromText('not json {')).toEqual([]);
  });
});

describe('readMcpServerNames', () => {
  const files: Record<string, string> = {
    '/g/opencode.json': JSON.stringify({ mcp: { atlassian: { headers: { a: SECRET } }, github: {} } }),
    '/p/opencode.json': JSON.stringify({ mcp: { github: {}, linear: {} } }),
  };
  const fs = {
    existsSync: (p: string) => p in files || p === '/unreadable',
    readFileSync: (p: string): string => {
      if (!(p in files)) throw new Error('EACCES');
      return files[p]!;
    },
  };

  it('merges several files, de-duplicated, in file order; missing and unreadable files contribute nothing', () => {
    expect(readMcpServerNames(['/g/opencode.json', '/missing.json', '/unreadable', '/p/opencode.json'], fs)).toEqual(['atlassian', 'github', 'linear']);
  });
});
