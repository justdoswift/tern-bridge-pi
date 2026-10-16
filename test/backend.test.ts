import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { peerHarness, until } from './pi-peer.js';

const dialog = (id: string, method: string, extra: Record<string, unknown> = {}) => ({ type: 'extension_ui_request', id, method, title: 'Literal 标题', ...extra });

test('real subprocess metadata, opaque models, active history, and honest context aggregate', async () => {
  const peer = await peerHarness();
  try {
    await peer.bridge.open(peer.sessionPath);
    assert.equal(peer.bridge.state.session?.id, 'original');
    assert.equal(peer.bridge.state.session?.cwd, peer.cwd);
    assert.equal(peer.bridge.state.session?.file, peer.sessionPath);
    assert.deepEqual(peer.bridge.state.messages.map(message => message.id), ['user-one', 'assistant-one']);
    assert.equal(JSON.stringify(peer.bridge.state.messages).includes('PRIVATE'), false);
    assert.equal(peer.bridge.state.messages[1]?.usage, undefined);
    assert.equal(peer.bridge.state.models[0]?.id, JSON.stringify(['provider/one', 'model/one']));
    assert.deepEqual(peer.bridge.state.commands.map(command => command.name), ['settings', 'skill:review', 'draft']);
    assert.equal((await peer.bridge.contextDetails()).used, 400);
    assert.equal(peer.bridge.state.usage?.totalTokens, 300032);
    assert.deepEqual(peer.bridge.state.context, { used: 400, limit: 200000 });
    const textModel = peer.bridge.state.models.find(model => model.modelId === 'plain')!;
    await peer.bridge.updateSettings({ modelId: textModel.id, reasoningEffort: 'off' });
    assert.equal(peer.bridge.state.session?.settings.modelId, textModel.id);
    assert.deepEqual(peer.bridge.state.session?.settings.thinkingLevels, ['off']);
    await assert.rejects(peer.bridge.updateSettings({ reasoningEffort: 'high' }), /not available/);
    let accepted = 0;
    await assert.rejects(peer.bridge.send('', () => accepted++, [{ data: 'YQ==', mimeType: 'image/png' }]), /does not support image attachments/);
    assert.equal(accepted, 0);
    const commands = await peer.commands();
    const setModel = commands.find(command => command.type === 'set_model');
    assert.equal(setModel?.provider, 'provider-two'); assert.equal(setModel?.modelId, 'plain');
    assert.equal(commands.some(command => command.type === 'prompt'), false);
  } finally { await peer.dispose(); }
});

test('prompt acceptance is separate from settled, including completion before the response', async () => {
  const peer = await peerHarness();
  try {
    await peer.bridge.open(peer.sessionPath);
    let accepted = 0;
    await peer.bridge.send('fast', () => accepted++);
    await until(() => peer.bridge.state.phase === 'idle');
    assert.equal(accepted, 1);
    const replies = peer.bridge.state.messages.filter(message => message.blocks.some(block => block.kind === 'text' && block.text === 'Final authoritative reply'));
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.streaming, undefined);
    await peer.bridge.send('/handled', () => accepted++);
    assert.equal(peer.bridge.state.phase, 'idle');
    assert.equal(accepted, 2);
    await peer.bridge.send('hold', () => accepted++);
    await until(() => peer.bridge.state.workingState === 'retrying');
    assert.equal(accepted, 3);
    assert.equal(peer.bridge.state.phase, 'running');
    assert.equal(peer.bridge.state.needsInterrupt, true);
    assert.equal(peer.bridge.state.workingState, 'retrying');
    await assert.rejects(peer.bridge.send('must not become a client queue', () => accepted++), /busy/);
    await peer.emit([{ type: 'agent_end', messages: [], willRetry: false }, dialog('end-barrier', 'setStatus', { statusKey: 'end-barrier', statusText: 'processed' })]);
    await until(() => peer.bridge.state.statuses.some(status => status.key === 'end-barrier'));
    assert.equal(peer.bridge.state.phase, 'running');
    await peer.emit([{ type: 'agent_settled', aborted: false }]);
    await until(() => peer.bridge.state.phase === 'idle');
    assert.equal(peer.bridge.state.needsInterrupt, false);
  } finally { await peer.dispose(); }
});

