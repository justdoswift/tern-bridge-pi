import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The published omp components and their real image decoder require Bun. Keep
// these behavioral checks in the ordinary suite without substituting an editor
// mock or touching the host clipboard, Pi, or a provider.
test('native image drafts survive submission, rejection, edits and session lifetime', () => {
  const result = spawnSync('bun', ['--eval', String.raw`
    import assert from 'node:assert/strict';
    import { mkdtemp, writeFile, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { CustomEditor } from '@oh-my-pi/pi-tui/prompt/custom-editor';
    import { chipLabel } from '@oh-my-pi/pi-tui/prompt/composer-attachments';
    import { ensureThemeSync, getEditorTheme } from '@oh-my-pi/pi-tui/theme/theme';
    import { PiImageComposer } from './src/omp-images.ts';

    ensureThemeSync();
    const dir = await mkdtemp(join(tmpdir(), 'pi-image-behavior-'));
    const editor = new CustomEditor(getEditorTheme());
    const errors = [];
    const submissions = [];
    let session = 'first';
    const images = new PiImageComposer(editor, {
      locale: () => 'zh-CN', currentSession: () => session, cwd: () => dir,
      onChange() {}, onError: error => errors.push(error), onSubmit: draft => submissions.push(draft),
    });
    try {
      const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      const png = await new Bun.Image(gif).png().bytes();
      const fixtures = [
        ['image.png', png, 'image/png'],
        ['image.jpg', await new Bun.Image(png).jpeg().bytes(), 'image/jpeg'],
        ['image.gif', gif, 'image/gif'],
        ['image.webp', await new Bun.Image(png).webp().bytes(), 'image/webp'],
      ];
      for (const [name, bytes, mime] of fixtures) {
        await writeFile(join(dir, name), bytes);
        await editor.onPasteImagePath(name);
        assert.equal(editor.composerChips().at(-1).image.mimeType, mime);
      }
      assert.equal(errors.length, 0);
      assert.equal(editor.composerChips().length, 4);
      // Original base-editor large-paste serialization must stay private and
      // intact: restoring expanded prose here would lose this exact chip draft.
      editor.pasteText('retained text\n'.repeat(150));
      const raw = editor.getText();
      const expanded = editor.getExpandedText();
      editor.submit();
      const first = submissions.at(-1);
      assert.equal(editor.getText(), raw);
      assert.equal(editor.getExpandedText(), expanded);
      assert.equal(first.images.length, 4);
      assert.equal(first.text, 'retained text\n'.repeat(150).trim());
      assert.ok(Object.isFrozen(first.images));
      assert.ok(first.images.every(Object.isFrozen));
      // No acceptance (transport failure/cancel) leaves the same native draft.
      assert.equal(editor.composerChips().length, 4);
      editor.insertText('newer edit');
      assert.equal(images.accept(first), false);
      assert.ok(editor.getText().includes('newer edit'));
      editor.submit();
      const beforeNewImage = submissions.at(-1);
      await editor.onPasteImagePath('image.png');
      assert.equal(images.accept(beforeNewImage), false);
      assert.equal(editor.composerChips().filter(chip => chip.kind === 'image').length, 5);
      // Deleting a chip excludes its bytes, without rewriting the live draft.
      editor.setText(editor.getText().replace(chipLabel('image', 2), ''));
      const afterDeletion = editor.getText();
      editor.submit();
      const retained = submissions.at(-1);
      assert.equal(retained.images.length, 4);
      assert.equal(retained.images.some(image => image.mimeType === 'image/jpeg'), false);
      assert.equal(editor.getText(), afterDeletion);
      assert.equal(images.accept(retained), true);
      assert.equal(editor.getText(), '');
      assert.equal(editor.pendingImages.length, 0);
      assert.equal(editor.composerChips().length, 0);
      await editor.onPasteImagePath('image.png');
      editor.submit();
      const imageOnly = submissions.at(-1);
      assert.equal(imageOnly.text, '');
      assert.equal(imageOnly.images.length, 1);
      assert.equal(images.accept(imageOnly), true);
      await editor.onPasteImagePath('image.png');
      editor.pasteText('original session paste\n'.repeat(150));
      const beforeTransition = editor.getText();
      const expandedBeforeTransition = editor.getExpandedText();
      const failedOpen = images.beginSessionChange();
      assert.equal(editor.getText(), '');
      assert.equal(editor.pendingImages.length, 0);
      failedOpen.rollback();
      assert.equal(editor.getText(), beforeTransition);
      assert.equal(editor.getExpandedText(), expandedBeforeTransition);
      assert.equal(editor.composerChips().length, 1);
      const successfulOpen = images.beginSessionChange();
      const freshImage = editor.onPasteImagePath('image.webp');
      session = 'opened';
      successfulOpen.complete();
      await freshImage;
      assert.equal(editor.composerChips().length, 1);
      assert.equal(editor.pendingImages[0].mimeType, 'image/webp');
      const failedWithEdits = images.beginSessionChange();
      editor.insertText('draft typed during failed connection');
      failedWithEdits.rollback();
      assert.equal(editor.getText(), 'draft typed during failed connection');
      assert.equal(editor.pendingImages.length, 0);
      images.resetSession();
      await editor.onPasteImagePath('image.png');
      editor.submit();
      const oldSessionDraft = submissions.at(-1);
      const pathsFinished = Promise.withResolvers();
      const pastePath = editor.onPasteImagePath;
      let finishedPaths = 0;
      editor.onPasteImagePath = async path => {
        await pastePath(path);
        if (++finishedPaths === 2) pathsFinished.resolve();
      };
      editor.handleInput('\x1b[200~' + join(dir, 'image.png') + ' ' + join(dir, 'image.webp') + '\x1b[201~');
      session = 'second';
      images.resetSession();
      await pathsFinished.promise;
      editor.onPasteImagePath = pastePath;
      assert.equal(images.accept(oldSessionDraft), false);
      assert.equal(editor.pendingImages.length, 0);
      await editor.onPasteImagePath('missing.png');
      await writeFile(join(dir, 'invalid.png'), 'not image data');
      await editor.onPasteImagePath('invalid.png');
      await editor.onPasteImagePath(dir);
      assert.equal(errors.length, 3);
      assert.equal(editor.pendingImages.length, 0);
      const closing = editor.onPasteImagePath('image.png');
      images.dispose();
      await closing;
      assert.equal(editor.pendingImages.length, 0);
      // /quit closes the bridge synchronously from the real keyboard submission.
      // Late acknowledgements must not revive that closed editor or read clipboard data.
      const quitEditor = new CustomEditor(getEditorTheme());
      let quitSubmission;
      const quitImages = new PiImageComposer(quitEditor, {
        locale: () => 'zh-CN', currentSession: () => 'quitting', cwd: () => dir,
        onChange() {}, onError: error => { throw error; },
        onSubmit: draft => { quitSubmission = draft; quitImages.dispose(); },
      });
      quitEditor.setText('/quit');
      quitEditor.handleInput('\r');
      await Promise.resolve();
      assert.equal(quitSubmission.text, '/quit');
      assert.equal(quitEditor.getText(), '');
      assert.equal(quitImages.accept(quitSubmission), false);
      assert.equal(await quitImages.pasteClipboard(), false);
    } finally {
      images.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
