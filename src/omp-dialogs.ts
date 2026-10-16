import type { Component, OverlayHandle } from '@oh-my-pi/pi-tui';
import type { Composer } from '@oh-my-pi/pi-tui/prompt/composer';
import { ApprovalDialogComponent } from '@oh-my-pi/pi-tui/overlays/approval-dialog';
import { HookEditorComponent } from '@oh-my-pi/pi-tui/overlays/hook-editor';
import { HookSelectorComponent } from '@oh-my-pi/pi-tui/overlays/hook-selector';
import { SessionSelectorComponent, type SessionSelectorEntry } from '@oh-my-pi/pi-tui/overlays/session-selector';
import { Text } from '@oh-my-pi/pi-tui/components/text';
import type { DescribeContext, NativeNode } from '@oh-my-pi/pi-tui/native/node';
import type { BridgeBackend, DialogResponse, Locale, PendingDialog, SessionSummary } from './contracts.js';
import { dictionary } from './i18n.js';
import { PiContextLoading, PiContextReport, PiContextView } from './omp-context.js';

export interface DialogChoice { value: string; label: string; description?: string; disabledReason?: string }
interface DialogOptions {
  locale: () => Locale;
  onError: (error: unknown) => void;
  onChange: () => void;
  openSession: (path: string) => Promise<void>;
}
interface PromptState {
  source: PendingDialog;
  sessionId: string | undefined;
  signature: string;
  settled: boolean;
  processing: boolean;
  component?: Component;
}
interface ModalState {
  component: Component;
  handle: OverlayHandle;
  sessionId?: string | null;
  cancel: () => void;
}
interface ModalControls<T> {
  finish: (value: T | undefined) => void;
  active: () => boolean;
  replace: (component: Component) => void;
}
class PiModalSelector extends HookSelectorComponent {
  nativeSheet(cx: DescribeContext): boolean { return cx.supports('picker'); }
}
class PiSessionSelector extends SessionSelectorComponent {
  loadingMessage?: string;
  override describe(cx: DescribeContext): NativeNode {
    const original = super.describe(cx);
    return original.k === 'picker' && this.loadingMessage
      ? { ...original, p: { ...original.p, state: 'loading', message: this.loadingMessage } } : original;
  }
}

/** Request lifetimes and focus only; stock components own all dialog presentation/input. */
export class PiDialogs {
  private modal?: ModalState;
  private prompt?: PromptState;
  private disposed = false;

  constructor(private readonly composer: Composer, private readonly backend: BridgeBackend, private readonly options: DialogOptions) {}

  async sessions(): Promise<void> {
    this.syncPrompts();
    await this.showModal<void>(controls => {
      const t = dictionary(this.options.locale());
      let opening = false;
      const close = () => controls.finish(undefined);
      const entries = (items: SessionSummary[]): SessionSelectorEntry[] => items.map(item => ({
        path: item.path, id: item.id, cwd: item.cwd, title: item.title,
        modified: new Date(item.modifiedTime), size: item.size, firstMessage: '', allMessagesText: '',
      }));
      const picker = (items: SessionSelectorEntry[], loading = false): PiSessionSelector => {
        const component = new PiSessionSelector(items, session => {
          if (!controls.active() || opening || loading) return;
          opening = true;
          component.lockInput();
          void this.options.openSession(session.path).then(() => {
            if (controls.active()) close();
          }).catch(error => {
            if (!controls.active()) return;
            opening = false;
            component.unlockInput();
            this.options.onError(error);
            this.options.onChange();
          });
        }, close, close, {
          title: loading ? t.loading : t.sessions, showCwd: false,
          currentSessionPath: () => this.backend.state.session?.file,
          getTerminalRows: () => this.composer.ui.terminal.rows,
          ...(loading ? {} : { loadAllSessions: async () => {
            const all = await this.backend.sessions(true);
            if (!controls.active()) throw new Error('Session selector was closed.');
            return entries(all);
          } }),
        });
        component.loadingMessage = loading ? t.loading : undefined;
        component.getSessionList().onDeleteRequest = undefined;
        component.setOnRequestRender(() => { if (controls.active()) this.options.onChange(); });
        return component;
      };
      const load = async (): Promise<void> => {
        try {
          const items = await this.backend.sessions(false);
          if (controls.active()) controls.replace(picker(entries(items)));
        } catch (error) {
          if (!controls.active()) return;
          this.options.onError(error);
          controls.replace(new PiModalSelector(t.sessions, [t.retry, t.cancel], selected => {
            if (!controls.active()) return;
            if (selected !== t.retry) { close(); return; }
            controls.replace(picker([], true));
            void load();
          }, close, { tui: this.composer.ui }));
        }
      };
      queueMicrotask(() => { if (controls.active()) void load(); });
      return picker([], true);
    });
  }

