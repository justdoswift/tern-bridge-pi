import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Exercise the published components under their supported runtime; no provider or clipboard access.
test('native extension dialogs round-trip literal values and fence stale requests', () => {
  const result = spawnSync('bun', ['--eval', String.raw`
    import assert from 'node:assert/strict';
    import { Composer } from '@oh-my-pi/pi-tui/prompt/composer';
    import { ensureThemeSync } from '@oh-my-pi/pi-tui/theme';
    import { PiDialogs } from './src/omp-dialogs.ts';
    ensureThemeSync();
    const composer = new Composer({ preferences: { quiet: true }, exit() {} });
    const replies = [];
    const errors = [];
    const state = {
      phase: 'question', session: { id: 'first', file: '/first.jsonl' },
      dialog: { id: 'select-1', method: 'select', title: 'Literal title', options: ['one / two', '重复  spaces', '重复  spaces'] },
    };
    const backend = { state, async resolveDialog(id, response) { replies.push({ id, response }); state.dialog = null; state.phase = 'idle'; } };
    const dialogs = new PiDialogs(composer, backend, { locale: () => 'zh-CN', onError: e => errors.push(e), onChange() {}, async openSession() {} });
    try {
      const selector = dialogs.syncPrompts();
      selector.handleInput('\x1b[B');
      selector.handleInput('\r');
      await Promise.resolve();
      assert.deepEqual(replies.shift(), { id: 'select-1', response: { value: '重复  spaces' } });
      dialogs.syncPrompts();
      state.phase = 'question';
      state.dialog = { id: 'input-2', method: 'input', title: 'Input', placeholder: 'literal hint', prefill: 'literal  input' };
      const input = dialogs.syncPrompts();
      input.handleNativeEvent({ type: 'action', key: '', act: 'submit' });
      await Promise.resolve();
      assert.deepEqual(replies.shift(), { id: 'input-2', response: { value: 'literal  input' } });
      dialogs.syncPrompts();
      state.phase = 'question';
      state.dialog = { id: 'editor-3', method: 'editor', title: 'Editor', prefill: 'line one\n  line two' };
      const editor = dialogs.syncPrompts();
      editor.handleNativeEvent({ type: 'action', key: '', act: 'submit' });
      await Promise.resolve();
      assert.deepEqual(replies.shift(), { id: 'editor-3', response: { value: 'line one\n  line two' } });
      dialogs.syncPrompts();
      state.phase = 'question';
      state.dialog = { id: 'cancel-4', method: 'input', title: 'Cancel' };
      dialogs.syncPrompts().handleNativeEvent({ type: 'action', key: '', act: 'cancel' });
      await Promise.resolve();
      assert.deepEqual(replies.shift(), { id: 'cancel-4', response: { cancelled: true } });
      dialogs.syncPrompts();
      state.phase = 'approval';
      state.dialog = { id: 'confirm', method: 'confirm', title: 'Permission', message: 'Literal confirmation detail' };
      dialogs.syncPrompts().handleNativeEvent({ type: 'action', key: '', act: 'deny' });
      await Promise.resolve();
      assert.deepEqual(replies.shift(), { id: 'confirm', response: { confirmed: false } });
      dialogs.syncPrompts();
      state.phase = 'question';
      state.dialog = { id: 'stale-5', method: 'select', title: 'Old', options: ['must not send'] };
      const stale = dialogs.syncPrompts();
      state.phase = 'stopping';
      dialogs.syncPrompts();
      stale.handleInput('\r');
      assert.equal(replies.length, 0);
      state.phase = 'question';
      state.dialog = { id: 'expired-6', method: 'input', title: 'Expired', prefill: 'must not send', deadline: Date.now() - 1 };
      dialogs.syncPrompts().handleNativeEvent({ type: 'action', key: '', act: 'submit' });
      await Promise.resolve();
      assert.equal(replies.length, 0);
      assert.equal(errors.length, 0);
    } finally { dialogs.dispose(); composer.stop(); }
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('stock transcript components reconcile streamed snapshots, edits, tools and branch changes', () => {
  const result = spawnSync('bun', ['--eval', String.raw`
    import assert from 'node:assert/strict';
    import { Composer } from '@oh-my-pi/pi-tui/prompt/composer';
    import { stopSharedSpinnerTicker } from '@oh-my-pi/pi-tui/chat/tool-execution';
    import { PiTranscript } from './src/omp-transcript.ts';
    import { PiTodoHud } from './src/omp-todos.ts';
    import { PiContextView } from './src/omp-context.ts';
    const composer = new Composer({ preferences: { quiet: true }, exit() {} });
    const transcript = new PiTranscript(composer.ui, '/nonexistent');
    const cx = { cols: 100, dark: true, reduceMotion: true, supports: () => true, feature: () => true };
    const flatten = child => {
      const node = 'k' in child ? child : child.describe ? child.describe(cx) : { k: 'rows', p: { rows: child.render(100) } };
      return [{ ...node, c: undefined }, ...(node.c ?? []).flatMap(flatten)];
    };
    const state = { phase: 'running', needsInterrupt: true, session: { id: 'first', cwd: '/nonexistent' }, messages: [
      { id: 'user', role: 'user', blocks: [{ id: 'u', kind: 'text', text: 'fixture user' }] },
      { id: 'assistant', role: 'assistant', streaming: true, blocks: [{ id: 'text', kind: 'text', text: 'partial fixture' }] },
    ] };
    try {
      transcript.sync(state);
      const user = transcript.container.children[0];
      const assistant = transcript.container.children[1];
      const assistantBody = assistant.children[0];
      state.messages[1].blocks[0].text = 'authoritative final fixture';
      state.messages[1].streaming = undefined;
      transcript.sync(state);
      assert.equal(transcript.container.children[0], user);
      assert.equal(transcript.container.children[1], assistant);
      assert.equal(assistant.children[0], assistantBody);
      let nodes = flatten(transcript.container);
      assert.ok(JSON.stringify(nodes).includes('authoritative final fixture'));
      assert.equal(JSON.stringify(nodes).includes('partial fixture'), false);
      const tool = { id: 'call', kind: 'tool', name: 'read', args: '{"path":"/nonexistent/file.ts"}', output: 'const fixture = 42;', status: 'running' };
      state.messages[1].blocks.push(tool);
      transcript.sync(state);
      const card = assistant.children[1];
      tool.status = 'done'; tool.resultReceived = true;
      tool.output = 'const fixture = 43;';
      tool.diff = '+   1|const fixture = 43;';
      transcript.sync(state);
      assert.equal(assistant.children[1], card);
      nodes = flatten(transcript.container);
      assert.ok(nodes.some(node => node.k === 'code'));
      assert.ok(nodes.some(node => node.k === 'diff'));
      assert.ok(JSON.stringify(nodes).includes('const fixture = 43;'));
      state.messages[1].blocks.push({ id: 'code', kind: 'code', text: 'const codeFixture = true;', path: 'fixture.ts' });
      transcript.sync(state);
      assert.ok(JSON.stringify(flatten(transcript.container)).includes('codeFixture'));
      const todos = new PiTodoHud();
      tool.details = { todos: [{ content: 'Confirmed task', status: 'in_progress' }] };
      todos.sync(state, 'en-US');
      assert.equal(todos.hasTasks(), true);
      tool.details = { todos: [] };
      todos.sync(state, 'en-US');
      assert.equal(todos.hasTasks(), false);
      const context = new PiContextView({ used: 250, limit: 1000, percent: 25, autoCompactionEnabled: true }, 'en-US');
      const meter = context.describe().c[0];
      assert.equal(meter.k, 'meter');
      assert.equal(meter.p.value, 0.25);
      const unavailable = new PiContextView({ used: null, limit: 1000, percent: null }, 'zh-CN');
      assert.equal(unavailable.describe().c[0].p.value, null);
      state.session = { id: 'second', cwd: '/other-nonexistent' };
      state.messages = [];
      transcript.sync(state);
      assert.equal(transcript.container.children.length, 0);
      todos.sync(state, 'en-US');
      assert.equal(todos.hasTasks(), false);
    } finally { transcript.dispose(); stopSharedSpinnerTicker(); composer.stop(); }
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
