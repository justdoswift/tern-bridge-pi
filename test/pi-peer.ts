import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { PiBridge } from '../src/backend.js';
import { skillFixture } from './skill-fixture.js';

export interface PeerHarness {
  root: string;
  cwd: string;
  otherCwd: string;
  sessionDir: string;
  sessionPath: string;
  executable: string;
  bridge: PiBridge;
  commands(): Promise<Record<string, unknown>[]>;
  emit(events: Record<string, unknown>[]): Promise<void>;
  session(name: string, cwd?: string, cancelled?: boolean): Promise<string>;
  dispose(): Promise<void>;
}
export async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Synthetic Pi peer condition did not occur.');
    await yieldTurn();
  }
}

/** A public-protocol-only peer. All sessions, records, and diagnostics are synthetic and isolated. */
export async function peerHarness(): Promise<PeerHarness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tern-pi-peer-')));
  const cwd = join(root, 'project');
  const otherCwd = join(root, 'other-project');
  const sessionDir = join(root, 'sessions');
  await Promise.all([mkdir(cwd), mkdir(otherCwd), mkdir(sessionDir)]);
  const executable = join(root, 'pi-peer.mjs');
  const logPath = join(root, 'commands.jsonl');
  const controlPath = join(root, 'control.json');
  await writeFile(controlPath, '[]');
  await writeFile(logPath, '');
  const script = String.raw`
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const log = join(root, 'commands.jsonl'), control = join(root, 'control.json');
const models = [
 { id: 'model/one', provider: 'provider/one', name: 'Image model', reasoning: true, input: ['text', 'image'], contextWindow: 200000 },
 { id: 'plain', provider: 'provider-two', name: 'Text model', reasoning: false, input: ['text'], contextWindow: 10000 }
];
const skillPrompt = ${JSON.stringify(skillFixture())};
let model = models[0], thinkingLevel = 'medium', file, header, entries = [], leafId = null;
let serial = 0, streaming = false, compacted = false, queued = [], cancelNext = false, late = null, controlledPrompt = null;
const out = record => process.stdout.write(JSON.stringify(record) + '\n');
const respond = (c, data, success = true) => out({ type: 'response', id: c.id, command: c.type, success, ...(success ? { data } : { error: 'synthetic-private-key-and-prompt' }) });
function persist() { writeFileSync(file, [header, ...entries].map(JSON.stringify).join('\n') + '\n'); }
function load(path) {
 file = path;
 const lines = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
 header = lines[0]; entries = lines.slice(1); leafId = entries.at(-1)?.id ?? null;
 const choice = entries.findLast(e => e.type === 'model_change');
 if (choice) model = models.find(m => m.id === choice.modelId && m.provider === choice.provider) ?? model;
 thinkingLevel = entries.findLast(e => e.type === 'thinking_level_change')?.thinkingLevel ?? thinkingLevel;
 compacted = entries.some(e => e.type === 'compaction'); streaming = false;
}
function branch() {
 const byId = new Map(entries.map(e => [e.id, e])); let id = leafId; const path = [];
 while (id) { const entry = byId.get(id); if (!entry) break; path.unshift(entry); id = entry.parentId; }
 return path;
}
function fresh(copy = []) {
 const id = 'synthetic-' + process.pid + '-' + ++serial;
 file = join(root, 'sessions', id + '.jsonl');
 header = { type: 'session', version: 3, id, cwd: header?.cwd ?? process.cwd(), timestamp: new Date(1).toISOString() };
 entries = copy; leafId = copy.at(-1)?.id ?? null; persist(); compacted = copy.some(e => e.type === 'compaction');
}
function append(message) {
 const entry = { type: 'message', id: 'entry-' + ++serial, parentId: leafId, timestamp: new Date(message.timestamp).toISOString(), message };
 entries.push(entry); leafId = entry.id; persist();
}
function userText(content) {
 if (typeof content === 'string') return content;
 return content.filter(block => block.type === 'text').map(block => block.text).join('');
}
function settle() { streaming = false; out({ type: 'agent_settled', aborted: false }); }
function messages() {
 const path = branch(); const compact = path.findLastIndex(e => e.type === 'compaction');
 const selected = compact < 0 ? path : [path[compact], ...path.slice(compact + 1)];
 return selected.flatMap(e => e.type === 'message' ? [e.message] : e.type === 'compaction' ? [{ role: 'compactionSummary', summary: e.summary, timestamp: Date.parse(e.timestamp) }] : []);
}
const existing = process.argv.indexOf('--session');
if (existing >= 0) load(process.argv[existing + 1]); else fresh();
let lastControl = '[]';
// Cross-process control polling deliberately uses the platform clock; assertions await records, never guessed delays.
const interval = setInterval(() => {
 try {
  const next = readFileSync(control, 'utf8');
  if (next !== lastControl) { lastControl = next; for (const event of JSON.parse(next)) {
    if (event.type === 'test_prompt_ack' && controlledPrompt) {
      respond(controlledPrompt, { disposition: event.disposition ?? 'started' }, event.success !== false);
      continue;
    }
    if (event.type === 'test_prompt_user' && controlledPrompt) {
      streaming = true; out({ type: 'agent_start' });
      const user = { role: 'user', content: [{ type: 'text', text: event.text ?? controlledPrompt.message }, ...(controlledPrompt.images ?? [])], timestamp: 1000 + serial };
      append(user); out({ type: 'message_start', message: user }); out({ type: 'message_end', message: user });
      continue;
    }
    if (event.type === 'agent_settled') streaming = false;
    if (event.type === 'agent_start') streaming = true;
    if (event.type === 'test_exit') { process.stderr.write('PRIVATE SYNTHETIC STDERR'); process.exit(9); }
    out(event);
  } }
 } catch {}
}, 5);
async function command(c) {
 appendFileSync(log, JSON.stringify(c) + '\n');
 switch(c.type) {
 case 'get_state': return respond(c, { sessionId: header.id, sessionFile: file, sessionName: entries.findLast(e => e.type === 'session_info')?.name,
   model, thinkingLevel, isStreaming: streaming, isCompacting: false, pendingMessageCount: queued.length, autoCompactionEnabled: true });
 case 'get_entries': return respond(c, { entries, leafId });
 case 'get_messages': return respond(c, { messages: messages() });
 case 'get_session_stats': return respond(c, { sessionId: header.id, sessionFile: file, tokens: { input: 300000, output: 20, cacheRead: 5, cacheWrite: 7, total: 300032 }, cost: 0.2,
   contextUsage: { tokens: compacted ? null : 400, contextWindow: model.contextWindow, percent: compacted ? null : 400 / model.contextWindow * 100 } });
 case 'get_available_models': return respond(c, { models });
 case 'get_available_thinking_levels': return respond(c, { levels: model.reasoning ? ['off', 'medium', 'high'] : ['off'] });
 case 'get_commands': return respond(c, { commands: [ { name: 'settings', source: 'extension', description: 'literal extension command' }, { name: 'skill:review', source: 'skill' }, { name: 'draft', source: 'prompt' } ] });
 case 'set_model': model = models.find(m => m.id === c.modelId && m.provider === c.provider); return model ? respond(c, model) : respond(c, null, false);
 case 'set_thinking_level': thinkingLevel = c.level; out({ type: 'thinking_level_changed', level: c.level }); return respond(c);
 case 'set_session_name': entries.push({ type: 'session_info', id: 'name-' + ++serial, parentId: leafId, timestamp: new Date().toISOString(), name: c.name.trim() }); leafId = entries.at(-1).id; persist(); return respond(c);
 case 'get_fork_messages': return respond(c, { messages: branch().filter(e => e.type === 'message' && e.message.role === 'user').map(e => ({ entryId: e.id, text: userText(e.message.content) })) });
 case 'switch_session': {
   if (JSON.parse(readFileSync(c.sessionPath, 'utf8').split('\n')[0]).cancelled) return respond(c, { cancelled: true });
   load(c.sessionPath); out({ type: 'extension_ui_request', id: 'new-widget', method: 'setWidget', widgetKey: 'project', widgetLines: [header.cwd] });
   return respond(c, { cancelled: false });
 }
 case 'new_session': case 'clone': case 'fork': {
   if (cancelNext) { cancelNext = false; return respond(c, { cancelled: true }); }
   let copy = c.type === 'new_session' ? [] : branch(); let text;
   if (c.type === 'fork') { const index = copy.findIndex(e => e.id === c.entryId); text = userText(copy[index]?.message.content); copy = copy.slice(0, index); }
   fresh(copy); return respond(c, { cancelled: false, text });
 }
 case 'compact': {
   out({ type: 'compaction_start', reason: 'manual' });
   const id = 'compact-' + ++serial;
   entries.push({ type: 'compaction', id, parentId: leafId, timestamp: new Date().toISOString(), firstKeptEntryId: id, summary: 'Synthetic summary', tokensBefore: 400 });
   leafId = id; compacted = true; persist();
   out({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: { summary: 'Synthetic summary', firstKeptEntryId: id, tokensBefore: 400 } });
   return respond(c, { summary: 'Synthetic summary', firstKeptEntryId: id, tokensBefore: 400 });
 }
 case 'clear_queue': { const previous = queued; queued = []; return respond(c, { steering: [], followUp: previous }); }
 case 'abort': {
   settle(); respond(c);
   if (late) { const pending = late; late = null; queueMicrotask(() => { streaming = true; out({ type: 'agent_start' }); respond(pending, { disposition: 'started' }); }); }
   return;
 }
 case 'prompt': {
   if (c.message === 'reject') return respond(c, null, false);
   if (c.message === '/cancel') { cancelNext = true; return respond(c, { disposition: 'handled' }); }
   if (c.message === '/handled') return respond(c, { disposition: 'handled' });
   if (c.message === 'late') { late = c; return; }
   if (c.message === 'delayed') { controlledPrompt = c; return; }
   if (c.message === 'queued') { queued = ['Synthetic queued text']; return respond(c, { disposition: 'queued' }); }
   if (c.message === 'hold') { streaming = true; out({ type: 'agent_start' }); respond(c, { disposition: 'started' }); out({ type: 'agent_end', willRetry: true, messages: [] }); out({ type: 'auto_retry_start', attempt: 1 }); return; }
   if (c.message === '/skill:review' || c.message.startsWith('/skill:review ')) {
     const args = c.message.slice('/skill:review'.length).trim();
     const text = skillPrompt + (args ? '\n\n' + args : '');
     streaming = true; out({ type: 'agent_start' });
     const user = { role: 'user', content: [{ type: 'text', text }, ...(c.images ?? [])], timestamp: 1000 + serial };
     append(user); out({ type: 'message_start', message: user }); out({ type: 'message_end', message: user });
     out({ type: 'agent_end', messages: [], willRetry: false }); settle();
     return respond(c, { disposition: 'started' });
   }
   if (c.message === 'fast') {
     streaming = true; out({ type: 'agent_start' });
     const user = { role: 'user', content: 'fast', timestamp: 100 + serial };
     out({ type: 'message_start', message: user }); out({ type: 'message_end', message: user }); append(user);
     const message = { role: 'assistant', content: [], timestamp: 200 + serial, model: model.id, provider: model.provider, stopReason: 'pending' };
     out({ type: 'message_start', message });
     out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' } });
     message.content = [{ type: 'text', text: 'Final authoritative reply' }]; message.stopReason = 'stop';
     out({ type: 'message_end', message }); append(message);
     out({ type: 'agent_end', messages: [message], willRetry: false }); settle();
     return respond(c, { disposition: 'started' });
   }
   return respond(c, { disposition: 'handled' });
 }
 default: return respond(c, null, false);
 }
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; let index; while ((index = input.indexOf('\n')) >= 0) {
 const line = input.slice(0, index); input = input.slice(index + 1); const c = JSON.parse(line);
 if (c.type === 'extension_ui_response') appendFileSync(log, JSON.stringify(c) + '\n'); else void command(c);
} });
process.stdin.on('end', () => { clearInterval(interval); process.exit(0); });
`;
  await writeFile(executable, `#!${process.execPath}\n${script}`);
  await chmod(executable, 0o700);
  async function session(name: string, sessionCwd = cwd, cancelled = false): Promise<string> {
    const path = join(sessionDir, `${name}.jsonl`);
    const header = { type: 'session', version: 3, id: name, cwd: sessionCwd, timestamp: new Date(1).toISOString(), cancelled };
    const entries = [
      { type: 'model_change', id: 'model', parentId: null, timestamp: new Date(1).toISOString(), provider: 'provider/one', modelId: 'model/one' },
      { type: 'thinking_level_change', id: 'thinking', parentId: 'model', timestamp: new Date(1).toISOString(), thinkingLevel: 'medium' },
      { type: 'message', id: 'private-system', parentId: 'thinking', timestamp: new Date(1).toISOString(), message: { role: 'system', content: 'PRIVATE LOADOUT', sections: { tools: 'PRIVATE TOOLS' }, timestamp: 1 } },
      { type: 'message', id: 'user-one', parentId: 'private-system', timestamp: new Date(2).toISOString(), message: { role: 'user', content: 'Original user prose', timestamp: 2 } },
      { type: 'message', id: 'assistant-one', parentId: 'user-one', timestamp: new Date(3).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Original assistant prose' }], timestamp: 3, model: 'model/one', provider: 'provider/one', stopReason: 'stop' } },
      { type: 'session_info', id: 'name', parentId: 'assistant-one', timestamp: new Date(4).toISOString(), name },
    ];
    await writeFile(path, [header, ...entries].map(value => JSON.stringify(value)).join('\n') + '\n');
    return path;
  }
  const sessionPath = await session('original');
  const bridge = new PiBridge({ cwd, dataDir: join(root, 'bridge-data'), execPath: executable, sessionDir, onChange() {} });
  let emission = 0;
  return { root, cwd, otherCwd, sessionDir, sessionPath, executable, bridge, session,
    async commands() { return (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>); },
    async emit(events) { await writeFile(controlPath, JSON.stringify([...events, { type: 'test_marker', sequence: ++emission }])); },
    async dispose() { try { await bridge.close(); } finally { await rm(root, { recursive: true, force: true }); } },
  };
}