  async context(): Promise<void> {
    this.syncPrompts();
    const sessionId = this.backend.state.session?.id ?? null;
    await this.showModal<void>(controls => {
      const locale = this.options.locale();
      const t = dictionary(locale);
      const close = () => controls.finish(undefined);
      const loading = () => new PiContextReport(t.context, new PiContextLoading(locale), locale, close);
      let pending = false;
      const load = async (): Promise<void> => {
        if (!controls.active() || pending) return;
        pending = true;
        try {
          const details = await this.backend.contextDetails();
          if (controls.active()) controls.replace(new PiContextReport(
            details.modelLabel ? `${t.context} · ${details.modelLabel}` : t.context, new PiContextView(details, locale), locale, close,
          ));
        } catch {
          if (controls.active()) controls.replace(new PiContextReport(t.context, new Text(t.contextFailed, 0, 0), locale, close, () => {
            if (!controls.active() || pending) return;
            controls.replace(loading());
            void load();
          }));
        } finally { pending = false; }
      };
      queueMicrotask(() => { if (controls.active()) void load(); });
      return loading();
    }, sessionId);
  }

  async choose(title: string, choices: DialogChoice[]): Promise<string | undefined> {
    this.syncPrompts();
    const offered = choices.map(choice => ({ ...choice }));
    return this.showModal<string>(controls => {
      const rows = this.choiceRows(offered);
      return new PiModalSelector(title, rows, label => {
        if (!controls.active()) return;
        const choice = offered[rows.findIndex(row => row.label === label)];
        if (choice && !choice.disabledReason) controls.finish(choice.value);
      }, () => controls.finish(undefined), {
        tui: this.composer.ui,
        disabledIndices: offered.flatMap((choice, index) => choice.disabledReason ? [index] : []),
      });
    }, this.backend.state.session?.id ?? null);
  }

  input(title: string, initial?: string, detail?: string): Promise<string | undefined> {
    this.syncPrompts();
    return this.showModal<string>(controls => new HookEditorComponent(this.composer.ui, title, initial,
      value => { if (controls.active()) controls.finish(value); }, () => controls.finish(undefined), { question: detail }),
    this.backend.state.session?.id ?? null);
  }

  async confirm(title: string, detail: string): Promise<boolean> {
    this.syncPrompts();
    return (await this.showModal<boolean>(controls => new ApprovalDialogComponent(`${title}\n${detail}`, {
      onApprove: () => { if (controls.active()) controls.finish(true); }, onDeny: () => controls.finish(false),
    }, { tui: this.composer.ui, fullPrompt: `${title}\n${detail}` }), this.backend.state.session?.id ?? null)) === true;
  }

  syncPrompts(): Component | undefined {
    if (this.disposed) return undefined;
    const live = this.livePrompt();
    const sessionId = this.backend.state.session?.id;
    if (this.modal?.sessionId !== undefined && this.modal.sessionId !== (sessionId ?? null)) this.modal.cancel();
    const signature = live ? JSON.stringify(live) : '';
    if (this.prompt && (!live || this.prompt.sessionId !== sessionId || this.prompt.signature !== signature)) {
      this.prompt.settled = true;
      this.prompt.component?.dispose?.();
      this.prompt = undefined;
    }
    if (!live) return undefined;
    if (this.modal) this.modal.cancel();
    if (!this.prompt) {
      const prompt: PromptState = { source: live, sessionId, signature, settled: false, processing: false };
      this.prompt = prompt;
      this.mountPrompt(prompt);
    }
    return this.prompt.component;
  }

  hasOverlay(): boolean { return !!this.modal && !this.modal.handle.isHidden() && this.modalCurrent(this.modal); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.modal?.cancel();
    if (this.prompt) {
      this.prompt.settled = true;
      this.prompt.component?.dispose?.();
      this.prompt = undefined;
    }
  }

  private livePrompt(): PendingDialog | undefined {
    const state = this.backend.state;
    return ['question', 'approval'].includes(state.phase) ? state.dialog ?? undefined : undefined;
  }

