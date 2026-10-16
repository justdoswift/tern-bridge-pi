import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendState, MessageBlock } from '../src/contracts.js';
import { PiWorkTracker, isPiWorking } from '../src/work-state.js';

function state(): BackendState {
  return {
    phase: 'idle', needsInterrupt: false, workingState: null,
    session: { id: 'first', title: 'Work', cwd: '/project', settings: { modelId: 'selected', reasoningEffort: 'high', thinkingLevels: ['off', 'high'] } },
    messages: [], models: [], commands: [], dialog: null, widgets: [], statuses: [], editorText: null, windowTitle: null,
    error: null, notice: null, context: null, usage: null,
  };
}

test('waits, idle, errors and disconnected states hide activity without reusing historical timing', () => {
  const data = state();
  const tracker = new PiWorkTracker();
  assert.deepEqual(tracker.sync(data, 1), { active: false });
  data.phase = 'running';
  assert.deepEqual(tracker.sync(data, 100), { active: true, startedAt: 100, stage: 'response' });
  data.phase = 'question';
  assert.equal(isPiWorking(data), false);
  assert.deepEqual(tracker.sync(data, 200), { active: false });
  data.phase = 'running';
  assert.deepEqual(tracker.sync(data, 300), { active: true, startedAt: 100, stage: 'response' });
  for (const phase of ['error', 'disconnected', 'idle'] as const) {
    data.phase = phase; data.needsInterrupt = true;
    assert.equal(isPiWorking(data), false);
    assert.deepEqual(tracker.sync(data, 400), { active: false });
  }
  data.phase = 'running';
  assert.deepEqual(tracker.sync(data, 500), { active: true, startedAt: 500, stage: 'response' });
  data.session = { ...data.session!, id: 'next' };
  assert.deepEqual(tracker.sync(data, 600), { active: true, startedAt: 600, stage: 'response' });
});

test('real tool intent yields to settled reply, retry and compaction without exposing output or reasoning', () => {
  const data = state(); data.phase = 'running';
  const tool: Extract<MessageBlock, { kind: 'tool' }> = { id: 'tool', kind: 'tool', name: 'bash', args: '{"command":"pwd"}', output: 'private output', status: 'running' };
  const message = { id: 'a', role: 'assistant' as const, blocks: [tool] as MessageBlock[], streaming: true };
  data.messages = [message];
  const tracker = new PiWorkTracker();
  assert.deepEqual(tracker.sync(data, 100), { active: true, startedAt: 100, stage: 'tool', step: 'bash · pwd' });
  tool.args = '{partial';
  assert.deepEqual(tracker.sync(data, 110), { active: true, startedAt: 100, stage: 'tool', step: 'bash' });
  tool.status = 'done'; tool.resultReceived = true;
  message.blocks.push({ id: 'reply', kind: 'text', text: '\nObserved reply\nSecond line' });
  assert.deepEqual(tracker.sync(data, 120), { active: true, startedAt: 100, stage: 'response', step: 'Observed reply' });
  message.blocks.push({ id: 'thought', kind: 'thinking', text: 'Never a status title' });
  assert.deepEqual(tracker.sync(data, 130), { active: true, startedAt: 100, stage: 'thinking' });
  data.workingState = 'retrying';
  assert.deepEqual(tracker.sync(data, 140), { active: true, startedAt: 100, stage: 'retry' });
  data.workingState = 'compacting_conversation';
  assert.deepEqual(tracker.sync(data, 150), { active: true, startedAt: 100, stage: 'compaction' });
  data.phase = 'stopping';
  assert.deepEqual(tracker.sync(data, 160), { active: true, startedAt: 100, stage: 'stopping' });
});

test('restored reasoning and completed replies are not live work labels', () => {
  const data = state();
  data.messages = [{ id: 'restored', role: 'assistant', blocks: [{ id: 'thought', kind: 'thinking', text: 'Historical reasoning' }] }];
  const tracker = new PiWorkTracker();
  assert.deepEqual(tracker.sync(data, 1), { active: false });
  data.phase = 'running';
  assert.deepEqual(tracker.sync(data, 2), { active: true, startedAt: 2, stage: 'response' });
});
