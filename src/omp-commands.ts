import type { Locale, PiCommand } from './contracts.js';

const descriptions = {
  sessions: ['选择历史会话', 'Saved sessions'], new: ['新建会话', 'New session'], resume: ['按会话文件恢复', 'Resume by session file'],
  model: ['选择 Pi 模型', 'Select Pi model'], thinking: ['选择真实思考强度', 'Select thinking level'],
  rename: ['重命名会话', 'Rename session'], fork: ['从用户消息分叉', 'Fork from a user message'], clone: ['复制当前会话分支', 'Clone current session branch'],
  compact: ['压缩上下文（可能消耗模型额度）', 'Compact context (may use model quota)'], context: ['查看上下文总用量', 'Reported context usage'],
  retry: ['重新连接，不重发消息', 'Reconnect without replay'], language: ['中文 / English', '中文 / English'],
  help: ['会话操作', 'Conversation actions'], quit: ['关闭客户端', 'Close client'],
} as const;
export type BridgeCommand = keyof typeof descriptions;
export interface CommandEntry { name: string; description: string }
export type CommandRoute = { kind: 'local'; name: BridgeCommand; argument?: string } | { kind: 'remote' | 'message' | 'unknown' };

/** Pi discovery wins convenience aliases; bridge:* always remains available locally. */
export function commandEntries(locale: Locale, discovered: readonly PiCommand[]): CommandEntry[] {
  const remoteNames = new Set(discovered.map(command => command.name));
  const local = (Object.keys(descriptions) as BridgeCommand[]).flatMap(name => {
    const description = descriptions[name][locale === 'zh-CN' ? 0 : 1];
    return [{ name: `bridge:${name}`, description }, ...(remoteNames.has(name) ? [] : [{ name, description }])];
  });
  return [...discovered.filter(command => !command.name.startsWith('bridge:')).map(command => ({
    name: command.name, description: command.description ?? command.source,
  })), ...local];
}

/** Unknown slash commands never silently become a model prompt. */
export function routeCommand(message: string, discovered: readonly PiCommand[]): CommandRoute {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(message);
  if (!match) return { kind: 'message' };
  const name = match[1]!;
  const localName = name.startsWith('bridge:') ? name.slice(7) : name;
  if (!name.startsWith('bridge:') && discovered.some(command => command.name === name)) return { kind: 'remote' };
  if (Object.hasOwn(descriptions, localName)) return { kind: 'local', name: localName as BridgeCommand, argument: match[2] };
  return { kind: 'unknown' };
}