  private current(prompt: PromptState): boolean {
    const live = this.livePrompt();
    return !this.disposed && this.prompt === prompt && !prompt.settled &&
      this.backend.state.session?.id === prompt.sessionId && live?.id === prompt.source.id &&
      JSON.stringify(live) === prompt.signature && (live.deadline === undefined || Date.now() < live.deadline);
  }

  private modalCurrent(modal: ModalState): boolean {
    return !this.disposed && this.modal === modal && !this.livePrompt() &&
      (modal.sessionId === undefined || modal.sessionId === (this.backend.state.session?.id ?? null));
  }

  private focus(): void {
    if (!this.disposed && !this.modal) this.composer.ui.setFocus(this.prompt?.component ?? this.composer.editor);
  }

  private showModal<T>(create: (controls: ModalControls<T>) => Component, sessionId?: string | null): Promise<T | undefined> {
    if (this.disposed || this.livePrompt()) return Promise.resolve(undefined);
    this.modal?.cancel();
    const { promise, resolve } = Promise.withResolvers<T | undefined>();
    let modal: ModalState;
    let closed = false;
    const finish = (value: T | undefined): void => {
      if (closed) return;
      closed = true;
      const valid = this.modalCurrent(modal);
      if (this.modal === modal) this.modal = undefined;
      modal.handle.hide();
      modal.component.dispose?.();
      this.focus();
      resolve(valid ? value : undefined);
      if (!this.disposed) this.options.onChange();
    };
    const component = create({ finish,
      active: () => !closed && this.modalCurrent(modal),
      replace: replacement => {
        if (closed || !this.modalCurrent(modal)) { replacement.dispose?.(); return; }
        modal.handle.hide();
        modal.component.dispose?.();
        modal.component = replacement;
        modal.handle = this.composer.ui.showOverlay(replacement, { width: '90%', maxHeight: '90%' });
        this.options.onChange();
      },
    });
    modal = { component, sessionId, cancel: () => finish(undefined),
      handle: this.composer.ui.showOverlay(component, { width: '90%', maxHeight: '90%' }) };
    this.modal = modal;
    this.options.onChange();
    return promise;
  }

  private choiceRows(choices: DialogChoice[]): { label: string; description?: string }[] {
    const used = new Set<string>();
    return choices.map(choice => {
      let label = choice.label;
      let suffix = 2;
      while (used.has(label)) label = `${choice.label} [${suffix++}]`;
      used.add(label);
      const description = [choice.description, choice.disabledReason].filter(Boolean).join('\n');
      return { label, ...(description ? { description } : {}) };
    });
  }

  private mountPrompt(prompt: PromptState): void {
    const request = prompt.source;
    const cancel = () => { void this.settlePrompt(prompt, { cancelled: true }); };
    if (request.method === 'confirm') {
      prompt.component = new ApprovalDialogComponent([request.title, request.message].filter(Boolean).join('\n'), {
        onApprove: () => { void this.settlePrompt(prompt, { confirmed: true }); },
        onDeny: () => { void this.settlePrompt(prompt, { confirmed: false }); },
      }, { tui: this.composer.ui, fullPrompt: [request.title, request.message].filter(Boolean).join('\n') });
    } else if (request.method === 'select') {
      const offered = [...(request.options ?? [])];
      // Literal options round-trip unchanged, including duplicate labels.
      prompt.component = new HookSelectorComponent(request.title, offered,
        selected => { if (offered.includes(selected)) void this.settlePrompt(prompt, { value: selected }); }, cancel,
        { tui: this.composer.ui, inline: true });
    } else {
      prompt.component = new HookEditorComponent(this.composer.ui, request.title, request.prefill,
        value => { void this.settlePrompt(prompt, { value }); }, cancel,
        { question: request.message ?? request.placeholder, promptStyle: request.method === 'input' });
    }
    this.focus();
  }

  private async settlePrompt(prompt: PromptState, response: DialogResponse): Promise<void> {
    if (!this.current(prompt) || prompt.processing) return;
    prompt.processing = true;
    try {
      await this.backend.resolveDialog(prompt.source.id, response);
      prompt.settled = true;
    } catch (error) {
      if (this.current(prompt)) this.options.onError(error);
    } finally {
      prompt.processing = false;
      if (!this.disposed) this.options.onChange();
    }
  }
}
