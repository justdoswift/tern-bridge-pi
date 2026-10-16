import assert from 'node:assert/strict';
import test from 'node:test';
import { commandEntries, routeCommand } from '../src/omp-commands.js';
import type { PiCommand } from '../src/contracts.js';

const discovered: PiCommand[] = [
  { name: 'model', source: 'extension', description: 'Custom model action' },
  { name: 'skill:review', source: 'skill' }, { name: 'review-template', source: 'prompt' },
];

test('discovered commands take aliases while namespaced local actions stay reachable', () => {
  assert.deepEqual(routeCommand('/model exact args', discovered), { kind: 'remote' });
  assert.deepEqual(routeCommand('/bridge:model exact args', discovered), { kind: 'local', name: 'model', argument: 'exact args' });
  assert.deepEqual(routeCommand('/sessions', discovered), { kind: 'local', name: 'sessions', argument: undefined });
  const entries = commandEntries('en-US', discovered);
  assert.equal(entries.filter(entry => entry.name === 'model').length, 1);
  assert.ok(entries.some(entry => entry.name === 'bridge:model'));
});

test('skill and template commands route to Pi, but unknown TUI controls do not become prompts', () => {
  for (const command of ['/skill:review file.ts', '/review-template']) assert.deepEqual(routeCommand(command, discovered), { kind: 'remote' });
  for (const command of ['/settings', '/tree', '/bridge:missing']) assert.deepEqual(routeCommand(command, discovered), { kind: 'unknown' });
  assert.deepEqual(routeCommand('Review /settings behavior', discovered), { kind: 'message' });
});

test('command discovery refresh removes a colliding alias without removing the local namespace', () => {
  assert.deepEqual(routeCommand('/model', []), { kind: 'local', name: 'model', argument: undefined });
  assert.deepEqual(routeCommand('/model', discovered), { kind: 'remote' });
  assert.ok(commandEntries('zh-CN', discovered).some(entry => entry.name === 'bridge:clone'));
  assert.deepEqual(routeCommand('/bridge:rename literal  spaces\nnext line', discovered), {
    kind: 'local', name: 'rename', argument: 'literal  spaces\nnext line',
  });
});
