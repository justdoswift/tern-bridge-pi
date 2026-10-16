import { Container, type Component, type TUI } from '@oh-my-pi/pi-tui/tui';
import { TranscriptContainer } from '@oh-my-pi/pi-tui/chrome/transcript-container';
import { UserMessageComponent } from '@oh-my-pi/pi-tui/chat/user-message';
import { SkillMessageComponent } from '@oh-my-pi/pi-tui/chat/skill-message';
import { AssistantMessageComponent } from '@oh-my-pi/pi-tui/chat/assistant-message';
import { ToolExecutionComponent } from '@oh-my-pi/pi-tui/chat/tool-execution';
import { Markdown, fencedCode } from '@oh-my-pi/pi-tui/components/markdown';
import { Disclosure } from '@oh-my-pi/pi-tui/components/disclosure';
import { Image } from '@oh-my-pi/pi-tui/components/image';
import { Text } from '@oh-my-pi/pi-tui/components/text';
import { nativeDiff, renderDiff } from '@oh-my-pi/pi-tui/chrome/diff';
import { describeCodeCell, renderCodeCell } from '@oh-my-pi/pi-tui/render/code-cell';
import { rootToggleExpanded, type DescribeContext, type NativeNode, type NativeUiEvent } from '@oh-my-pi/pi-tui/native/node';
import { ansi, code, col, keyed } from '@oh-my-pi/pi-tui/native/describe';
import { numberedCode } from '@oh-my-pi/pi-tui/tools/grouped-file-output';
import { fileRow } from '@oh-my-pi/pi-tui/tools/native-view';
import { ensureThemeSync, getLanguageFromPath, getMarkdownTheme, getThemeEpoch, theme } from '@oh-my-pi/pi-tui/theme';
import type { BackendState, ChatMessage, MessageBlock } from './contracts.js';
import { toolSourceParts, type ToolSourcePart } from './tool-source.js';
import { piSkillView } from './omp-skills.js';

type ToolBlock = Extract<MessageBlock, { kind: 'tool' }>;

/** Original tool chrome and controls, with display-only source metadata for Pi Read/Grep. */
class PiToolCard extends ToolExecutionComponent {
  expanded = false;
  private sourceArgs: unknown;
  private sourceOutput: string | undefined;
  private sourceError = false;
  private sourceParts: ToolSourcePart[] | undefined;
  private sourceBody: NativeNode[] | undefined;
  private projection: { original: NativeNode; node: NativeNode } | undefined;

  setSource(block: ToolBlock, args: unknown): void {
    const error = block.status === 'error';
    if (this.sourceArgs === args && this.sourceOutput === block.output && this.sourceError === error) return;
    this.sourceArgs = args;
    this.sourceOutput = block.output;
    this.sourceError = error;
    this.sourceParts = toolSourceParts(block, args, getLanguageFromPath);
    this.sourceBody = undefined;
    this.projection = undefined;
  }

  override describe(cx?: DescribeContext): NativeNode {
    const original = super.describe(cx);
    if (!this.sourceParts || original.k !== 'tool' || !original.c?.length || !cx?.supports('code')) return original;
    if (this.projection?.original === original) return this.projection.node;
    const body = this.sourceBody ??= this.sourceParts.flatMap<NativeNode>((part, index) => {
      if (part.kind === 'read') return [keyed(code(part.text, { lang: part.lang }), 'source')];
      if (part.kind === 'plain') return [keyed(ansi(part.lines.join('\n')), `notice-${index}`)];
      return [keyed(col([
        fileRow(part.path, { key: 'file' }),
        ...numberedCode(part.lines, { lang: part.lang }),
      ], { gap: 'xs', role: 'omp.tool.search.file' }), `source-${index}`)];
    });
    // Replace only the generic result child. Keep status, collapse, preview and trailing native children.
    const node: NativeNode = { ...original, c: [...body, ...original.c.slice(1)] };
    this.projection = { original, node };
    return node;
  }

  override setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    super.setExpanded(expanded);
  }
}

