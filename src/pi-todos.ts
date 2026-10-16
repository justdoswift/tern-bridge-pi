import type { TodoItem } from '@oh-my-pi/pi-tui/tools/todo';
import type { ChatMessage, MessageBlock } from './contracts.js';
import { record } from './transcript.js';

type ToolBlock = Extract<MessageBlock, { kind: 'tool' }>;

/** Only a structured result's explicit todos array is a checklist, never arguments or prose. */
export function parsePiTodos(details: unknown): TodoItem[] | undefined {
  const todos = record(details).todos;
  if (!Array.isArray(todos)) return undefined;
  const result: TodoItem[] = [];
  for (const entry of todos) {
    const item = record(entry);
    if (typeof item.content !== 'string' || !item.content.trim() ||
        (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed')) return undefined;
    result.push({ content: item.content, status: item.status });
  }
  return result;
}

/** A successful final extension result may update or explicitly clear previous tasks. */
export function latestPiTodo(messages: readonly ChatMessage[]): ToolBlock | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]!;
    if (message.role !== 'assistant') continue;
    for (let b = message.blocks.length - 1; b >= 0; b--) {
      const block = message.blocks[b]!;
      if (block.kind === 'tool' && block.status === 'done' && block.resultReceived && parsePiTodos(block.details) !== undefined) return block;
    }
  }
  return undefined;
}
