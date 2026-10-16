import assert from 'node:assert/strict';
import test from 'node:test';
import { toolSourceParts } from '../src/tool-source.js';

const language = (path: string): string | undefined => path.endsWith('.ts') ? 'typescript' : undefined;

test('Pi read output receives source language without rereading the filesystem', () => {
  const tool = { name: 'read', output: '  const value = 1;\n[Showing lines 1-1]', status: 'done' as const };
  assert.deepEqual(toolSourceParts(tool, { path: '/nonexistent/project/value.ts', offset: 20 }, language), [
    { kind: 'read', text: tool.output, lang: 'typescript' },
  ]);
  assert.equal(toolSourceParts({ ...tool, status: 'error' }, { path: 'value.ts' }, language), undefined);
});

test('Pi grep match/context rows retain original line numbers, indentation and notices', () => {
  const tool = { name: 'grep', status: 'done' as const, output: 'src/value.ts-9- before\nsrc/value.ts:10:   match\nsrc/value.ts-11- after\n\n[100 matches limit reached]' };
  assert.deepEqual(toolSourceParts(tool, { pattern: 'match' }, language), [
    { kind: 'matches', path: 'src/value.ts', lang: 'typescript', lines: [
      { n: 9, text: 'before', mark: false }, { n: 10, text: '  match', mark: true }, { n: 11, text: 'after', mark: false },
    ] }, { kind: 'plain', lines: ['', '[100 matches limit reached]'] },
  ]);
});

test('overlapping grep blocks stay in source order and unsupported outputs stay untouched', () => {
  const tool = { name: 'grep', status: 'done' as const, output: 'name:with:colon.ts:4: first\nname:with:colon.ts-3- earlier\nREADME:4: unknown language' };
  const parts = toolSourceParts(tool, {}, language)!;
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0], { kind: 'matches', path: 'name:with:colon.ts', lang: 'typescript', lines: [{ n: 4, text: 'first', mark: true }] });
  assert.deepEqual(parts[1], { kind: 'matches', path: 'name:with:colon.ts', lang: 'typescript', lines: [{ n: 3, text: 'earlier', mark: false }] });
  assert.equal(toolSourceParts({ name: 'bash', output: tool.output, status: 'done' }, {}, language), undefined);
  assert.equal(toolSourceParts({ ...tool, output: 'No matches found' }, {}, language), undefined);
});
