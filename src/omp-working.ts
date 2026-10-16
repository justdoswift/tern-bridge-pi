import { Text } from '@oh-my-pi/pi-tui/components/text';
import { describeWorkingRow } from '@oh-my-pi/pi-tui/components/loader';
import { col, node, EMPTY_NODE } from '@oh-my-pi/pi-tui/native/describe';
import type { DescribeContext, NativeNode } from '@oh-my-pi/pi-tui/native/node';
import type { BackendState, Locale } from './contracts.js';
import { dictionary } from './i18n.js';
import { PiWorkTracker, type WorkSnapshot } from './work-state.js';
import type { PiTodoHud } from './omp-todos.js';

/** Stock working row in the stock status-HUD slot, not another transcript phase label. */
export class PiWorkingHud extends Text {
  private readonly tracker = new PiWorkTracker();
  private snapshot: WorkSnapshot = { active: false };
  private locale: Locale | undefined;
  private label = '';
  private native: NativeNode | undefined;

  constructor(private readonly todos: PiTodoHud) { super('', 0, 0); }

  sync(state: BackendState, locale: Locale): void {
    const snapshot = this.tracker.sync(state);
    if (snapshot === this.snapshot && locale === this.locale) return;
    this.snapshot = snapshot;
    this.locale = locale;
    this.native = undefined;
    const t = dictionary(locale);
    this.label = !snapshot.active ? '' : snapshot.stage === 'stopping' ? t.stop
      : snapshot.stage === 'compaction' ? t.workingCompaction
      : snapshot.stage === 'retry' ? t.workingRetry
      : snapshot.step ?? (snapshot.stage === 'thinking' ? t.workingThinking : t.working);
    this.setText(this.label);
  }

  override describe(cx: DescribeContext): NativeNode {
    if (!this.snapshot.active) return this.todos.hasTasks()
      ? node('row', { role: 'omp.hud', justify: 'end', gap: 'sm' }, [this.todos]) : EMPTY_NODE;
    if (!this.native) {
      const original = describeWorkingRow({
        label: this.label, startedAt: this.snapshot.startedAt,
        ...(this.snapshot.stage === 'compaction' ? { variant: { kind: 'compaction' } as const } : {}),
      }, cx);
      const working: NativeNode = original.k === 'row'
        ? { ...original, p: { ...original.p, grow: 1, basis: 'content', min: { w: 0 } } } : original;
      this.native = col([
        node('row', { align: 'center', gap: 'sm', wrap: true }, [
          working,
          this.todos,
        ]),
      ], { role: 'omp.hud.status' });
    }
    return this.native;
  }
}
