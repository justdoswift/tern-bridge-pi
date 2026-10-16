import type { ChatMessage, MessageBlock, MessageUsage } from './contracts.js';

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function messageUsage(value: unknown): MessageUsage | undefined {
  const usage = record(value);
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const;
  if (!fields.every(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]))) return undefined;
  const cost = record(usage.cost);
  return {
    input: usage.input as number, output: usage.output as number, cacheRead: usage.cacheRead as number,
    cacheWrite: usage.cacheWrite as number, totalTokens: usage.totalTokens as number,
    ...(['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(key => typeof cost[key] === 'number' && Number.isFinite(cost[key]))
      ? { cost: { input: cost.input as number, output: cost.output as number, cacheRead: cost.cacheRead as number,
        cacheWrite: cost.cacheWrite as number, total: cost.total as number } } : {}),
  };
}
function serial(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === undefined ? '' : JSON.stringify(value);
}
function messageKey(value: Record<string, unknown>): string {
  return `${String(value.role)}:${String(value.timestamp)}:${typeof value.toolCallId === 'string' ? value.toolCallId : ''}`;
}

/** Follow the authoritative leaf, never append order, which also contains abandoned branches. */
export function activeBranch(entries: readonly unknown[], leafId: unknown): Record<string, unknown>[] {
  if (leafId === null) return [];
  if (typeof leafId !== 'string') throw new Error('Pi did not report the active session branch.');
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of entries) { const entry = record(raw); if (typeof entry.id === 'string') byId.set(entry.id, entry); }
  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let id: string | null = leafId;
  while (id !== null) {
    if (visited.has(id)) throw new Error('Pi reported a cyclic session branch.');
    visited.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error('Pi reported an incomplete session branch.');
    branch.push(entry);
    if (entry.parentId !== null && typeof entry.parentId !== 'string') throw new Error('Pi reported an invalid session parent.');
    id = entry.parentId as string | null;
  }
  return branch.reverse();
}

/** Mirrors Pi 1.2.0 buildContextEntries, which native interactive mode uses for its visible transcript. */
export function visibleBranch(entries: readonly unknown[], leafId: unknown): Record<string, unknown>[] {
  return selectVisibleBranch(activeBranch(entries, leafId));
}

function selectVisibleBranch(branch: Record<string, unknown>[]): Record<string, unknown>[] {
  const index = branch.findLastIndex(entry => entry.type === 'compaction');
  if (index < 0) return branch;
  const compaction = branch[index]!;
  const firstKept = branch.findIndex((entry, position) => position < index && entry.id === compaction.firstKeptEntryId);
  const retained = firstKept < 0 ? [] : branch.slice(firstKept, index).filter(entry => !(entry.type === 'message' && record(entry.message).role === 'system'));
  return [compaction, ...retained, ...branch.slice(index + 1)];
}

export class Transcript {
  messages: ChatMessage[] = [];
  private readonly identities = new Map<string, string[]>();
  private readonly current = new Map<string, string>();
  private readonly persisted = new Set<string>();
  private readonly persistedTools = new Set<string>();
  private counter = 0;
  private liveAssistant: string | null = null;

