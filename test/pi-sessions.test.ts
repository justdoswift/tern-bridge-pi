import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listPiSessions, readSessionHeader, sessionDirectory } from '../src/pi-sessions.js';

async function writeSession(path: string, id: string, cwd: string, name?: string, message = 'First prompt\u2028line\u2029paragraph') {
  const entries = [
    { type: 'session', version: 3, id, cwd, timestamp: new Date(10).toISOString() },
    { type: 'message', id: 'user', parentId: null, timestamp: new Date(20).toISOString(), message: { role: 'user', content: message, timestamp: 20 } },
    { type: 'message', id: 'assistant', parentId: 'user', timestamp: new Date(30).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Answer' }], timestamp: 30 } },
    ...(name === undefined ? [] : [{ type: 'session_info', id: 'name', parentId: 'assistant', timestamp: new Date(1000).toISOString(), name }]),
  ];
  await writeFile(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
}

test('custom session root is flat, cwd filtering is real, and imported UUID duplicates have distinct selector paths', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tern-pi-history-')));
  try {
    const cwd = join(root, 'a'); const other = join(root, 'b'); const sessionDir = join(root, 'sessions');
    await Promise.all([mkdir(cwd), mkdir(other), mkdir(sessionDir)]);
    const a = join(sessionDir, 'a.jsonl'), copy = join(sessionDir, 'copy.jsonl'), b = join(sessionDir, 'b.jsonl');
    await writeSession(a, 'shared-uuid', cwd, 'Literal 会话\u2028标题');
    await writeSession(copy, 'shared-uuid', cwd);
    await writeSession(b, 'other-uuid', other, 'Other project');
    await writeFile(join(sessionDir, 'corrupt.jsonl'), 'not a session\n{"type":"message"}\n');
    await writeFile(join(sessionDir, 'not-a-session.txt'), '{}');
    const current = await listPiSessions({ cwd, sessionDir, agentDir: root }, false);
    assert.equal(current.length, 2);
    assert.notEqual(current[0]?.id, current[1]?.id);
    assert.ok(current.every(session => session.id === session.path && session.cwd === cwd));
    assert.equal(current.find(session => session.path === a)?.title, 'Literal 会话\u2028标题');
    assert.equal(current.find(session => session.path === copy)?.title, 'First prompt\u2028line\u2029paragraph');
    assert.ok(current.every(session => session.modifiedTime === 30 && session.size > 0));
    assert.equal((await listPiSessions({ cwd, sessionDir, agentDir: root }, true)).length, 3);
    // Discovery must not rewrite or migrate author JSONL.
    const before = await readFile(a, 'utf8');
    await listPiSessions({ cwd, sessionDir, agentDir: root }, true);
    assert.equal(await readFile(a, 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('default root encodes cwd exactly like Pi, all-project listing scans project children only', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tern-pi-default-history-')));
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    const cwd = join(root, 'project:with:colons'); const other = join(root, 'other'); const agentDir = join(root, 'agent');
    await Promise.all([mkdir(cwd), mkdir(other)]);
    const aDir = sessionDirectory({ cwd, agentDir }); const bDir = sessionDirectory({ cwd: other, agentDir });
    assert.equal(aDir, join(agentDir, 'sessions', `--${cwd.slice(1).replace(/[/\\:]/g, '-')}--`));
    await Promise.all([mkdir(aDir, { recursive: true }), mkdir(bDir, { recursive: true })]);
    await writeSession(join(aDir, 'a.jsonl'), 'a', cwd);
    await writeSession(join(bDir, 'b.jsonl'), 'b', other);
    assert.equal((await listPiSessions({ cwd, agentDir }, false)).length, 1);
    assert.equal((await listPiSessions({ cwd, agentDir }, true)).length, 2);
    assert.deepEqual(await listPiSessions({ cwd, sessionDir: join(root, 'missing'), agentDir }, true), []);
  } finally {
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    await rm(root, { recursive: true, force: true });
  }
});

test('header resolution preserves the actual saved cwd and canonical file identity, not caller cwd', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tern-pi-header-')));
  try {
    const cwd = join(root, 'saved-project'); await mkdir(cwd);
    const path = join(root, 'session.jsonl'); const alias = join(root, 'alias.jsonl');
    await writeSession(path, 'actual-pi-uuid', cwd);
    await symlink(path, alias);
    assert.deepEqual(await readSessionHeader(alias), { id: 'actual-pi-uuid', cwd, path });
    const malformed = join(root, 'malformed.jsonl');
    await writeFile(malformed, '{"type":"message","id":"not-a-header"}\n');
    await assert.rejects(readSessionHeader(malformed), /valid Pi session/);
    await writeSession(path, 'actual-pi-uuid', join(root, 'missing-project'));
    await assert.rejects(readSessionHeader(path));
  } finally { await rm(root, { recursive: true, force: true }); }
});