/** Adapter for omp's original code-cell renderer; no bridge-owned visual layout. */
class SharedCodeCell implements Component {
  private expanded = false;
  private native: NativeNode | undefined;
  private nativeEpoch = -1;
  private rows: readonly string[] | undefined;
  private rowsEpoch = -1;
  private width = 0;
  constructor(private source: string, private path?: string) {}
  update(source: string, path?: string): void {
    this.source = source;
    this.path = path;
    this.invalidate();
  }
  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.invalidate();
  }
  handleNativeEvent(event: NativeUiEvent): void {
    const expanded = rootToggleExpanded(event);
    if (expanded !== undefined) this.setExpanded(expanded);
  }
  describe(): NativeNode {
    const epoch = getThemeEpoch();
    if (!this.native || this.nativeEpoch !== epoch) {
      this.native = describeCodeCell({
        code: this.source, language: this.path ? getLanguageFromPath(this.path) : undefined,
        title: this.path, expanded: this.expanded,
      }, theme);
      this.nativeEpoch = epoch;
    }
    return this.native;
  }
  render(width: number): readonly string[] {
    const epoch = getThemeEpoch();
    if (!this.rows || this.width !== width || this.rowsEpoch !== epoch) {
      this.rows = renderCodeCell({
        code: this.source, language: this.path ? getLanguageFromPath(this.path) : undefined,
        title: this.path, expanded: this.expanded, width,
      }, theme);
      this.width = width;
      this.rowsEpoch = epoch;
    }
    return this.rows;
  }
  invalidate(): void {
    this.native = undefined;
    this.rows = undefined;
  }
}

/** Compact omp diffs use its native diff renderer; other formats stay lossless. */
class SharedDiff implements Component {
  private readonly fallback = new Markdown('', 0, 0, getMarkdownTheme());
  private readonly terminal = new Text('', 0, 0);
  private compact = false;
  private native: NativeNode | undefined;
  private ansiEpoch = -1;
  constructor(private source: string, private path?: string) { this.update(source, path); }
  update(source: string, path?: string): void {
    this.source = source;
    this.path = path;
    this.native = undefined;
    this.ansiEpoch = -1;
    this.compact = /[+\- ]\s*\d+\|/.test(source) && source.split('\n').every(line =>
      /^[+\- ]\s*\d+\|/.test(line) || /^\s*(?:…|\.\.\.)?\s*$/.test(line));
    // Preserve unified headers, hunk coordinates and any unrecognized format verbatim.
    if (!this.compact) this.fallback.setText(fencedCode('diff', source));
  }
  describe(cx: Parameters<Markdown['describe']>[0]): NativeNode {
    if (!this.compact) return this.fallback.describe(cx);
    this.native ??= nativeDiff(this.source, { filePath: this.path });
    return this.native;
  }
  render(width: number): readonly string[] {
    if (!this.compact) return this.fallback.render(width);
    // Do not pass a filesystem path to ANSI indentation resolution.
    const epoch = getThemeEpoch();
    if (this.ansiEpoch !== epoch) {
      this.terminal.setText(renderDiff(this.source, { theme }));
      this.ansiEpoch = epoch;
    }
    return this.terminal.render(width);
  }
  invalidate(): void {
    this.native = undefined;
    this.ansiEpoch = -1;
    this.fallback.invalidate();
    this.terminal.invalidate();
  }
  releaseRenderCaches(): void { this.fallback.releaseRenderCaches(); this.terminal.releaseRenderCaches(); }
}

function sameBlock(previous: MessageBlock, next: MessageBlock): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.kind === 'tool' && next.kind === 'tool') {
    return previous.name === next.name && previous.args === next.args && previous.output === next.output &&
      previous.status === next.status && previous.diff === next.diff && previous.details === next.details;
  }
  if (previous.kind === 'image' && next.kind === 'image') return previous.data === next.data && previous.mime === next.mime;
  return 'text' in previous && 'text' in next && previous.text === next.text && previous.path === next.path;
}

function toolArgs(source: string): unknown {
  try { return JSON.parse(source); } catch { return source; }
}

type OmpAssistantMessage = Parameters<AssistantMessageComponent['updateContent']>[0];
type AssistantText = Extract<MessageBlock, { text: string }> & { kind: 'text' | 'thinking' };
type AssistantContent = AssistantText | Extract<MessageBlock, { kind: 'image' }>;
const UNKNOWN_ASSISTANT_USAGE: Partial<OmpAssistantMessage['usage']> = Object.freeze({});

function isAssistantContent(block: MessageBlock): block is AssistantContent {
  return block.kind === 'text' || block.kind === 'thinking' || block.kind === 'image';
}

/** Content-only binding to the original message renderer, never an Agent/provider message. */
class PiAssistantMessage extends AssistantMessageComponent {
  seen = 0;
  private readonly snapshots: AssistantContent[] = [];
  private readonly content: OmpAssistantMessage['content'] = [];
  private readonly view: { role: 'assistant'; content: OmpAssistantMessage['content']; usage: Partial<OmpAssistantMessage['usage']>; model?: string; provider?: string } = {
    role: 'assistant', content: this.content, usage: UNKNOWN_ASSISTANT_USAGE,
  };
  private metadataKey = '';
  private live = false;