  hydrate(entries: readonly unknown[], leafId: unknown, runtimeMessages: readonly unknown[] = []): void {
    const branch = activeBranch(entries, leafId);
    const visible = selectVisibleBranch(branch);
    this.messages = []; this.identities.clear(); this.current.clear(); this.persisted.clear(); this.persistedTools.clear(); this.liveAssistant = null;
    const visibleIds = new Set(visible.map(entry => entry.id));
    const compactionId = visible[0]?.type === 'compaction' ? visible[0].id : null;
    const summaries: { id: string; message: Record<string, unknown> }[] = [];
    const selected: { id: string; message: Record<string, unknown> }[] = [];
    for (const entry of branch) {
      let message: Record<string, unknown> | null = null;
      if (entry.type === 'message') message = record(entry.message);
      else if (entry.type === 'custom_message') message = { ...entry, role: 'custom', timestamp: Date.parse(String(entry.timestamp)) };
      else if (entry.type === 'compaction' || entry.type === 'branch_summary') message = {
        role: entry.type === 'compaction' ? 'compactionSummary' : 'branchSummary', summary: entry.summary, timestamp: Date.parse(String(entry.timestamp)),
      };
      if (!message) continue;
      this.persisted.add(messageKey(message));
      if (message.role === 'toolResult' && typeof message.toolCallId === 'string') this.persistedTools.add(message.toolCallId);
      if (Array.isArray(message.content)) for (const value of message.content) {
        const block = record(value); if (block.type === 'toolCall' && typeof block.id === 'string') this.persistedTools.add(block.id);
      }
      if (!visibleIds.has(entry.id)) continue;
      const source = { id: String(entry.id), message };
      if (entry.type === 'compaction' && compactionId === entry.id) summaries.push(source);
      else selected.push(source);
    }
    // Native initial rendering prepends the latest compaction, followed by its retained raw entries.
    for (const source of [...summaries, ...selected]) this.snapshot(source.message, source.id, false);
    // get_messages is runtime/model context, not visible authored history. It can additionally contain unpersisted messages.
    for (const value of runtimeMessages) {
      const message = record(value);
      const key = messageKey(message);
      if (!this.persisted.has(key)) this.snapshot(message, `context:${key}:${++this.counter}`, false);
    }
    this.settle();
  }

  /** Replay fast bootstrap events without appending deltas to already authoritative final snapshots. */
  replay(events: readonly Record<string, unknown>[]): void {
    let suppressAssistant = false;
    for (const event of events) {
      const message = record(event.message);
      if (event.type === 'message_start') {
        const exists = this.persisted.has(messageKey(message)) || this.identities.has(messageKey(message));
        if (message.role === 'assistant') suppressAssistant = exists;
        if (exists) continue;
      }
      if (event.type === 'message_update' && suppressAssistant) continue;
      if (event.type === 'message_end') {
        const exists = this.persisted.has(messageKey(message)) || (!this.current.has(String(message.role)) && this.identities.has(messageKey(message)));
        if (message.role === 'assistant') suppressAssistant = false;
        if (exists) continue;
      }
      if (typeof event.toolCallId === 'string' && this.persistedTools.has(event.toolCallId)) {
        const target = this.findTool(event.toolCallId);
        if (!target || event.type === 'tool_execution_start' && target.block.resultReceived) continue;
      }
      this.apply(event);
    }
  }