test('rejection preserves acceptance callback and never leaks private Pi errors', async () => {
  const peer = await peerHarness();
  try {
    await peer.bridge.open(peer.sessionPath);
    let accepted = 0;
    await assert.rejects(peer.bridge.send('reject', () => accepted++), /Pi rejected prompt/);
    assert.equal(accepted, 0);
    assert.equal(peer.bridge.state.error?.includes('synthetic-private'), false);
    assert.equal(peer.bridge.state.session?.id, 'original');
    assert.equal(peer.bridge.state.needsInterrupt, false);
    await peer.bridge.send('/handled', () => accepted++);
    assert.equal(accepted, 1);
  } finally { await peer.dispose(); }
});

test('Stop clears Pi queues before abort and restores only Pi-returned queued text', async () => {
  const peer = await peerHarness();
  try {
    await peer.bridge.open(peer.sessionPath);
    await peer.bridge.send('queued', () => {});
    assert.equal(peer.bridge.state.phase, 'running');
    await peer.bridge.interrupt();
    const commands = (await peer.commands()).map(command => command.type);
    assert.ok(commands.indexOf('clear_queue') < commands.indexOf('abort'));
    assert.equal(peer.bridge.state.editorText?.text, 'Synthetic queued text');
    assert.equal(peer.bridge.state.phase, 'idle');
    assert.equal(peer.bridge.state.needsInterrupt, false);
  } finally { await peer.dispose(); }
});

test('Stop fences late prompt preflight acceptance instead of clearing or replaying its draft', async () => {
  const peer = await peerHarness();
  try {
    await peer.bridge.open(peer.sessionPath);
    let accepted = 0;
    const send = peer.bridge.send('late', () => accepted++);
    await until(async () => (await peer.commands()).some(command => command.type === 'prompt'));
    await peer.bridge.interrupt();
    await send;
    assert.equal(accepted, 0);
    assert.equal(peer.bridge.state.phase, 'idle');
    const commands = (await peer.commands()).filter(command => command.type === 'clear_queue' || command.type === 'abort').map(command => command.type);
    assert.deepEqual(commands, ['clear_queue', 'abort', 'clear_queue', 'abort']);
  } finally { await peer.dispose(); }
});

test('extension dialogs are FIFO, literal, validated, timed out, and cancelled by Stop', async t => {
  const peer = await peerHarness();
  try {
    await peer.bridge.open(peer.sessionPath);
    await peer.emit([dialog('select', 'select', { options: ['Allow 允许', 'Block 禁止'] }), dialog('confirm', 'confirm', { message: 'Literal message' }), dialog('editor', 'editor', { prefill: 'Line one\nLine two' })]);
    await until(() => peer.bridge.state.dialog?.id === 'select');
    assert.equal(peer.bridge.state.phase, 'question');
    assert.equal(peer.bridge.state.workingState, null);
    assert.deepEqual(peer.bridge.state.dialog?.options, ['Allow 允许', 'Block 禁止']);
    await assert.rejects(peer.bridge.resolveDialog('confirm', { confirmed: true }), /no longer active/);
    await assert.rejects(peer.bridge.resolveDialog('select', { value: 'Allow' }), /exact Pi options/);
    await peer.bridge.resolveDialog('select', { value: 'Block 禁止' });
    await until(() => peer.bridge.state.dialog?.id === 'confirm');
    assert.equal(peer.bridge.state.dialog?.id, 'confirm');
    await peer.bridge.resolveDialog('confirm', { cancelled: true });
    await until(() => peer.bridge.state.dialog?.id === 'editor');
    assert.equal(peer.bridge.state.dialog?.prefill, 'Line one\nLine two');
    await peer.bridge.interrupt();
    assert.equal(peer.bridge.state.dialog, null);
    const responses = (await peer.commands()).filter(command => command.type === 'extension_ui_response');
    assert.deepEqual(responses.map(response => ({ id: response.id, value: response.value, confirmed: response.confirmed, cancelled: response.cancelled })), [
      { id: 'select', value: 'Block 禁止', confirmed: undefined, cancelled: undefined },
      { id: 'confirm', value: undefined, confirmed: undefined, cancelled: true },
      { id: 'editor', value: undefined, confirmed: undefined, cancelled: true },
    ]);
    // Only bridge-owned deadlines use fake time; the public-protocol process continues to use real IPC.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await peer.emit([dialog('expires', 'input', { timeout: 1000, placeholder: 'Literal hint' })]);
    await until(() => peer.bridge.state.dialog?.id === 'expires');
    t.mock.timers.tick(1000);
    assert.equal(peer.bridge.state.dialog, null);
    await assert.rejects(peer.bridge.resolveDialog('expires', { value: 'late' }), /no longer active/);
    assert.equal((await peer.commands()).some(command => command.type === 'extension_ui_response' && command.id === 'expires'), false);
  } finally { t.mock.timers.reset(); await peer.dispose(); }
});

