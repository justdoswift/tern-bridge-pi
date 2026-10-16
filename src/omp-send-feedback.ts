import { Container, type Component } from '@oh-my-pi/pi-tui/tui';
import { UserMessageComponent } from '@oh-my-pi/pi-tui/chat/user-message';
import { Text } from '@oh-my-pi/pi-tui/components/text';
import { node } from '@oh-my-pi/pi-tui/native/describe';
import type { DescribeContext, NativeNode } from '@oh-my-pi/pi-tui/native/node';
import type { BridgeBackend, Locale } from './contracts.js';
import type { ImageSubmission, PiImageComposer } from './omp-images.js';

class SendStatus extends Text {
  label = '';
  override describe(_cx: DescribeContext): NativeNode {
    return node('row', { justify: 'end' }, [node('text', { role: 'pi.send.status', text: this.label })]);
  }
  update(label: string): void { this.label = label; this.setText(label); }
}
interface PendingSend {
  submission: ImageSubmission;
  session: string | undefined;
  file: string | undefined;
  view: Container;
  status: SendStatus;
  accepted: boolean;
  finished: boolean;
  visible: boolean;
}

/** Presentation only: Pi's live messages replace this bubble, never merge with invented IDs. */
export class PiSendFeedback {
  private pending: PendingSend | undefined;
  constructor(private readonly backend: BridgeBackend, private readonly images: PiImageComposer,
    private readonly options: { locale(): Locale; onChange(): void; onRecovery(restored: boolean): void }) {}

  sync(): Component | undefined {
    const pending = this.pending;
    if (!pending) return;
    if (!this.sameSession(pending) || (pending.finished && !this.backend.state.needsInterrupt)) {
      this.reset();
      return;
    }
    pending.status.update(this.options.locale() === 'zh-CN'
      ? pending.accepted ? '已发送，等待 Pi 回显…' : '发送中…'
      : pending.accepted ? 'Sent; waiting for Pi…' : 'Sending…');
    return pending.visible ? pending.view : undefined;
  }

  /** Only live protocol events call this; loading historical messages cannot acknowledge a send. */
  recorded(): void {
    const pending = this.pending;
    if (!pending || !this.sameSession(pending)) return;
    pending.accepted = true;
    this.images.accept(pending.submission);
    this.hide(pending);
    this.options.onChange();
  }

  async send(submission: ImageSubmission): Promise<void> {
    if (!this.images.stage(submission)) throw new Error(this.options.locale() === 'zh-CN'
      ? '草稿已更改，请重新发送。' : 'The draft changed. Please submit it again.');
    this.reset();
    const view = new Container();
    const status = new SendStatus('', 0, 0);
    view.addChild(new UserMessageComponent(submission.text, {
      images: submission.images.map(image => ({ type: 'image' as const, ...image })),
    }));
    view.addChild(status);
    const pending: PendingSend = { submission, session: this.backend.state.session?.id,
      file: this.backend.state.session?.file, view, status, accepted: false, finished: false, visible: true };
    this.pending = pending;
    this.options.onChange();
    try {
      await this.backend.send(submission.text, disposition => {
        if (this.pending !== pending || !this.sameSession(pending)) return;
        pending.accepted = true;
        this.images.accept(submission);
        // Extensions can handle a slash command without producing a conversation message.
        if (disposition === 'handled') this.hide(pending);
        this.options.onChange();
      }, submission.images);
    } finally {
      pending.finished = true;
      if (this.pending === pending) {
        if (!pending.accepted) {
          if (this.sameSession(pending)) this.options.onRecovery(this.images.restore(submission));
          this.reset();
        }
        this.options.onChange();
      }
    }
  }

  reset(): void {
    if (this.pending) this.hide(this.pending);
    this.pending = undefined;
  }
  private hide(pending: PendingSend): void {
    if (!pending.visible) return;
    pending.visible = false;
    pending.view.dispose();
  }
  private sameSession(pending: PendingSend): boolean {
    return pending.session === this.backend.state.session?.id && pending.file === this.backend.state.session?.file;
  }
}
