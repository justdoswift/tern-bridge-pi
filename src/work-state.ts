import type { BackendState, MessageBlock } from './contracts.js';
import { record } from './transcript.js';

type ToolBlock = Extract<MessageBlock, { kind: 'tool' }>;
export type WorkSnapshot = { readonly active: false } | {
  readonly active: true;
  readonly startedAt: number;
  readonly stage: 'tool' | 'thinking' | 'response' | 'compaction' | 'retry' | 'stopping';
  readonly step?: string;
};
const IDLE: WorkSnapshot = Object.freeze({ active: false });

export function isPiWorking(state: Pick<BackendState, 'session' | 'phase'>): boolean {
  return state.session !== null && (state.phase === 'running' || state.phase === 'stopping');
}

/** Observe current tools and visible replies, never hidden reasoning or historical execution time. */
export class PiWorkTracker {
  private sessionId: string | null | undefined;
  private startedAt: number | undefined;
  private lastTool?: ToolBlock;
  private lastArgs?: string;
  private lastName?: string;
  private toolStep?: string;
  private snapshot: WorkSnapshot = IDLE;

  sync(state: BackendState, now = Date.now()): WorkSnapshot {
    const sessionId = state.session?.id ?? null;
    if (sessionId !== this.sessionId || !['running', 'stopping', 'approval', 'question'].includes(state.phase)) {
      this.sessionId = sessionId;
      this.startedAt = undefined;
      this.lastTool = undefined;
      this.lastArgs = undefined;
      this.lastName = undefined;
      this.toolStep = undefined;
    }
    if (!isPiWorking(state)) return this.snapshot = IDLE;
    this.startedAt ??= now;
    let tool: ToolBlock | undefined;
    let latest: MessageBlock | undefined;
    let thinking = false;
    let liveReply = false;
    for (let m = state.messages.length - 1; m >= 0; m--) {
      const message = state.messages[m]!;
      if (message.role === 'user') break;
      if (message.role !== 'assistant') continue;
      if (!latest) {
        latest = message.blocks.at(-1);
        thinking = message.streaming === true && latest?.kind === 'thinking';
        liveReply = message.streaming !== undefined && latest?.kind === 'text';
      }
      for (let b = message.blocks.length - 1; b >= 0; b--) {
        const block = message.blocks[b]!;
        if (block.kind === 'tool' && block.status === 'running' && !block.resultReceived) { tool = block; break; }
      }
      if (tool) break;
    }
    if (tool && (tool !== this.lastTool || tool.args !== this.lastArgs || tool.name !== this.lastName)) {
      this.lastTool = tool;
      this.lastArgs = tool.args;
      this.lastName = tool.name;
      let summary: unknown;
      try {
        const args = record(JSON.parse(tool.args));
        summary = args.summary ?? (tool.name === 'bash' ? args.command : tool.name === 'grep' ? args.pattern : args.path);
      } catch { /* Partial arguments keep the real tool name. */ }
      this.toolStep = typeof summary === 'string' && summary.trim() ? `${tool.name} · ${summary}` : tool.name;
    }
    const stage = state.phase === 'stopping' ? 'stopping' : state.workingState === 'compacting_conversation' ? 'compaction'
      : state.workingState === 'retrying' ? 'retry' : tool ? 'tool' : thinking || state.workingState === 'thinking' ? 'thinking' : 'response';
    // A settled tool is no longer the current step; use only the latest visible reply.
    const step = stage === 'tool' ? this.toolStep
      : stage === 'response' && liveReply && latest?.kind === 'text' ? latest.text.trim().split(/\r?\n/, 1)[0] || undefined : undefined;
    const previous = this.snapshot;
    if (previous.active && previous.startedAt === this.startedAt && previous.stage === stage && previous.step === step) return previous;
    return this.snapshot = { active: true, startedAt: this.startedAt, stage, ...(step ? { step } : {}) };
  }
}
