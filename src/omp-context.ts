import { Text } from '@oh-my-pi/pi-tui/components/text';
import { ReportPanel } from '@oh-my-pi/pi-tui/overlays/report-panel';
import { actionBar, actionButton } from '@oh-my-pi/pi-tui/native/overlay';
import { col, node, text } from '@oh-my-pi/pi-tui/native/describe';
import type { NativeNode, NativeUiEvent } from '@oh-my-pi/pi-tui/native/node';
import type { Component } from '@oh-my-pi/pi-tui/tui';
import type { ContextDetails, Locale } from './contracts.js';
import { dictionary } from './i18n.js';

/** Pi's reported aggregate only: lifetime billing is not current context occupancy. */
export class PiContextView extends Text {
  private readonly native: NativeNode;
  constructor(details: ContextDetails, locale: Locale) {
    const t = dictionary(locale);
    const count = (value: number) => value.toLocaleString(locale);
    const estimate = details.used === null ? t.unknown : count(details.used);
    const capacity = details.limit > 0 ? count(details.limit) : t.unknown;
    const percentage = details.percent === null ? t.unknown : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(details.percent)}%`;
    const policy = details.autoCompactionEnabled === undefined ? t.unknown : details.autoCompactionEnabled ? t.enabled : t.disabled;
    const lines = [
      `${t.contextAggregate}: ${estimate} (${percentage})`, `${t.contextCapacity}: ${capacity}`,
      `${t.autoCompaction}: ${policy}`, ...(details.used === null ? [t.contextUnavailable] : []), t.contextPolicy,
    ];
    super(lines.join('\n'), 0, 0);
    this.native = col([
      node('meter', { role: 'pi.context.aggregate', style: 'bar', aria: t.context,
        value: details.percent === null ? null : Math.max(0, Math.min(1, details.percent / 100)), label: percentage }),
      ...lines.map(line => text(line)),
    ], { gap: 'md' });
  }
  override describe(): NativeNode { return this.native; }
}

export class PiContextLoading extends Text {
  private readonly native: NativeNode;
  constructor(locale: Locale) {
    const label = dictionary(locale).contextLoading;
    super(label, 0, 0);
    this.native = node('row', { gap: 'sm', align: 'center' }, [node('spinner', {}), text(label)]);
  }
  override describe(): NativeNode { return this.native; }
}

/** Keep the original report's scrolling, focus and Close/Escape behavior. */
export class PiContextReport extends ReportPanel {
  private projected?: { original: NativeNode; node: NativeNode };
  constructor(title: string, body: Component, private readonly locale: Locale, close: () => void, private readonly retry?: () => void) {
    super({ title, body, closeKey: 'Esc', onClose: close });
    this.holdFocus();
  }
  override describe(): NativeNode {
    const original = super.describe();
    if (this.projected?.original === original) return this.projected.node;
    const t = dictionary(this.locale);
    const projected: NativeNode = { ...original, c: [original.c![0]!,
      actionBar([...(this.retry ? [actionButton(t.retry, 'context.retry')] : []), null,
        actionButton(t.close, 'close', { keys: 'escape' })]),
    ] };
    this.projected = { original, node: projected };
    return projected;
  }
  override handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === 'action' && event.act === 'context.retry') this.retry?.();
    else super.handleNativeEvent(event);
  }
}
