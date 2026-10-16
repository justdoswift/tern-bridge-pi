import assert from 'node:assert/strict';
import test from 'node:test';
import { activeBranch, record, Transcript, visibleBranch } from '../src/transcript.js';

const timestamp = new Date(100).toISOString();
const entry = (id: string, parentId: string | null, message: Record<string, unknown>) => ({ type: 'message', id, parentId, timestamp, message });
const usage = { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };

test('LF-shaped authoritative snapshots replace deltas, usage and tool-call argument fragments exactly once', () => {
  const transcript = new Transcript();
  const start = { role: 'assistant', content: [], timestamp: 100, model: 'actual-model', provider: 'actual-provider', stopReason: 'pending' };
  transcript.apply({ type: 'message_start', message: start });
  for (const assistantMessageEvent of [
    { type: 'thinking_start', contentIndex: 0 }, { type: 'thinking_delta', contentIndex: 0, delta: 'partial thought' },
    { type: 'thinking_end', contentIndex: 0, content: 'Authoritative thought' },
    { type: 'text_start', contentIndex: 1 }, { type: 'text_delta', contentIndex: 1, delta: 'half\u2028line\u2029' },
    { type: 'text_end', contentIndex: 1, content: 'Complete block' },
    { type: 'toolcall_start', contentIndex: 2, id: 'call-a', toolName: 'edit' },
    { type: 'toolcall_delta', contentIndex: 2, delta: '{"path":' },
    { type: 'toolcall_end', contentIndex: 2, toolCall: { id: 'call-a', name: 'edit', arguments: { path: 'source.ts', oldText: 'a', newText: 'b' } } },
  ]) transcript.apply({ type: 'message_update', assistantMessageEvent, usage });
  assert.equal(transcript.messages[0]?.streaming, false);
  assert.equal(transcript.messages[0]?.blocks[0]?.kind === 'thinking' && transcript.messages[0].blocks[0].text, 'Authoritative thought');
  assert.deepEqual(transcript.messages[0]?.usage, usage);
  transcript.apply({ type: 'tool_execution_start', toolCallId: 'call-a', toolName: 'edit', args: { path: 'source.ts', oldText: 'a', newText: 'b' } });
  transcript.apply({ type: 'tool_execution_update', toolCallId: 'call-a', partialResult: { content: [{ type: 'text', text: 'partial' }] } });
  transcript.apply({ type: 'tool_execution_update', toolCallId: 'call-a', partialResult: { content: [{ type: 'text', text: 'replacement partial' }] } });
  transcript.apply({ type: 'tool_execution_end', toolCallId: 'call-a', result: { content: [{ type: 'text', text: 'complete result' }, { type: 'image', data: 'YQ==', mimeType: 'image/png' }], details: { diff: '-a\n+b', actual: true } }, isError: false });
  const final = { ...start, stopReason: 'toolUse', usage, content: [
    { type: 'thinking', thinking: 'Final thought' }, { type: 'text', text: 'Final message text' },
    { type: 'toolCall', id: 'call-a', name: 'edit', arguments: { path: 'source.ts', oldText: 'a', newText: 'b' } },
  ] };
  transcript.apply({ type: 'message_end', message: final });
  transcript.apply({ type: 'message_end', message: final });
  transcript.apply({ type: 'tool_execution_update', toolCallId: 'call-a', partialResult: { content: [{ type: 'text', text: 'late obsolete partial' }] } });
  assert.equal(transcript.messages.length, 1);
  assert.equal(transcript.messages[0]?.streaming, undefined);
  const tool = transcript.messages[0]?.blocks.find(block => block.kind === 'tool');
  assert.equal(tool?.kind === 'tool' && tool.output, 'complete result');
  assert.equal(tool?.kind === 'tool' && tool.status, 'done');
  assert.equal(tool?.kind === 'tool' && tool.diff, '-a\n+b');
  assert.equal(transcript.messages[0]?.blocks.filter(block => block.kind === 'image').length, 1);
  assert.equal(transcript.messages[0]?.model, 'actual-model');
  assert.equal(transcript.messages[0]?.provider, 'actual-provider');
  assert.equal(transcript.messages[0]?.usage?.totalTokens, 13);
});

