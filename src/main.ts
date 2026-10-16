import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { Composer } from '@oh-my-pi/pi-tui/prompt/composer';
import { AttachmentChipsBand } from '@oh-my-pi/pi-tui/prompt/attachment-chips';
import { CombinedAutocompleteProvider } from '@oh-my-pi/pi-tui/autocomplete';
import { ErrorBannerComponent } from '@oh-my-pi/pi-tui/overlays/error-banner';
import { EMPTY_NODE, node, span } from '@oh-my-pi/pi-tui/native/describe';
import { encodeTspJson, TSP_PREFIX } from '@oh-my-pi/pi-tui/native/encode';
import { actionButton } from '@oh-my-pi/pi-tui/native/overlay';
import { onNativeRenderingChange } from '@oh-my-pi/pi-tui/native/state';
import { styledSpans } from '@oh-my-pi/pi-tui/native/spans';
import { stopSharedSpinnerTicker } from '@oh-my-pi/pi-tui/chat/tool-execution';
import type { ComposerFacts } from '@oh-my-pi/pi-tui/status-line/types';
import type { Component } from '@oh-my-pi/pi-tui/tui';
import { PiBridge } from './backend.js';
import type { Locale } from './contracts.js';
import { PiTranscript } from './omp-transcript.js';
import { PiDialogs } from './omp-dialogs.js';
import { PiTodoHud } from './omp-todos.js';
import { PiWorkingHud } from './omp-working.js';
import { PiWelcome } from './omp-welcome.js';
import { PiExtensionText } from './omp-extension-text.js';
import { isPiWorking } from './work-state.js';
import { PiImageComposer, imageAdmissionError, type ImageSubmission } from './omp-images.js';
import { PiSendFeedback } from './omp-send-feedback.js';
import { dictionary } from './i18n.js';
import { commandEntries, routeCommand } from './omp-commands.js';

const { values } = parseArgs({ options: {
  cwd: { type: 'string' }, 'data-dir': { type: 'string' }, pi: { type: 'string' }, 'session-dir': { type: 'string' },
  session: { type: 'string' }, 'pick-session': { type: 'boolean' }, locale: { type: 'string' },
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
} });
if (values.help || values.version) {
  process.stdout.write(values.version ? 'tern-bridge-pi 0.1.0\n' :
    'tern-bridge-pi — Pi in Tern native surfaces\n\n' +
    'Usage: bun dist/client.mjs [--cwd DIR] [--data-dir DIR] [--session FILE | --pick-session]\n' +
    '       [--pi PATH] [--session-dir DIR] [--locale zh-CN|en-US]\n\n' +
    'Requires Bun 1.3.14+, Tern native surfaces and an authenticated Pi CLI.\n' +
    'Sending messages or compacting can use model quota; normal Pi extensions remain enabled.\n');
} else await run();

