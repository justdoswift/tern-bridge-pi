import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { SessionSummary } from './contracts.js';
import { record } from './transcript.js';

export interface SessionHeader { id: string; cwd: string; path: string }
export interface SessionDirectories { cwd: string; sessionDir?: string; agentDir?: string }
export function expandPath(path: string): string {
  return resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
}
export function sessionDirectory(options: SessionDirectories): string {
  const explicit = options.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR;
  if (explicit) return expandPath(explicit);
  const agentDir = expandPath(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'));
  return join(agentDir, 'sessions', `--${resolve(options.cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
}

/** LF-only iteration also preserves U+2028/U+2029 in session names and messages. */
async function* sessionRecords(path: string): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(path);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const parse = (line: string): Record<string, unknown> | null => {
    try { const value = record(JSON.parse(line)); return typeof value.type === 'string' ? value : null; }
    catch { return null; } // Official discovery skips malformed entries, including interrupted trailing writes.
  };
  try {
    for await (const chunk of stream) {
      buffer += decoder.write(chunk as Buffer);
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        const value = parse(line); if (value) yield value;
      }
    }
    buffer += decoder.end();
    const value = parse(buffer); if (value) yield value;
  } finally { stream.destroy(); }
}

export async function readSessionHeader(path: string): Promise<SessionHeader> {
  const actualPath = await realpath(expandPath(path));
  for await (const entry of sessionRecords(actualPath)) {
    if (entry.type !== 'session' || typeof entry.id !== 'string' || !entry.id ||
      typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd)) break;
    const cwdStats = await stat(entry.cwd);
    if (!cwdStats.isDirectory()) throw new Error('The saved Pi working directory is not a directory.');
    return { id: entry.id, cwd: entry.cwd, path: actualPath };
  }
  throw new Error('The selected file is not a valid Pi session.');
}

export async function listPiSessions(options: SessionDirectories, all: boolean): Promise<SessionSummary[]> {
  const explicit = options.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR;
  const agentDir = expandPath(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'));
  let directories: string[];
  if (explicit || !all) directories = [sessionDirectory(options)];
  else {
    const root = join(agentDir, 'sessions');
    try {
      directories = (await readdir(root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => join(root, entry.name));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      throw new Error('Cannot read the Pi session directory.');
    }
  }
  const results: SessionSummary[] = [];
  // Bound open files without retaining entire author transcripts in memory.
  for (const directory of directories) {
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
      throw new Error('Cannot read the Pi session directory.');
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(directory, name);
      try {
        const stats = await stat(path);
        if (!stats.isFile()) continue;
        let header: Record<string, unknown> | undefined;
        let title: string | undefined;
        let firstMessage = '';
        let activity = 0;
        for await (const entry of sessionRecords(path)) {
          if (!header) {
            if (entry.type !== 'session' || typeof entry.id !== 'string' || typeof entry.cwd !== 'string') break;
            header = entry; continue;
          }
          if (entry.type === 'session_info') title = typeof entry.name === 'string' && entry.name.trim() ? entry.name : undefined;
          if (entry.type !== 'message') continue;
          const message = record(entry.message);
          if (message.role !== 'user' && message.role !== 'assistant') continue;
          const time = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(String(entry.timestamp));
          if (Number.isFinite(time)) activity = Math.max(activity, time);
          if (!firstMessage && message.role === 'user') {
            firstMessage = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
              ? message.content.map(record).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ') : '';
          }
        }
        if (!header || (!all && resolve(String(header.cwd)) !== resolve(options.cwd))) continue;
        // Selector identity is the actual path: imported copies can legitimately share a Pi UUID.
        const actualPath = await realpath(path);
        results.push({ id: actualPath, path: actualPath, cwd: String(header.cwd), title: title ?? firstMessage ?? '',
          modifiedTime: activity || Date.parse(String(header.timestamp)) || stats.mtimeMs, size: stats.size });
      } catch { /* A corrupt/deleted/unreadable session does not hide the remaining history. */ }
    }
  }
  return results.sort((a, b) => b.modifiedTime - a.modifiedTime || a.path.localeCompare(b.path));
}