test('restored transcript follows current leaf, hides private/control records and preserves raw authored context-edit targets', () => {
  const entries = [
    entry('private', null, { role: 'system', content: 'PRIVATE SYSTEM', sections: { preamble: 'PRIVATE' }, toolsAdded: [{ name: 'secret-tool' }], timestamp: 1 }),
    entry('user', 'private', { role: 'user', content: [{ type: 'text', text: 'Original prose' }, { type: 'image', data: 'YQ==', mimeType: 'image/png' }], timestamp: 2 }),
    entry('assistant', 'user', { role: 'assistant', timestamp: 3, model: 'm', provider: 'p', usage, content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'actual' } }] }),
    entry('abandoned', 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'Abandoned prose' }], timestamp: 4 }),
    entry('tool', 'assistant', { role: 'toolResult', toolCallId: 'call', toolName: 'bash', content: [{ type: 'text', text: 'Real output' }], isError: false, timestamp: 5 }),
    { type: 'context_edit', id: 'edit', parentId: 'tool', timestamp, targetId: 'user', replacement: 'Model-only replacement' },
    { type: 'custom_message', id: 'hidden', parentId: 'edit', timestamp, customType: 'hidden', content: 'HIDDEN EXTENSION DATA', display: false },
    { type: 'custom', id: 'control', parentId: 'hidden', timestamp, customType: 'state', data: { private: 'DO NOT DUMP' } },
    { type: 'custom_message', id: 'visible', parentId: 'control', timestamp, customType: 'notice', content: 'Visible extension prose', display: true },
  ];
  const transcript = new Transcript();
  transcript.hydrate(entries, 'visible', [{ role: 'user', content: 'Model-only replacement', timestamp: 2 }]);
  assert.deepEqual(transcript.messages.map(message => message.id), ['user', 'assistant', 'visible']);
  const text = JSON.stringify(transcript.messages);
  assert.equal(text.includes('Original prose'), true);
  for (const hidden of ['PRIVATE', 'Abandoned prose', 'Model-only replacement', 'HIDDEN EXTENSION DATA', 'DO NOT DUMP']) assert.equal(text.includes(hidden), false);
  assert.equal(transcript.messages[0]?.blocks[1]?.kind, 'image');
  const tool = transcript.messages[1]?.blocks[0];
  assert.equal(tool?.kind === 'tool' && tool.output, 'Real output');
  assert.equal(tool?.kind === 'tool' && tool.status, 'done');
  assert.ok(transcript.messages.every(message => message.streaming === undefined));
  assert.deepEqual(transcript.messages[1]?.usage, usage);
  assert.equal(transcript.messages[0]?.usage, undefined);
});

test('native compaction boundary retains only the selected range and does not resurrect summarized or abandoned history', () => {
  const entries = [
    entry('old-user', null, { role: 'user', content: 'Summarized away', timestamp: 1 }),
    entry('keep', 'old-user', { role: 'user', content: 'Retained raw prose', timestamp: 2 }),
    entry('private', 'keep', { role: 'system', content: 'Retained private loadout', timestamp: 3 }),
    entry('answer', 'private', { role: 'assistant', content: [{ type: 'text', text: 'Retained answer' }], timestamp: 4 }),
    { type: 'compaction', id: 'compact', parentId: 'answer', timestamp, firstKeptEntryId: 'keep', summary: 'Actual compaction summary' },
    entry('other-branch', 'old-user', { role: 'user', content: 'Other branch', timestamp: 5 }),
    entry('after', 'compact', { role: 'user', content: 'After compaction', timestamp: 6 }),
  ];
  assert.deepEqual(visibleBranch(entries, 'after').map(value => value.id), ['compact', 'keep', 'answer', 'after']);
  const transcript = new Transcript();
  transcript.hydrate(entries, 'after');
  assert.deepEqual(transcript.messages.map(message => message.id), ['compact', 'keep', 'answer', 'after']);
  assert.equal(JSON.stringify(transcript.messages).includes('Summarized away'), false);
  assert.equal(JSON.stringify(transcript.messages).includes('Other branch'), false);
  const retainNone = [...entries, { type: 'compaction', id: 'none', parentId: 'after', timestamp, firstKeptEntryId: 'none', summary: 'Retain none' }];
  transcript.hydrate(retainNone, 'none');
  assert.deepEqual(transcript.messages.map(message => message.id), ['none']);
});

test('bootstrap replay fences persisted snapshots while retaining new unpersisted deltas and interrupted tool state', () => {
  const transcript = new Transcript();
  const saved = { role: 'assistant', content: [{ type: 'text', text: 'Saved final' }], timestamp: 10 };
  transcript.hydrate([entry('saved', null, saved)], 'saved');
  transcript.replay([
    { type: 'message_start', message: { ...saved, content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'must not append' } },
    { type: 'message_end', message: saved },
    { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 11 } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Live delta' } },
    { type: 'tool_execution_start', toolCallId: 'running', toolName: 'bash', args: { command: 'actual' } },
    { type: 'agent_settled', aborted: true },
  ]);
  assert.equal(transcript.messages[0]?.blocks[0]?.kind === 'text' && transcript.messages[0].blocks[0].text, 'Saved final');
  assert.equal(transcript.messages[1]?.blocks[0]?.kind === 'text' && transcript.messages[1].blocks[0].text, 'Live delta');
  const tool = transcript.messages[2]?.blocks[0];
  assert.equal(tool?.kind === 'tool' && tool.status, 'interrupted');
  assert.equal(tool?.kind === 'tool' && tool.resultReceived, undefined);
});

test('broken branches fail visibly rather than exposing append-order history', () => {
  assert.throws(() => activeBranch([{ id: 'a', parentId: 'missing' }], 'a'), /incomplete/);
  assert.throws(() => activeBranch([{ id: 'a', parentId: 'a' }], 'a'), /cyclic/);
  assert.deepEqual(activeBranch([], null), []);
  assert.deepEqual(record(null), {}); assert.deepEqual(record([]), {});
});