  apply(event: Record<string, unknown>): void {
    const message = record(event.message);
    if (event.type === 'message_start') {
      const key = messageKey(message);
      const id = `live:${++this.counter}:${key}`;
      this.current.set(String(message.role), id);
      if (message.role === 'assistant') {
        this.liveAssistant = id;
        for (const key of this.current.keys()) if (key.startsWith('block:')) this.current.delete(key);
      }
      this.snapshot(message, id, message.role === 'assistant');
    } else if (event.type === 'message_end') {
      const key = messageKey(message);
      const id = this.current.get(String(message.role)) ?? this.identities.get(key)?.at(-1) ?? `live:${++this.counter}:${key}`;
      this.snapshot(message, id, false);
      this.current.delete(String(message.role));
      if (message.role === 'assistant') this.liveAssistant = null;
    } else if (event.type === 'message_update') this.update(record(event.assistantMessageEvent), event.usage);
    else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId : '';
      if (!id) return;
      let target = this.findTool(id);
      if (!target) {
        const owner: ChatMessage = { id: `tool:${id}`, role: 'assistant', blocks: [{ id, kind: 'tool', name: String(event.toolName ?? ''), args: serial(event.args), output: '', status: 'running' }] };
        this.messages.push(owner); target = { owner, block: owner.blocks[0] as Extract<MessageBlock, { kind: 'tool' }> };
      }
      if (event.type === 'tool_execution_start') {
        target.block.name = String(event.toolName ?? target.block.name); target.block.args = serial(event.args); target.block.status = 'running';
      } else this.toolResult(id, record(event.type === 'tool_execution_end' ? event.result : event.partialResult),
        event.type === 'tool_execution_end', event.isError === true);
    } else if (event.type === 'agent_settled') this.settle();
  }

  settle(): void {
    for (const message of this.messages) {
      delete message.streaming;
      for (const block of message.blocks) if (block.kind === 'tool' && block.status === 'running') block.status = 'interrupted';
    }
    this.current.clear(); this.liveAssistant = null;
  }

  private snapshot(raw: Record<string, unknown>, id: string, streaming: boolean): void {
    if (!['user', 'assistant', 'toolResult', 'bashExecution', 'custom', 'branchSummary', 'compactionSummary'].includes(String(raw.role))) return;
    if (raw.role === 'toolResult') {
      this.toolResult(String(raw.toolCallId ?? ''), raw, true, raw.isError === true); return;
    }
    if (raw.role === 'custom' && raw.display === false) return;
    const role = raw.role === 'user' ? 'user' : raw.role === 'assistant' ? 'assistant' : 'system';
    if (raw.role === 'bashExecution') {
      this.replace({ id, role: 'system', blocks: [{ id: `${id}:bash`, kind: 'tool', name: 'bash', args: serial({ command: raw.command }),
        output: typeof raw.output === 'string' ? raw.output : '', status: raw.cancelled ? 'interrupted' : raw.exitCode === 0 ? 'done' : 'error', resultReceived: true }] });
      return;
    }
    const previous = this.messages.find(item => item.id === id);
    const content = typeof raw.content === 'string' ? [{ type: 'text', text: raw.content }] : Array.isArray(raw.content) ? raw.content : [];
    const blocks: MessageBlock[] = [];
    for (let index = 0; index < content.length; index++) {
      const block = record(content[index]);
      const blockId = `${id}:${index}`;
      if (block.type === 'text' || block.type === 'code' || block.type === 'diff') blocks.push({ id: blockId, kind: block.type, text: typeof block.text === 'string' ? block.text : '', ...(typeof block.path === 'string' ? { path: block.path } : {}) });
      else if (block.type === 'thinking') blocks.push({ id: blockId, kind: 'thinking', text: typeof block.thinking === 'string' ? block.thinking : '' });
      else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') blocks.push({ id: blockId, kind: 'image', data: block.data, mime: block.mimeType });
      else if (block.type === 'toolCall' && typeof block.id === 'string') {
        const old = previous?.blocks.find(item => item.kind === 'tool' && item.id === block.id);
        blocks.push({ id: block.id, kind: 'tool', name: typeof block.name === 'string' ? block.name : '', args: serial(block.arguments), output: old?.kind === 'tool' ? old.output : '',
          status: old?.kind === 'tool' ? old.status : 'running', ...(old?.kind === 'tool' && old.resultReceived ? { resultReceived: true as const } : {}),
          ...(old?.kind === 'tool' && old.details !== undefined ? { details: old.details } : {}), ...(old?.kind === 'tool' && old.diff ? { diff: old.diff } : {}) });
      }
    }
    if (raw.role === 'branchSummary' || raw.role === 'compactionSummary') blocks.push({ id: `${id}:summary`, kind: 'text', text: typeof raw.summary === 'string' ? raw.summary : '' });
    // Preserve results/images already correlated to tool calls when the final assistant snapshot replaces deltas.
    if (previous) blocks.push(...previous.blocks.filter(block => block.id.startsWith('tool-image:')));
    if (raw.role === 'assistant' && raw.stopReason === 'error') blocks.push({ id: `${id}:error`, kind: 'text', text: 'Pi could not complete this response.' });
    const usage = messageUsage(raw.usage);
    const result: ChatMessage = { id, role, blocks, ...(streaming ? { streaming: true } : {}),
      ...(usage ? { usage } : {}),
      ...(typeof raw.model === 'string' ? { model: raw.model } : {}), ...(typeof raw.provider === 'string' ? { provider: raw.provider } : {}) };
    if (blocks.length || role === 'assistant') this.replace(result);
    const key = messageKey(raw);
    const ids = this.identities.get(key) ?? [];
    if (!ids.includes(id)) { ids.push(id); this.identities.set(key, ids); }
  }
  private replace(message: ChatMessage): void {
    const index = this.messages.findIndex(item => item.id === message.id);
    if (index === -1) this.messages.push(message); else this.messages[index] = message;
  }
  private findTool(id: string): { owner: ChatMessage; block: Extract<MessageBlock, { kind: 'tool' }> } | undefined {
    for (const owner of this.messages) for (const block of owner.blocks) if (block.kind === 'tool' && block.id === id) return { owner, block };
    return undefined;
  }
  private toolResult(id: string, result: Record<string, unknown>, final: boolean, error: boolean): void {
    if (!id) return;
    let target = this.findTool(id);
    if (!target) {
      const block: Extract<MessageBlock, { kind: 'tool' }> = { id, kind: 'tool', name: typeof result.toolName === 'string' ? result.toolName : '', args: '', output: '', status: 'running' };
      const owner: ChatMessage = { id: `tool:${id}`, role: 'assistant', blocks: [block] };
      this.messages.push(owner); target = { owner, block };
    }
    if (!final && target.block.resultReceived) return;
    const content = Array.isArray(result.content) ? result.content.map(record) : [];
    target.block.output = content.filter(block => block.type === 'text').map(block => typeof block.text === 'string' ? block.text : '').join('\n');
    target.block.details = result.details;
    const details = record(result.details);
    if (typeof details.diff === 'string') target.block.diff = details.diff; else delete target.block.diff;
    if (final) { target.block.status = error ? 'error' : 'done'; target.block.resultReceived = true; }
    const prefix = `tool-image:${id}:`;
    target.owner.blocks = target.owner.blocks.filter(block => !block.id.startsWith(prefix));
    content.forEach((block, index) => {
      if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') target!.owner.blocks.push({ id: `${prefix}${index}`, kind: 'image', data: block.data, mime: block.mimeType });
    });
  }
  private update(event: Record<string, unknown>, usage: unknown): void {
    const message = this.messages.find(item => item.id === this.liveAssistant);
    if (!message) return;
    const latestUsage = messageUsage(usage); if (latestUsage) message.usage = latestUsage;
    if (event.type === 'done' || event.type === 'error') { this.snapshot(record(event.type === 'done' ? event.message : event.error), message.id, false); return; }
    if (typeof event.contentIndex !== 'number' || !Number.isSafeInteger(event.contentIndex) || event.contentIndex < 0) return;
    const id = `${message.id}:${event.contentIndex}`;
    let index = message.blocks.findIndex(block => block.id === id || (block.kind === 'tool' && block.id === event.id));
    if (event.type === 'text_start' || event.type === 'thinking_start') {
      if (index === -1) message.blocks.push({ id, kind: event.type === 'text_start' ? 'text' : 'thinking', text: '' });
    } else if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'text_end' || event.type === 'thinking_end') {
      if (index === -1) { message.blocks.push({ id, kind: String(event.type).startsWith('text') ? 'text' : 'thinking', text: '' }); index = message.blocks.length - 1; }
      const block = message.blocks[index];
      if (block && (block.kind === 'text' || block.kind === 'thinking')) block.text = String(event.type).endsWith('_end')
        ? typeof event.content === 'string' ? event.content : '' : block.text + (typeof event.delta === 'string' ? event.delta : '');
    } else if (event.type === 'toolcall_start') {
      if (index === -1) message.blocks.push({ id: typeof event.id === 'string' ? event.id : id, kind: 'tool', name: String(event.toolName ?? ''), args: '', output: '', status: 'running' });
      this.current.set(`block:${event.contentIndex}`, typeof event.id === 'string' ? event.id : id);
    } else if (event.type === 'toolcall_delta' || event.type === 'toolcall_end') {
      const toolId = this.current.get(`block:${event.contentIndex}`);
      const tool = message.blocks.find(block => block.kind === 'tool' && block.id === toolId);
      if (tool?.kind !== 'tool') return;
      if (event.type === 'toolcall_delta') tool.args += typeof event.delta === 'string' ? event.delta : '';
      else { const call = record(event.toolCall); tool.id = typeof call.id === 'string' ? call.id : tool.id; tool.name = typeof call.name === 'string' ? call.name : tool.name; tool.args = serial(call.arguments); }
    }
    // A completed block is a settled gap, not evidence the whole run is idle.
    message.streaming = String(event.type).endsWith('_delta') || String(event.type).endsWith('_start');
  }
}
