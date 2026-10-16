import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionLock, SessionLockError } from '../src/session-lock.js';

function lockPath(root: string, id: string) {
  return join(root, 'session-locks', `${createHash('sha256').update(id).digest('hex')}.lock`);
}

test('live owners cannot be stolen and releasing one session does not unlock another', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tern-pi-lock-'));
  try {
    const first = await SessionLock.acquire(root, 'first');
    const second = await SessionLock.acquire(root, 'second');
    await assert.rejects(SessionLock.acquire(root, 'first'), SessionLockError);
    await first.release(); await first.release();
    const replacement = await SessionLock.acquire(root, 'first');
    await assert.rejects(SessionLock.acquire(root, 'second'), SessionLockError);
    await replacement.release(); await second.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unverifiable/incomplete lock owners remain conservatively locked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tern-pi-incomplete-lock-'));
  try {
    const path = lockPath(root, 'unknown');
    await mkdir(path, { recursive: true });
    await assert.rejects(SessionLock.acquire(root, 'unknown'), /no verifiable owner/);
    await writeFile(join(path, 'owner.json'), '{"pid":-1,"token":"invalid"}');
    await assert.rejects(SessionLock.acquire(root, 'unknown'), /no verifiable owner/);
    assert.equal(await readFile(join(path, 'owner.json'), 'utf8'), '{"pid":-1,"token":"invalid"}');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a positively dead owner is reclaimed under the reclaimer gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tern-pi-dead-lock-'));
  try {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = child.pid; assert.ok(pid);
    await once(child, 'close');
    const path = lockPath(root, 'dead');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'owner.json'), JSON.stringify({ pid, token: 'dead-owner-token' }));
    const lock = await SessionLock.acquire(root, 'dead');
    const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as { pid: number; token: string };
    assert.equal(owner.pid, process.pid); assert.notEqual(owner.token, 'dead-owner-token');
    await lock.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release verifies token ownership instead of deleting a replacement owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tern-pi-replaced-lock-'));
  try {
    const lock = await SessionLock.acquire(root, 'session');
    const path = lockPath(root, 'session');
    await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'replacement-owner' }));
    await lock.release();
    assert.equal(JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')).token, 'replacement-owner');
  } finally { await rm(root, { recursive: true, force: true }); }
});