async function run(): Promise<void> {
  if (values.locale && values.locale !== 'zh-CN' && values.locale !== 'en-US') throw new Error('--locale must be zh-CN or en-US');
  if (values.session && values['pick-session']) throw new Error('Choose --session or --pick-session, not both.');
  const cwd = resolve(values.cwd ?? process.cwd());
  const config = process.env.TERN_CONFIG_DIR ?? (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Tern')
    : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'tern'));
  const dataDir = resolve(values['data-dir'] ?? join(config, 'plugin-data', 'tern-bridge-pi'));
  let preferences: Record<string, unknown> = {};
  try {
    const saved: unknown = JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) preferences = saved as Record<string, unknown>;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  let locale: Locale = values.locale === 'en-US' || (!values.locale && preferences.locale === 'en-US') ? 'en-US' : 'zh-CN';
  const text = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  if (process.env.TERM_PROGRAM?.toLowerCase() !== 'tern' || !process.stdin.isTTY) {
    process.stderr.write(text('请在 Tern 的本机窗格中打开此客户端。\n', 'Open this client in a local Tern pane.\n'));
    process.exitCode = 1;
    return;
  }
  // The shared UI's opt-in TSP recorder must not copy conversations.
  delete process.env.PI_TUI_TSP_RECORD;
  process.title = 'tern-bridge-pi';
  const ended = Promise.withResolvers<void>();
  let closing = false;
  let scheduled = false;
  let submitting = false;
  let terminalProgress = false;
  let pendingNew: string | null = null;
  let uiError: string | null = null;
  let observedBackendError: string | null = null;
  let dismissedBackendError: string | null = null;
  let banner: ErrorBannerComponent | undefined;
  let bannerMessage: string | null = null;
  let mountedPrompt: Component | undefined;
  let facts: ComposerFacts;
  let factsKey = '';
  let expanded = false;
  let autocompleteCwd = '';
  let autocompleteCommands = '';
  let appliedEditorRequest: string | undefined;
  let editorSession: string | null | undefined;
  const widgetComponents = new Map<string, PiExtensionText>();
  const notice = new PiExtensionText('', 0, 0);
  const welcome = new PiWelcome(locale);
  const composer = new Composer({ preferences: { quiet: true, spellingAutocomplete: 'off', spellingTypoDetection: false }, exit: code => { process.exitCode = code; void shutdown(); } });
  const backend = new PiBridge({ cwd, dataDir, sessionDir: values['session-dir'], execPath: values.pi ?? (typeof preferences.piPath === 'string' ? preferences.piPath : undefined), onChange: changed, onUserMessage: () => sendFeedback.recorded() });
  const surfaceOpen = `${TSP_PREFIX}o;`;
  const writeNative = composer.ui.terminal.write.bind(composer.ui.terminal);
  composer.ui.terminal.write = data => {
    // Preserve stock UI frames; replace only its hard-coded surface-open brand.
    if (data.startsWith(surfaceOpen) && data.endsWith('\x1b\\')) {
      const body = data.slice(surfaceOpen.length, -2);
      const opening = JSON.parse(body) as Record<string, unknown>;
      const title = `Pi · ${backend.state.windowTitle ?? (backend.state.session?.title || dictionary(locale).untitled)}`;
      // The original unchunked metadata already fits the negotiated limit.
      writeNative(encodeTspJson('o', { ...opening, title }, undefined, Buffer.byteLength(body)));
    } else writeNative(data);
  };
  const transcript = new PiTranscript(composer.ui, cwd);
  const todos = new PiTodoHud();
  const working = new PiWorkingHud(todos);
  const dialogs = new PiDialogs(composer, backend, { locale: () => locale, onError: report, onChange: changed, openSession: id => open(id) });
  composer.setHeaderExtras([welcome], []);
  composer.editor.magicKeywordsEnabledOverride = false;
  composer.editor.attachmentChips = new AttachmentChipsBand(composer.editor, composer.ui.imageBudget, () => composer.ui.requestRender());
  composer.editor.composerState = () => ({ running: busy(), thinking: backend.state.session?.settings.reasoningEffort, title: backend.state.session?.title || undefined });
  composer.editor.composerFacts = {
    describeComposerFacts: () => facts,
    handleNativeEvent(event) {
      if (event.type === 'action' && event.act.startsWith('status.')) void perform(() => command(event.act.slice(7)));
    },
  };
  const images = new PiImageComposer(composer.editor, {
    locale: () => locale, currentSession: () => backend.state.session?.id ?? null,
    cwd: () => backend.state.session?.cwd ?? cwd, onChange: changed, onError: report,
    onSubmit: submission => { void perform(() => submit(submission)); },
  });
  const sendFeedback = new PiSendFeedback(backend, images, {
    locale: () => locale, onChange: changed,
    onRecovery: restored => {
      backend.state.notice = restored
        ? text('消息尚未确认，已恢复草稿。', 'The message was not confirmed. Your draft has been restored.')
        : text('消息尚未确认，当前草稿已保留；输入框为空时按 ↑ 可找回原消息。', 'The message was not confirmed. Your new draft is unchanged; press ↑ in an empty composer to recall the original.');
    },
  });
  composer.editor.onEscape = () => { void perform(() => busy() ? backend.interrupt() : Promise.resolve()); };
  const clearOrExit = composer.editor.onClear;
  composer.editor.onClear = () => {
    clearOrExit?.();
    if (closing) return;
    composer.editor.clearDraft();
    if (busy()) void perform(() => backend.interrupt());
  };
  composer.editor.onExit = () => { void perform(() => command('quit')); };
  composer.editor.onSelectModel = composer.editor.onSelectModelTemporary = () => { void perform(() => command('model')); };
  composer.editor.onCycleThinkingLevel = () => { void perform(() => command('thinking')); };
  composer.editor.onRetry = () => { void perform(() => command('retry')); };
  composer.editor.setCustomKeyHandler('ctrl+alt+shift+o', () => { void perform(() => dialogs.sessions()); });
  composer.editor.setCustomKeyHandler('ctrl+alt+shift+n', () => { void perform(() => command('new')); });
  composer.editor.setCustomKeyHandler('ctrl+o', () => { expanded = !expanded; transcript.setExpanded(expanded); changed(); });
  let commands = commandEntries(locale, []);
  const composerStyle = `${TSP_PREFIX}s;${JSON.stringify({
    name: 'pi-composer',
    css: `
      .sf-place { display: none; }
      [data-role='omp.composer.model'], [data-role='omp.composer.effort'] { align-self: center; }
      /* Override the native chat button minimum without changing overlay buttons. */
      [data-role='omp.composer.extras'] > [data-role='omp.btn'] {
        box-sizing: border-box !important; height: 28px !important; min-height: 28px !important;
        padding: 0 10px !important; font-family: var(--sans); font-size: 12.5px; font-weight: 500; line-height: 26px;
      }
      [data-role='omp.composer.extras'] > [data-role='omp.btn'] > .sf-text { line-height: 26px; }
      [data-role='omp.welcome'] [data-role='omp.welcome.lockup'] { height: auto; }
      [data-role='omp.welcome'] [data-role='omp.welcome.tip'] { opacity: 1; animation: none; }
      [data-role='pi.welcome.wordmark'] { color: var(--accent); font-family: var(--sans); font-size: 48px; font-weight: 600; line-height: 56px; }
      [data-role='pi.welcome.shortcuts'] { justify-content: center; margin-top: 12px; font-family: var(--sans); font-size: 12px; }
      [data-role='pi.extension.text'], [data-role='pi.extension.text'] .sf-text {
        font-family: var(--sans); font-size: 12px; line-height: 18px; color: var(--sf-c-muted);
      }
      [data-role='pi.send.status'] { font-family: var(--sans); font-size: 12px; color: var(--sf-c-muted); }
      [data-role='pi.extension.status'] {
        font-family: var(--sans); font-size: 11px; line-height: 18px; color: var(--sf-c-muted);
        min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
    `,
  })}\x1b\\`;
  const nativeChange = onNativeRenderingChange(on => {
    if (on) {
      composer.ui.terminal.setTitle(`Pi · ${backend.state.windowTitle ?? (backend.state.session?.title || dictionary(locale).untitled)}`);
      // Welcome and composer styles affect only this native surface.
      composer.ui.terminal.write(composerStyle);
    }
  });

  function busy(): boolean {
    return submitting || backend.state.needsInterrupt || ['connecting', 'running', 'approval', 'question', 'stopping'].includes(backend.state.phase);
  }
  function report(error: unknown): void {
    if (closing) return;
    uiError = imageAdmissionError(error, locale) ?? (error instanceof Error ? error.message : String(error));
    pendingNew = null;
    changed();
  }
  async function perform(work: () => Promise<void>): Promise<void> {
    uiError = null;
    try { await work(); } catch (error) { report(error); }
    changed();
  }
  function changed(): void {
    if (closing || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closing) return;
      try { update(); } catch {
        process.exitCode = 1;
        process.stderr.write('Pi UI rendering failed. Saved messages were not replayed. Reopen the saved session.\n');
        void shutdown();
        return;
      }
      if (pendingNew) {
        if (backend.state.session?.id !== pendingNew || backend.state.phase === 'error') pendingNew = null;
        else if (!busy() && backend.state.phase === 'idle') { pendingNew = null; void perform(() => open()); }
      }
    });
  }
  function update(): void {
    const active = isPiWorking(backend.state);
    if (terminalProgress !== active) {
      terminalProgress = active;
      composer.ui.terminal.setProgress(active);
    }
    const b = backend.state;
    const t = dictionary(locale);
    const activeCwd = b.session?.cwd || cwd;
    const nextCommands = JSON.stringify([locale, b.commands]);
    if (activeCwd !== autocompleteCwd || nextCommands !== autocompleteCommands) {
      autocompleteCwd = activeCwd;
      autocompleteCommands = nextCommands;
      commands = commandEntries(locale, b.commands);
      composer.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, activeCwd));
    }
    if (b.error !== observedBackendError) { observedBackendError = b.error; dismissedBackendError = null; }
    const error = uiError || (b.error === dismissedBackendError ? null : b.error);
    if (error !== bannerMessage) {
      banner?.dispose();
      bannerMessage = error;
      banner = error ? new ErrorBannerComponent(error, () => { uiError = null; dismissedBackendError = b.error; changed(); }) : undefined;
    }
    welcome.sync(b.session?.title ?? '', locale);
    notice.setText(b.notice ?? '');
    if (editorSession !== (b.session?.id ?? null)) {
      editorSession = b.session?.id ?? null;
      appliedEditorRequest = undefined;
    }
    if (b.editorText && b.editorText.id !== appliedEditorRequest) {
      appliedEditorRequest = b.editorText.id;
      composer.editor.setText(b.editorText.text);
    }
    const widgets = b.widgets.map(widget => {
      let component = widgetComponents.get(widget.key);
      if (!component) { component = new PiExtensionText('', 0, 0); widgetComponents.set(widget.key, component); }
      component.setText(widget.lines.join('\n'));
      return { component, placement: widget.placement };
    });
    for (const key of widgetComponents.keys()) {
      if (!b.widgets.some(widget => widget.key === key)) widgetComponents.delete(key);
    }
    transcript.sync(b, sendFeedback.sync());
    todos.sync(b, locale);
    working.sync(b, locale);
    const prompt = dialogs.syncPrompts();
    composer.editor.disableSubmit = submitting || ['connecting', 'running', 'approval', 'question', 'stopping'].includes(b.phase) || b.needsInterrupt;
    composer.setRuntimeChildren([transcript.container, ...(banner ? [banner] : []), ...(b.notice ? [notice] : []),
      ...widgets.filter(widget => widget.placement === 'aboveEditor').map(widget => widget.component),
      working, prompt ?? composer.editor,
      ...widgets.filter(widget => widget.placement === 'belowEditor').map(widget => widget.component)]);
    if (prompt !== mountedPrompt) {
      mountedPrompt = prompt;
      if (!dialogs.hasOverlay()) composer.ui.setFocus(prompt ?? composer.editor);
    }
    const settings = b.session?.settings;
    const selected = b.models.find(model => model.id === settings?.modelId);
    const key = JSON.stringify([locale, b.phase, b.context, b.session?.title, selected?.label, settings, b.statuses]);
    if (key !== factsKey) {
      factsKey = key;
      // Keep recovery reachable when native width compression hides optional controls.
      const controls = ['error', 'disconnected'].includes(b.phase)
        ? [actionButton(t.reconnect, 'status.retry', { key: 'retry', title: t.reconnectHint })] : [];
      const statuses = b.statuses.map(status => node('text', {
        role: 'pi.extension.status', spans: styledSpans(status.text), wrap: 'none', max: { w: 180 },
        title: stripVTControlCharacters(status.text),
      }, undefined, status.key));
      facts = {
        context: b.context && b.context.limit > 0 ? node('meter', {
          role: 'omp.composer.context', style: 'bar', actions: { click: 'status.context' }, aria: t.context,
          value: Math.min(1, b.context.used / b.context.limit), label: `${Math.round(b.context.used / b.context.limit * 100)}%`,
          title: `${t.context}: ${b.context.used.toLocaleString(locale)} / ${b.context.limit.toLocaleString(locale)}`,
        }, undefined, 'context') : EMPTY_NODE,
        model: { spans: [span(`Pi · ${selected?.label || settings?.modelId || t.default}`)], title: t.model },
        extras: node('row', { role: 'omp.composer.extras', grow: 1, gap: 'sm', align: 'center', min: { w: 0 } }, [...controls, ...statuses], 'extras'),
        usage: EMPTY_NODE,
      };
    }
    composer.ui.terminal.setTitle(`Pi · ${b.windowTitle ?? (b.session?.title || t.untitled)}`);
    composer.ui.requestRender();
  }
  async function open(id?: string): Promise<void> {
    pendingNew = null;
    if (busy()) throw new Error(text('请先停止当前任务，再切换会话。', 'Stop the active turn before switching conversations.'));
    if (id !== undefined && id === backend.state.session?.file) {
      await backend.open(id);
      return;
    }
    await changeSession(() => backend.open(id));
    // Input typed during connection belongs to the selected session. Live backend
    // prompts and the selector own focus; opening never redirects it to a hidden editor.
  }
  async function changeSession(action: () => Promise<void>): Promise<void> {
    const before = backend.state.session;
    const identity = [before?.id, before?.file];
    const transition = images.beginSessionChange();
    sendFeedback.reset();
    try {
      await action();
      const after = backend.state.session;
      if (identity[0] === after?.id && identity[1] === after?.file) transition.rollback();
      else transition.complete();
    } catch (error) { transition.rollback(); throw error; }
  }
  async function submit(submission: ImageSubmission): Promise<void> {
    const message = submission.text;
    if (!message.trim() && !submission.images.length) return;
    const route = submission.images.length ? { kind: 'message' as const } : routeCommand(message, backend.state.commands);
    if (route.kind === 'unknown') throw new Error(text('此命令不在 Pi 已发现的命令中。输入 /bridge:help 查看本地操作。', 'Pi has not advertised this command. Use /bridge:help for local actions.'));
    if (route.kind === 'local') {
      images.accept(submission);
      await command(route.name, route.argument);
      return;
    }
    if (busy() || backend.state.phase !== 'idle') throw new Error(text('当前无法发送。请先停止任务或重新连接会话。', 'Cannot send now. Stop the active work or reconnect the session.'));
    submitting = true;
    changed();
    try {
      await sendFeedback.send(submission);
    } finally { submitting = false; changed(); }
  }
  async function command(name: string, argument?: string): Promise<void> {
    const t = dictionary(locale);
    switch (name) {
      case 'sessions': return dialogs.sessions();
      case 'context': return dialogs.context();
      case 'resume': return argument?.trim() ? open(argument.trim()) : dialogs.sessions();
      case 'help': {
        const selected = await dialogs.choose(text('Pi 会话操作', 'Pi conversation actions'), commands.filter(item => item.name.startsWith('bridge:') && item.name !== 'bridge:help').map(item => ({ value: item.name.slice(7), label: `/${item.name}`, description: item.description })));
        if (selected) await command(selected);
        return;
      }
      case 'new': {
        if (busy()) {
          if (!await dialogs.confirm(text('停止并新建对话？', 'Stop and start a new conversation?'), text('已执行的文件修改不会自动撤销。', 'File changes already made will not be undone.'))) return;
          const source = backend.state.session?.id;
          await backend.interrupt();
          if (source && backend.state.session?.id === source) pendingNew = source;
          changed();
        } else await open();
        return;
      }
      case 'model': {
        const value = await dialogs.choose(t.model, backend.state.models.map(model => ({ value: model.id, label: model.label, description: `${model.provider} / ${model.modelId}` })));
        if (value) await backend.updateSettings({ modelId: value });
        return;
      }
      case 'thinking': {
        const value = await dialogs.choose(t.reasoning, (backend.state.session?.settings.thinkingLevels ?? []).map(value => ({ value, label: value })));
        if (value) await backend.updateSettings({ reasoningEffort: value });
        return;
      }
      case 'rename': {
        const value = argument ?? await dialogs.input(t.rename, backend.state.session?.title, t.renameHint);
        if (value?.trim()) await backend.rename(value);
        return;
      }
      case 'fork': {
        const choices = await backend.forkMessages();
        const entryId = await dialogs.choose(t.fork, choices.map(choice => ({ value: choice.entryId, label: choice.text || t.user, description: choice.entryId })));
        if (entryId) await changeSession(() => backend.fork(entryId));
        return;
      }
      case 'clone': return changeSession(() => backend.clone());
      case 'compact': {
        const value = await dialogs.input(t.compact, argument, text('压缩可能调用所选模型并消耗提供商额度。可填写额外要求。', 'Compaction may call the selected model and use provider quota. Extra instructions are optional.'));
        if (value !== undefined) await backend.compact(value || undefined);
        return;
      }
      case 'retry': await backend.open(backend.state.session?.file); return;
      case 'language': {
        const value = argument ?? await dialogs.choose(t.language, [{ value: 'zh-CN', label: '简体中文' }, { value: 'en-US', label: 'English' }]);
        if (value !== 'zh-CN' && value !== 'en-US') return;
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        const path = join(dataDir, 'preferences.json');
        const pending = `${path}.${process.pid}.tmp`;
        await writeFile(pending, JSON.stringify({ ...preferences, locale: value }) + '\n', { mode: 0o600 });
        await rename(pending, path);
        preferences = { ...preferences, locale: value }; locale = value; factsKey = '';
        return;
      }
      case 'quit':
        if ((busy() || composer.editor.getText()) && !await dialogs.confirm(text('关闭客户端？', 'Close the client?'), text('会停止当前任务，未发送草稿不会保存；历史会话保留。', 'The active turn will stop and unsent drafts will be lost. Saved conversations remain.'))) return;
        return shutdown();
    }
  }
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    pendingNew = null;
    composer.ui.terminal.setProgress(false);
    dialogs.dispose();
    sendFeedback.reset();
    images.dispose();
    try { await backend.close(); }
    finally {
      nativeChange(); transcript.dispose(); stopSharedSpinnerTicker(); composer.stop(); ended.resolve();
    }
  }
  const signal = () => { void shutdown(); };
  for (const signalName of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signalName, signal);
  try {
    update();
    composer.start({ clearScrollback: false, playWelcomeIntro: false, deferInput: true });
    composer.ui.releaseHeldInput();
    if (values['pick-session']) void perform(() => dialogs.sessions());
    else void perform(() => backend.open(values.session));
    await ended.promise;
  } finally {
    for (const signalName of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signalName, signal);
    await shutdown();
  }
}