test('extension fire-and-forget state is real and foreign tagged scopes are ignored', async () => {
  const peer = await peerHarness();
  try {
    await peer.bridge.open(peer.sessionPath);
    await peer.emit([
      dialog('status', 'setStatus', { statusKey: 'lint', statusText: 'Literal status' }),
      dialog('widget', 'setWidget', { widgetKey: 'notes', widgetLines: ['one', '二'], widgetPlacement: 'belowEditor' }),
      dialog('title', 'setTitle', { title: 'Actual extension title' }),
      dialog('editor', 'set_editor_text', { text: 'Actual extension draft' }),
      { ...dialog('foreign', 'set_editor_text', { text: 'must not replace draft' }), sessionId: 'other-session' },
      { type: 'message_start', sessionId: 'other-session', message: { role: 'user', content: 'foreign prose', timestamp: 999 } },
    ]);
    await until(() => peer.bridge.state.editorText?.id === 'editor');
    assert.deepEqual(peer.bridge.state.statuses, [{ key: 'lint', text: 'Literal status' }]);
    assert.deepEqual(peer.bridge.state.widgets, [{ key: 'notes', lines: ['one', '二'], placement: 'belowEditor' }]);
    assert.equal(peer.bridge.state.windowTitle, 'Actual extension title');
    assert.equal(peer.bridge.state.editorText?.text, 'Actual extension draft');
    assert.equal(JSON.stringify(peer.bridge.state.messages).includes('foreign prose'), false);
    await peer.emit([dialog('clear-status', 'setStatus', { statusKey: 'lint' }), dialog('clear-widget', 'setWidget', { widgetKey: 'notes' })]);
    await until(() => peer.bridge.state.statuses.length === 0 && peer.bridge.state.widgets.length === 0);
  } finally { await peer.dispose(); }
});

test('cancelled session mutations keep selection; confirmed switch adopts cwd/file and fresh scoped state', async () => {
  const peer = await peerHarness();
  try {
    await peer.bridge.open(peer.sessionPath);
    const cancelledPath = await peer.session('cancelled', peer.otherCwd, true);
    await peer.bridge.open(cancelledPath);
    assert.equal(peer.bridge.state.session?.id, 'original');
    assert.equal(peer.bridge.state.session?.file, peer.sessionPath);
    assert.equal(peer.bridge.state.session?.cwd, peer.cwd);
    await peer.bridge.send('/cancel', () => {});
    await peer.bridge.clone();
    assert.equal(peer.bridge.state.session?.id, 'original');
    const nextPath = await peer.session('next', peer.otherCwd);
    await peer.bridge.open(nextPath);
    assert.equal(peer.bridge.state.session?.id, 'next');
    assert.equal(peer.bridge.state.session?.file, nextPath);
    assert.equal(peer.bridge.state.session?.cwd, peer.otherCwd);
    assert.deepEqual(peer.bridge.state.widgets, [{ key: 'project', lines: [peer.otherCwd], placement: 'aboveEditor' }]);
    assert.equal(peer.bridge.state.editorText, null);
    await assert.rejects(peer.bridge.resolveDialog('previous-session-dialog', { confirmed: true }), /no longer active/);
    // A cancelled target lock must have been released; a subsequent open is not blocked by this bridge itself.
    await peer.bridge.open(cancelledPath);
    assert.equal(peer.bridge.state.session?.id, 'next');
  } finally { await peer.dispose(); }
});

