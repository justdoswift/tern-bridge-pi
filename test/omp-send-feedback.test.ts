import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('native sends clear immediately, reconcile Pi receipts and recover unconfirmed drafts without losing edits', () => {
  const result = spawnSync('bun', ['--eval', String.raw`
    import assert from 'node:assert/strict';
    import { Composer } from '@oh-my-pi/pi-tui/prompt/composer';
    import { ensureThemeSync } from '@oh-my-pi/pi-tui/theme';
    import { PiBridge } from './src/backend.ts';
    import { PiImageComposer } from './src/omp-images.ts';
    import { PiSendFeedback } from './src/omp-send-feedback.ts';
    import { PiTranscript } from './src/omp-transcript.ts';
    import { peerHarness, until } from './test/pi-peer.ts';
    ensureThemeSync();
    const peer = await peerHarness();
    const composer = new Composer({ preferences: { quiet: true }, exit() {} });
    const editor = composer.editor;
    editor.disableSubmit = false;
    const recovered = [];
    let submission;
    const backend = new PiBridge({ cwd: peer.cwd, dataDir: peer.root + '/feedback-data', execPath: peer.executable,
      sessionDir: peer.sessionDir, onChange() {}, onUserMessage() { feedback.recorded(); } });
    const images = new PiImageComposer(editor, {
      locale: () => 'en-US', currentSession: () => backend.state.session?.id ?? null, cwd: () => peer.cwd,
      onChange() {}, onError(error) { throw error; }, onSubmit(value) { submission = value; },
    });
    const feedback = new PiSendFeedback(backend, images, {
      locale: () => 'en-US', onChange() {}, onRecovery(restored) { recovered.push(restored); },
    });
    const transcript = new PiTranscript(composer.ui, peer.cwd);
    const cx = { cols: 100, dark: true, reduceMotion: true, supports: () => true, feature: () => true };
    const flatten = child => {
      const node = 'k' in child ? child : child.describe ? child.describe(cx) : { k: 'rows', p: { rows: child.render(100) } };
      return [{ ...node, c: undefined }, ...(node.c ?? []).flatMap(flatten)];
    };
    const view = () => { transcript.sync(backend.state, feedback.sync()); return flatten(transcript.container); };
    const begin = async (message = 'delayed') => {
      const count = (await peer.commands()).filter(c => c.type === 'prompt').length;
      editor.setText(message);
      editor.submit();
      const sent = feedback.send(submission);
      // Check before any RPC acknowledgement or rendering tick can run.
      assert.equal(editor.getText(), '');
      assert.ok(feedback.sync());
      assert.ok(JSON.stringify(view()).includes(message));
      await until(async () => (await peer.commands()).filter(c => c.type === 'prompt').length === count + 1);
      return { sent };
    };
    const settle = async () => {
      await peer.emit([{ type: 'agent_settled' }]);
      await until(() => !backend.state.needsInterrupt);
      assert.equal(feedback.sync(), undefined);
    };
    try {
      await backend.open();
      // Live receipt before acknowledgement: no duplicate bubble and no late draft clearing.
      const early = await begin();
      assert.equal(backend.state.messages.length, 0);
      editor.setText('next draft');
      await peer.emit([{ type: 'test_prompt_user', text: 'extension transformed input' }]);
      await until(() => backend.state.messages.some(m => m.role === 'user'));
      assert.equal(feedback.sync(), undefined);
      view();
      assert.equal(transcript.container.children.length, 1);
      assert.ok(JSON.stringify(view()).includes('extension transformed input'));
      assert.equal(JSON.stringify(view()).includes('delayed'), false);
      await peer.emit([{ type: 'test_prompt_ack' }]);
      await early.sent;
      assert.equal(editor.getText(), 'next draft');
      await settle();

      // Acknowledgement before receipt stays visible until the real message arrives.
      const later = await begin();
      const previous = backend.state.messages.length;
      await peer.emit([
        { type: 'extension_ui_request', id: 'preflight-status', method: 'setStatus', statusKey: 'preflight', statusText: 'Ready' },
        { type: 'test_prompt_ack' },
      ]);
      await later.sent;
      assert.ok(feedback.sync());
      assert.equal(backend.state.needsInterrupt, true);
      assert.equal(backend.state.messages.length, previous);
      await peer.emit([{ type: 'test_prompt_user' }]);
      await until(() => backend.state.messages.length > previous);
      assert.equal(feedback.sync(), undefined);
      view();
      assert.equal(transcript.container.children.length, backend.state.messages.length);
      await settle();

      // A locally handled extension command must not invent a persistent user message.
      editor.setText('/handled'); editor.submit();
      await feedback.send(submission);
      assert.equal(feedback.sync(), undefined);
      assert.equal(backend.state.messages.length, previous + 1);

      const rejected = await begin();
      const rejection = assert.rejects(rejected.sent);
      await peer.emit([{ type: 'test_prompt_ack', success: false }]);
      await rejection;
      assert.equal(editor.getText(), 'delayed');
      assert.equal(recovered.pop(), true);
      assert.equal(feedback.sync(), undefined);
      await backend.open(backend.state.session.file);

      const edited = await begin();
      editor.setText('newer draft');
      const editedRejection = assert.rejects(edited.sent);
      await peer.emit([{ type: 'test_prompt_ack', success: false }]);
      await editedRejection;
      assert.equal(editor.getText(), 'newer draft');
      assert.equal(recovered.pop(), false);
      editor.clearDraft();
      editor.handleInput('\x1b[A');
      assert.equal(editor.getText(), 'delayed');
      await backend.open(backend.state.session.file);

      // Stop during asynchronous input preflight: late acceptance cannot swallow the draft.
      const stopped = await begin('late');
      await backend.interrupt();
      await stopped.sent;
      assert.equal(editor.getText(), 'late');
      assert.equal(recovered.pop(), true);
      assert.equal(feedback.sync(), undefined);
      assert.equal((await peer.commands()).filter(c => c.type === 'prompt' && c.message === 'late').length, 1);

      // The pending command is replaced by one compact canonical skill, never its full body.
      editor.setText('/skill:review Check synthetic arguments'); editor.submit();
      const skillSend = feedback.send(submission);
      assert.equal(editor.getText(), '');
      assert.ok(feedback.sync());
      editor.setText('draft after skill');
      await skillSend;
      await until(() => !backend.state.needsInterrupt);
      assert.equal(editor.getText(), 'draft after skill');
      assert.equal(feedback.sync(), undefined);
      const skillNodes = view();
      assert.equal(skillNodes.filter(n => n.p?.role === 'omp.skill').length, 1);
      assert.ok(JSON.stringify(skillNodes).includes('Check synthetic arguments'));
      assert.equal(JSON.stringify(skillNodes).includes('SYNTHETIC_SKILL_BODY_SENTINEL'), false);
      assert.equal(transcript.container.children.length, backend.state.messages.length);

      // A live receipt is authoritative even if transport dies before the prompt response.
      const interrupted = await begin();
      const interruptedResult = assert.rejects(interrupted.sent);
      await peer.emit([{ type: 'test_prompt_user' }, { type: 'test_exit' }]);
      await interruptedResult;
      assert.equal(editor.getText(), '');
      assert.equal(recovered.length, 0);
      assert.equal(feedback.sync(), undefined);
      await peer.emit([]);
      await backend.open(backend.state.session.file);

      // Shutdown cannot restore a delayed submission into a closed/new composer.
      const closing = await begin();
      const closed = closing.sent.catch(() => {});
      feedback.reset(); images.dispose();
      await backend.close();
      await closed;
      assert.equal(editor.getText(), '');
      assert.equal(recovered.length, 0);
      assert.equal(feedback.sync(), undefined);
    } finally {
      feedback.reset(); images.dispose(); transcript.dispose(); composer.stop();
      await backend.close(); await peer.dispose();
    }
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