  constructor(ui: TUI, private readonly persistenceKey: string, expanded: boolean) {
    super(undefined, false, () => ui.requestRender(), undefined, ui.imageBudget, false, undefined, expanded);
    // Pi may retract or replace a partial: keep it revisable until the message settles.
    this.setMidStreamPublication(false);
  }

  override messagePersistenceKey(): string { return this.persistenceKey; }

  sync(message: ChatMessage, start: number, end: number, live: boolean, finalized: boolean): boolean {
    const blocks = message.blocks;
    const count = end - start;
    const metadataKey = JSON.stringify([message.usage, message.model, message.provider]);
    let changed = this.snapshots.length !== count || this.metadataKey !== metadataKey;
    if (this.metadataKey !== metadataKey) {
      this.metadataKey = metadataKey;
      this.view.usage = message.usage ?? UNKNOWN_ASSISTANT_USAGE;
      this.view.model = message.model;
      this.view.provider = message.provider;
    }
    for (let index = 0; index < count; index++) {
      // The caller has already bounded this contiguous run to the supported content kinds.
      const block = blocks[start + index] as AssistantContent;
      const previous = this.snapshots[index];
      if (previous && sameBlock(previous, block)) continue;
      this.snapshots[index] = { ...block };
      this.content[index] = block.kind === 'image' ? { type: 'image', data: block.data, mimeType: block.mime }
        : block.kind === 'thinking' ? { type: 'thinking', thinking: block.text }
        : { type: 'text', text: block.text };
      changed = true;
    }
    this.snapshots.length = count;
    this.content.length = count;
    if (!changed && this.live === live && (!finalized || this.isTranscriptBlockFinalized())) return false;
    this.live = live;
    // Keep actual reported metadata, while leaving unknown timestamps/costs absent.
    this.updateContent(this.view as OmpAssistantMessage, { transient: live });
    if (finalized && !this.isTranscriptBlockFinalized()) this.markTranscriptBlockFinalized();
    return true;
  }

  override setExpanded(expanded: boolean): void {
    super.setExpanded(expanded);
    this.setExpandThinkingBlocks(expanded);
  }
}

/** Retain the user's native expansion choice when Pi revises a text block. */
class PiSkillCard extends SkillMessageComponent {
  expanded = false;
  private readonly hasArgs: boolean;
  private projection: { original: NativeNode; node: NativeNode } | undefined;
  constructor(message: ConstructorParameters<typeof SkillMessageComponent>[0]) {
    super(message);
    this.hasArgs = Boolean(message.details?.args?.trim());
  }
  override describe(): NativeNode {
    const original = super.describe();
    if (!this.hasArgs || this.expanded || original.k !== 'card') return original;
    if (this.projection?.original === original) return this.projection.node;
    // The stock component omits the loaded body while collapsed. Preview only
    // its remaining argument child so native card folding doesn't hide the draft.
    const node: NativeNode = { ...original, p: { ...original.p, preview: { lines: 3 } } };
    this.projection = { original, node };
    return node;
  }
  override setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    super.setExpanded(expanded);
  }
}

/** One stable backend block slot, retaining the shared components while it streams. */
class PiBlock extends Container {
  seen = 0;
  private snapshot: MessageBlock | undefined;
  private markdown: Markdown | undefined;
  private thinking: Disclosure | undefined;
  private code: SharedCodeCell | undefined;
  private tool: PiToolCard | undefined;
  private skill: PiSkillCard | undefined;
  private toolInput: unknown;
  private diff: SharedDiff | undefined;
  private live = false;
  private expanded = false;
  private imageRevision = 0;
  private currentImageKey: string | undefined;
  constructor(private readonly ui: TUI, private readonly cwd: string, private readonly role: ChatMessage['role'],
    private readonly imageKey: string, expanded: boolean) {
    super();
    this.expanded = expanded;
  }

