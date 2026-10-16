import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
const id = 'tern-bridge-pi';
// Every executable is isolated from the host PATH. The synthetic Tern owns only
// its package directory, independently of persistent data and the official CLI.
const executable = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.TRACE, JSON.stringify({ tool, args, cwd: process.cwd(), prompt: env.GIT_TERMINAL_PROMPT }) + '\\n');
const die = () => process.exit(23);
if (tool === 'node' || tool === 'bun') {
  console.log(tool === 'node' ? env.NODE_VERSION || 'v22.19.0' : env.BUN_VERSION || '1.3.14');
} else if (tool === 'uname') {
  console.log(args[0] === '-s' ? env.OS || 'Darwin' : env.ARCH || 'arm64');
} else if (tool === 'mktemp') {
  console.log(fs.mkdtempSync(args[1].replace(/X+$/, '')));
} else if (tool === 'rm') {
  fs.rmSync(args[args.length - 1], { recursive: true, force: true });
} else if (tool === 'git') {
  if (args[0] === 'clone') {
    fs.mkdirSync(args[args.length - 1], { recursive: true });
    if (env.FAIL === 'clone') die();
  } else console.log('0123456789abcdef');
} else if (tool === 'npm') {
  if (args[0] === 'ci') {
    if (env.FAIL === 'npm') die();
    fs.writeFileSync('.dependencies-ready', 'yes');
  } else {
    if (!fs.existsSync('.dependencies-ready') || env.FAIL === 'build') die();
    if (env.FAIL !== 'artifact') {
      fs.mkdirSync('artifacts/package/tern-bridge-pi', { recursive: true });
      fs.writeFileSync('artifacts/package/tern-bridge-pi/payload', 'new-package');
    }
  }
} else if (tool === 'tern') {
  const target = path.join(env.TERN_CONFIG_DIR, 'plugins', 'tern-bridge-pi');
  if (args[0] !== 'plugin') die();
  if (args[1] === 'remove') {
    if (args[2] !== 'tern-bridge-pi') die();
    fs.rmSync(target, { recursive: true, force: true });
  } else if (args[1] === 'install') {
    if (env.FAIL === 'install' || fs.existsSync(path.join(target, 'linked'))) die();
    if (fs.existsSync(target) && !args.includes('--force')) die();
    const payload = fs.readFileSync(path.join(args[2], 'payload'), 'utf8');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'payload'), payload);
  } else die();
}
`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pi installer '));
  const bin = join(dir, 'bin');
  const temp = join(dir, 'temporary space');
  const home = join(dir, 'home');
  const config = join(dir, 'custom config');
  const trace = join(dir, 'trace');
  const target = join(config, 'plugins', id);
  const sentinels = [join(config, 'plugin-data', id, 'history'), join(config, 'plugins', 'unrelated', 'payload'), join(home, '.pi', 'auth.json'), join(home, '.zshrc'), join(temp, 'unrelated')];
  await Promise.all([bin, temp, home].map(path => mkdir(path, { recursive: true })));
  await writeFile(trace, '');
  for (const path of sentinels) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'keep');
  }
  for (const tool of ['tern', 'git', 'node', 'npm', 'bun', 'pi', 'uname', 'mktemp', 'rm']) {
    await writeFile(join(bin, tool), executable, { mode: 0o700 });
  }
  const env = { HOME: home, PATH: bin, TMPDIR: temp, TERN_CONFIG_DIR: config, TRACE: trace };
  return {
    dir, bin, target,
    async run(args: string[] = [], extra: Record<string, string> = {}, stdin = false, content?: string) {
      const result = spawnSync('/bin/bash', stdin ? ['-s', '--', ...args] : [installer, ...args], {
        env: { ...env, ...extra }, cwd: home, encoding: 'utf8', timeout: 10_000,
        input: stdin ? content ?? await readFile(installer, 'utf8') : undefined,
      });
      assert.ifError(result.error);
      return result;
    },
    async seed(linked = false) {
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'payload'), 'old-package');
      if (linked) await writeFile(join(target, 'linked'), 'yes');
    },
    async events(): Promise<Array<{ tool: string; args: string[]; prompt?: string }>> {
      return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    async preserved() {
      for (const path of sentinels) assert.equal(await readFile(path, 'utf8'), 'keep', path);
      assert.deepEqual(await readdir(temp), ['unrelated']);
      assert.equal(await readFile(join(bin, 'pi'), 'utf8'), executable);
    },
    async dispose() { await rm(dir, { recursive: true, force: true }); },
  };
}

test('default stdin install builds main before native install and cleans whitespace temp paths', async () => {
  const f = await fixture();
  try {
    const result = await f.run([], {}, true);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(f.target, 'payload'), 'utf8'), 'new-package');
    await f.preserved();
  } finally { await f.dispose(); }
});

for (const failure of ['clone', 'npm', 'build', 'artifact', 'install']) {
  test(`update preserves existing state on ${failure} failure`, async () => {
    const f = await fixture();
    try {
      await f.seed();
      assert.notEqual((await f.run(['update'], { FAIL: failure })).status, 0);
      assert.equal(await readFile(join(f.target, 'payload'), 'utf8'), 'old-package');
      if (failure !== 'install') assert.equal((await f.events()).some(e => e.tool === 'tern'), false);
      await f.preserved();
    } finally { await f.dispose(); }
  });
}

test('overwrite requires explicit update; update also installs when missing', async () => {
  const f = await fixture();
  try {
    await f.seed();
    const refused = await f.run(['install']);
    assert.notEqual(refused.status, 0);
    assert.equal(await readFile(join(f.target, 'payload'), 'utf8'), 'old-package');
    assert.equal((await f.run(['update'])).status, 0);
    assert.equal(await readFile(join(f.target, 'payload'), 'utf8'), 'new-package');
    await rm(f.target, { recursive: true });
    assert.equal((await f.run(['update'], {}, true)).status, 0);
    assert.equal(await readFile(join(f.target, 'payload'), 'utf8'), 'new-package');
    await f.preserved();
  } finally { await f.dispose(); }
});

test('linked packages remain protected during explicit update', async () => {
  const f = await fixture();
  try {
    await f.seed(true);
    const result = await f.run(['update']);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(join(f.target, 'payload'), 'utf8'), 'old-package');
    assert.equal(await readFile(join(f.target, 'linked'), 'utf8'), 'yes');
    await f.preserved();
  } finally { await f.dispose(); }
});

for (const tool of ['tern', 'git', 'node', 'npm', 'bun', 'pi']) {
  test(`missing ${tool} rejects installation before mutation`, async () => {
    const f = await fixture();
    try {
      await rm(join(f.bin, tool));
      const result = await f.run();
      assert.notEqual(result.status, 0);
      assert.equal((await f.events()).some(e => ['git', 'npm', 'tern', 'mktemp'].includes(e.tool)), false);
    } finally { await f.dispose(); }
  });
}

for (const extra of [{ NODE_VERSION: 'v22.18.9' }, { NODE_VERSION: 'v21.99.99' }, { NODE_VERSION: 'v22.19.0-rc.1' }, { BUN_VERSION: '1.3.13' }, { BUN_VERSION: 'garbage' }, { OS: 'Windows_NT' }, { ARCH: 'riscv64' }] as Array<Record<string, string>>) {
  test(`rejects unsupported prerequisites ${JSON.stringify(extra)}`, async () => {
    const f = await fixture();
    try {
      assert.notEqual((await f.run([], extra)).status, 0);
      assert.equal((await f.events()).some(e => ['git', 'npm', 'tern', 'mktemp'].includes(e.tool)), false);
      await f.preserved();
    } finally { await f.dispose(); }
  });
}

test('Linux x86_64 is allowed with an unverified warning', async () => {
  const f = await fixture();
  try {
    const result = await f.run([], { OS: 'Linux', ARCH: 'x86_64', NODE_VERSION: 'v24.0.0', BUN_VERSION: '1.4.0' });
    assert.equal(result.status, 0, result.stderr);
    await f.preserved();
  } finally { await f.dispose(); }
});

test('uninstall needs only Tern and preserves data, unrelated plugins and CLI', async () => {
  const f = await fixture();
  try {
    await f.seed();
    const onlyTern = join(f.dir, 'only tern');
    await mkdir(onlyTern);
    await writeFile(join(onlyTern, 'tern'), executable, { mode: 0o700 });
    const result = await f.run(['uninstall'], { PATH: onlyTern, OS: 'unsupported' }, true);
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(readFile(join(f.target, 'payload')), { code: 'ENOENT' });
    await f.preserved();
  } finally { await f.dispose(); }
});

for (const args of [['wat'], [''], ['install', 'extra'], ['--help', 'extra']]) {
  test(`invalid arguments do nothing: ${JSON.stringify(args)}`, async () => {
    const f = await fixture();
    try {
      assert.notEqual((await f.run(args)).status, 0);
      assert.deepEqual(await f.events(), []);
      await f.preserved();
    } finally { await f.dispose(); }
  });
}

test('help and incomplete stdin never execute actions', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run(['--help'])).status, 0);
    assert.equal((await f.run(['help'])).status, 0);
    const source = await readFile(installer, 'utf8');
    await f.run([], {}, true, source.slice(0, source.lastIndexOf('main "$@"')));
    await f.run([], {}, true, source.slice(0, source.indexOf('  checkout=')));
    assert.deepEqual(await f.events(), []);
    await f.preserved();
  } finally { await f.dispose(); }
});