test('rename, clone, user-message fork and compaction are actual Pi commands with authoritative reloads', async () => {
  const peer = await peerHarness();
  try {
    await peer.bridge.open(peer.sessionPath);
    await peer.bridge.rename('Literal 标题');
    assert.equal(peer.bridge.state.session?.title, 'Literal 标题');
    assert.equal((await readFile(peer.sessionPath, 'utf8')).includes('Literal 标题'), true);
    const choices = await peer.bridge.forkMessages();
    assert.deepEqual(choices, [{ entryId: 'user-one', text: 'Original user prose' }]);
    await assert.rejects(peer.bridge.fork('assistant-one'), /active Pi branch/);
    await peer.bridge.clone();
    const cloned = peer.bridge.state.session?.id;
    assert.notEqual(cloned, 'original');
    assert.equal(peer.bridge.state.messages.length, 2);
    await peer.bridge.fork('user-one');
    assert.notEqual(peer.bridge.state.session?.id, cloned);
    assert.equal(peer.bridge.state.messages.length, 0);
    assert.equal(peer.bridge.state.editorText?.text, 'Original user prose');
    await peer.bridge.open(peer.sessionPath);
    await peer.bridge.compact('Preserve exact synthetic facts');
    assert.deepEqual(peer.bridge.state.messages.map(message => message.blocks[0]?.kind === 'text' ? message.blocks[0].text : ''), ['Synthetic summary']);
    const details = await peer.bridge.contextDetails();
    assert.equal(details.used, null); assert.equal(details.percent, null); assert.equal(details.limit, 200000);
    assert.equal(peer.bridge.state.context, null);
    assert.equal((await peer.commands()).find(command => command.type === 'compact')?.customInstructions, 'Preserve exact synthetic facts');
  } finally { await peer.dispose(); }
});

test('unexpected process exit keeps selection visible and supports an explicit reconnect without replay', async () => {
  const peer = await peerHarness();
  try {
    await peer.bridge.open(peer.sessionPath);
    await peer.emit([{ type: 'test_exit' }]);
    await until(() => peer.bridge.state.phase === 'error');
    assert.equal(peer.bridge.state.session?.id, 'original');
    assert.equal(peer.bridge.state.session?.file, peer.sessionPath);
    assert.equal(peer.bridge.state.needsInterrupt, false);
    assert.equal(peer.bridge.state.error?.includes('PRIVATE'), false);
    await peer.emit([]);
    await peer.bridge.open(peer.sessionPath);
    assert.equal(peer.bridge.state.phase, 'idle');
    assert.equal((await peer.commands()).some(command => command.type === 'prompt'), false);
  } finally { await peer.dispose(); }
});

test('closing fences pending acceptance and late metadata instead of mutating a closed scope', async () => {
  const peer = await peerHarness();
  try {
    await peer.bridge.open(peer.sessionPath);
    let accepted = 0;
    const pending = peer.bridge.send('late', () => accepted++);
    const rejected = assert.rejects(pending, /closed/);
    await until(async () => (await peer.commands()).some(command => command.type === 'prompt'));
    await peer.bridge.close();
    await rejected;
    assert.equal(accepted, 0);
    assert.equal(peer.bridge.state.phase, 'disconnected');
    assert.equal(peer.bridge.state.needsInterrupt, false);
    await peer.bridge.open(peer.sessionPath);
    assert.equal(peer.bridge.state.phase, 'idle');
    assert.equal(accepted, 0);
  } finally { await peer.dispose(); }
});