  sync(block: MessageBlock, live: boolean): boolean {
    const previous = this.snapshot;
    const changed = !previous || !sameBlock(previous, block);
    if (!changed && this.live === live) return false;
    const reconstruct = !previous || previous.kind !== block.kind ||
      (previous.kind === 'tool' && block.kind === 'tool' &&
        (previous.name !== block.name || previous.status === 'interrupted' && block.status !== 'interrupted'));
    if (reconstruct) {
      // A sealed interrupted card cannot become live again. Preserve its native expansion choice.
      this.expanded = this.tool?.expanded ?? this.thinking?.expanded ?? this.skill?.expanded ?? this.expanded;
      if (this.currentImageKey) {
        this.ui.imageBudget.release(this.currentImageKey);
        this.currentImageKey = undefined;
      }
      this.disposeChildren();
      this.markdown = undefined;
      this.thinking = undefined;
      this.code = undefined;
      this.tool = undefined;
      this.skill = undefined;
      this.diff = undefined;
    }
    if (block.kind === 'tool') this.syncTool(block, previous?.kind === 'tool' ? previous : undefined);
    else if (block.kind === 'image') {
      if (changed) {
        this.disposeChildren();
        if (this.currentImageKey) this.ui.imageBudget.release(this.currentImageKey);
        this.currentImageKey = `${this.imageKey}:${++this.imageRevision}`;
        this.addChild(new Image(block.data, block.mime, { fallbackColor: text => theme.fg('dim', text) }, {
          imageKey: this.currentImageKey, budget: this.ui.imageBudget, requestRender: () => this.ui.requestRender(),
        }));
      }
    } else if (block.kind === 'code') {
      if (!this.code) { this.code = new SharedCodeCell(block.text, block.path); this.code.setExpanded(this.expanded); this.addChild(this.code); }
      else if (changed) this.code.update(block.text, block.path);
    } else if (block.kind === 'diff') {
      if (!this.diff) { this.diff = new SharedDiff(block.text, block.path); this.addChild(this.diff); }
      else if (changed) this.diff.update(block.text, block.path);
    } else if (block.kind === 'thinking') {
      if (!this.markdown) {
        this.markdown = new Markdown(block.text, 1, 0, getMarkdownTheme());
        const body = this.markdown;
        this.thinking = new Disclosure({ summary: new Text('Thinking', 0, 0), body: () => body, expanded: this.expanded });
        this.addChild(this.thinking);
      } else if (changed) this.markdown.setText(block.text);
      this.markdown.transientRenderCache = live;
    } else if (this.role === 'user') {
      // Project only the canonical skill wrapper; source text/IDs remain untouched.
      if (changed) {
        this.expanded = this.skill?.expanded ?? this.expanded;
        this.disposeChildren();
        const skill = piSkillView(block.text);
        this.skill = skill ? new PiSkillCard(skill) : undefined;
        this.skill?.setExpanded(this.expanded);
        this.addChild(this.skill ?? new UserMessageComponent(block.text));
      }
    } else {
      if (!this.markdown) { this.markdown = new Markdown(block.text, 1, 0, getMarkdownTheme()); this.addChild(this.markdown); }
      else if (changed) this.markdown.setText(block.text);
      this.markdown.transientRenderCache = live;
    }
    // Backend objects are mutated in place. Retain scalar values, not their object identity.
    if (changed) this.snapshot = { ...block };
    this.live = live;
    return true;
  }

  private syncTool(block: ToolBlock, previous?: ToolBlock): void {
    if (!this.tool || block.args !== previous?.args) this.toolInput = toolArgs(block.args);
    if (!this.tool) {
      // Pi tool names are not omp built-in implementations. Disable their renderer registry:
      // in particular never compute edit previews by reading this host's working tree.
      this.tool = new PiToolCard(block.name, this.toolInput, { useBuiltInRenderer: false }, undefined,
        this.ui, this.cwd, block.id);
      this.tool.setExpanded(this.expanded);
      this.addChild(this.tool);
    } else if (block.args !== previous?.args) this.tool.updateArgs(this.toolInput, block.id);
    this.tool.setSource(block, this.toolInput);
    if (!previous || previous.output !== block.output || previous.status !== block.status || previous.details !== block.details || !this.snapshot ||
      previous.name !== block.name || previous.status === 'interrupted' && block.status !== 'interrupted') {
      // Partial frames express running without inventing a start time/elapsed duration.
      this.tool.updateResult({ content: [{ type: 'text', text: block.output }], details: block.details, isError: block.status === 'error' },
        block.status === 'running' || block.status === 'interrupted', block.id);
      if (block.status === 'interrupted') this.tool.seal();
    }
    if (block.diff !== undefined) {
      if (!this.diff) { this.diff = new SharedDiff(block.diff); this.addChild(this.diff); }
      else if (block.diff !== previous?.diff) this.diff.update(block.diff);
    } else if (this.diff) { this.removeChild(this.diff); this.diff = undefined; }
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.tool?.setExpanded(expanded);
    this.thinking?.setExpanded(expanded);
    this.code?.setExpanded(expanded);
    this.skill?.setExpanded(expanded);
  }

  override dispose(): void {
    if (this.currentImageKey) {
      this.ui.imageBudget.release(this.currentImageKey);
      this.currentImageKey = undefined;
    }
    super.dispose();
  }
}

