import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, MessageBlock } from '../src/contracts.js';
import { latestPiTodo, parsePiTodos } from '../src/pi-todos.js';

test('only structured result arrays with explicit statuses become todos', () => {
  const tasks = [{ content: 'Keep literal\ncontent', status: 'in_progress' }, { content: 'Complete', status: 'completed' }];
  assert.deepEqual(parsePiTodos({ todos: tasks }), tasks);
  for (const value of [undefined, '1. [completed] Guess', { todos: 'prose' }, { todos: [{ content: 'A', status: 'done' }] }, { todos: [{ content: ' ', status: 'pending' }] }, { todos: [{ content: 'A' }] }]) {
    assert.equal(parsePiTodos(value), undefined);
  }
  assert.deepEqual(parsePiTodos({ todos: [] }), []);
});

test('failed, running and unconfirmed results cannot replace confirmed extension tasks', () => {
  const confirmed: Extract<MessageBlock, { kind: 'tool' }> = {
    id: 'confirmed', kind: 'tool', name: 'my_task_extension', args: '{}', output: 'Saved', status: 'done', resultReceived: true,
    details: { todos: [{ content: 'Actual task', status: 'pending' }] },
  };
  const messages: ChatMessage[] = [{ id: 'a', role: 'assistant', blocks: [confirmed] }];
  for (const patch of [{ status: 'running' as const }, { status: 'error' as const }, { resultReceived: undefined }, { details: undefined }]) {
    messages.push({ id: `next-${messages.length}`, role: 'assistant', blocks: [{ ...confirmed, id: `candidate-${messages.length}`, ...patch }] });
    assert.equal(latestPiTodo(messages), confirmed);
  }
  const clear = { ...confirmed, id: 'clear', details: { todos: [] } };
  messages.push({ id: 'clear', role: 'assistant', blocks: [clear] });
  assert.equal(latestPiTodo(messages), clear);
});

test('tool intent and widget-like prose do not fabricate a task database', () => {
  const messages: ChatMessage[] = [{ id: 'a', role: 'assistant', blocks: [
    { id: 'text', kind: 'text', text: '[x] Write tests' },
    { id: 'tool', kind: 'tool', name: 'TodoWrite', args: '{"todos":[{"content":"Guess","status":"completed"}]}', output: '[x] Guess', status: 'done', resultReceived: true },
  ] }];
  assert.equal(latestPiTodo(messages), undefined);
});
