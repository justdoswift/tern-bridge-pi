import { WelcomeComponent } from '@oh-my-pi/pi-tui/prompt/welcome';
import { Text } from '@oh-my-pi/pi-tui/components/text';
import { text } from '@oh-my-pi/pi-tui/native/describe';
import type { DescribeContext, NativeNode } from '@oh-my-pi/pi-tui/native/node';
import { hintsRow } from '@oh-my-pi/pi-tui/native/overlay';
import type { Locale } from './contracts.js';
import { dictionary } from './i18n.js';

/** Preserve the stock welcome card and hints, with an honest text-only Pi identity. */
export class PiWelcome extends WelcomeComponent {
  private sessionTitle = '';
  private readonly fallback = new Text('π  Pi', 0, 0);
  private projected?: { original: NativeNode; node: NativeNode };

  constructor(private locale: Locale) { super(''); }
  override get tip(): string { return dictionary(this.locale).welcomeHint; }

  sync(title: string, locale: Locale): void {
    if (title === this.sessionTitle && locale === this.locale) return;
    this.sessionTitle = title;
    this.locale = locale;
    this.fallback.setText(title ? `Pi · ${title}` : 'π  Pi');
    this.invalidate();
  }

  override invalidate(): void {
    super.invalidate();
    this.projected = undefined;
  }

  override render(width: number): readonly string[] { return this.fallback.render(width); }

  override describe(cx: DescribeContext): NativeNode {
    const original = super.describe(cx);
    if (this.projected?.original === original) return this.projected.node;
    const project = (source: NativeNode): NativeNode => {
      if (source.k === 'row' && source.p?.role === 'omp.welcome.lockup') return {
        ...source, p: { ...source.p, max: { w: 1 } },
        c: [text('π  Pi', { role: 'pi.welcome.wordmark' })],
      };
      if (source.k === 'text' && source.p?.role === 'omp.welcome.tip-text' && this.sessionTitle) return {
        ...source, p: { ...source.p, text: this.sessionTitle, spans: undefined },
      };
      const children = source.c?.filter(child => !this.sessionTitle || !('k' in child) || child.p?.role !== 'omp.welcome.tip-icon')
        .map(child => 'k' in child ? project(child) : child);
      return { ...source, ...(children ? { c: children } : {}) };
    };
    const t = dictionary(this.locale);
    const shortcuts = hintsRow([
      { keys: ['/'], label: t.welcomeCommands },
      { keys: ['enter'], label: t.send },
      { keys: ['shift+enter'], label: t.welcomeNewline },
      { keys: ['ctrl+o'], label: t.welcomeDetails },
      { keys: ['escape'], label: t.welcomeStop },
    ], 'shortcuts');
    const welcome = project(original);
    const shortcutRow: NativeNode = shortcuts.k === 'row'
      ? { ...shortcuts, p: { ...shortcuts.p, role: 'pi.welcome.shortcuts' } } : shortcuts;
    const result: NativeNode = { ...welcome, c: [...(welcome.c ?? []), shortcutRow] };
    this.projected = { original, node: result };
    return result;
  }
}