interface MessageEntry {
  role: ChatMessage['role'];
  container: Container;
  blocks: Map<string, PiBlock | PiAssistantMessage>;
  seen: number;
}

/** Genuine omp transcript components, reconciled against Pi's authoritative identities. */
export class PiTranscript {
  readonly container = new TranscriptContainer();
  private readonly messages = new Map<string, MessageEntry>();
  private sessionId: string | null | undefined;
  private generation = 0;
  private epoch = 0;
  private expanded = false;
  private disposed = false;

  constructor(private readonly ui: TUI, private readonly cwd: string) { ensureThemeSync(); }

  sync(state: BackendState, pending?: Component): void {
    if (this.disposed) return;
    const sessionId = state.session?.id ?? null;
    if (this.sessionId !== sessionId) {
      this.clear();
      this.sessionId = sessionId;
      this.generation++;
      this.ui.requestRender();
    }
    const epoch = ++this.epoch;
    let messageIndex = 0;
    let order: Component[] | undefined;
    const last = state.messages.at(-1);
    for (const message of state.messages) {
      let entry = this.messages.get(message.id);
      if (entry && entry.role !== message.role) {
        entry.container.dispose();
        this.messages.delete(message.id);
        entry = undefined;
      }
      if (!entry) {
        entry = { role: message.role, container: new Container(), blocks: new Map(), seen: epoch };
        this.messages.set(message.id, entry);
      }
      entry.seen = epoch;
      const live = state.needsInterrupt && message === last && message.streaming === true;
      let blockIndex = 0;
      let blockOrder: Component[] | undefined;
      for (let sourceIndex = 0; sourceIndex < message.blocks.length;) {
        const block = message.blocks[sourceIndex]!;
        const assistant = message.role === 'assistant' && isAssistantContent(block);
        const key = assistant ? `assistant:${sourceIndex === 0 ? '' : message.blocks[sourceIndex - 1]!.id}` : `block:${block.id}`;
        let component = entry.blocks.get(key);
        let changed: boolean;
        if (assistant) {
          const start = sourceIndex++;
          while (sourceIndex < message.blocks.length && isAssistantContent(message.blocks[sourceIndex]!)) sourceIndex++;
          if (!(component instanceof PiAssistantMessage)) {
            component?.dispose();
            component = new PiAssistantMessage(this.ui, JSON.stringify([sessionId, message.id, key]), this.expanded);
            entry.blocks.set(key, component);
          }
          changed = component.sync(message, start, sourceIndex,
            live && sourceIndex === message.blocks.length, message.streaming === undefined || sourceIndex < message.blocks.length);
        } else {
          sourceIndex++;
          if (!(component instanceof PiBlock)) {
            component?.dispose();
            component = new PiBlock(this.ui, state.session?.cwd || this.cwd, message.role,
              JSON.stringify([this.generation, sessionId, message.id, block.id]), this.expanded);
            entry.blocks.set(key, component);
          }
          changed = component.sync(block, live);
        }
        component.seen = epoch;
        if (changed) this.ui.requestComponentRender(component);
        if (!blockOrder && entry.container.children[blockIndex] !== component) blockOrder = entry.container.children.slice(0, blockIndex);
        blockOrder?.push(component);
        blockIndex++;
      }
      for (const [id, component] of entry.blocks) {
        if (component.seen !== epoch) { component.dispose(); entry.blocks.delete(id); }
      }
      if (blockOrder || entry.container.children.length !== blockIndex) {
        entry.container.children = blockOrder ?? entry.container.children.slice(0, blockIndex);
        this.ui.requestComponentRender(entry.container);
      }
      if (!order && this.container.children[messageIndex] !== entry.container) order = this.container.children.slice(0, messageIndex);
      order?.push(entry.container);
      messageIndex++;
    }
    for (const [id, entry] of this.messages) {
      if (entry.seen !== epoch) { entry.container.dispose(); this.messages.delete(id); }
    }
    if (pending) {
      if (!order && this.container.children[messageIndex] !== pending) order = this.container.children.slice(0, messageIndex);
      order?.push(pending);
      messageIndex++;
    }
    if (order || this.container.children.length !== messageIndex) {
      this.container.children = order ?? this.container.children.slice(0, messageIndex);
      this.ui.requestRender();
    }
  }

  setExpanded(expanded: boolean): void {
    if (this.disposed) return;
    this.expanded = expanded;
    for (const entry of this.messages.values()) for (const component of entry.blocks.values()) component.setExpanded(expanded);
    this.ui.requestRender();
  }

  private clear(): void {
    for (const entry of this.messages.values()) entry.container.dispose();
    this.messages.clear();
    this.container.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }
}
