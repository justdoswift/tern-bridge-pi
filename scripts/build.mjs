import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
// Keep the original UI and its asset-relative imports; bundle only the bridge.
await build({
  absWorkingDir: root, entryPoints: ['src/main.ts'], outfile: 'dist/client.mjs',
  bundle: true, packages: 'external', platform: 'node', target: 'es2023', format: 'esm',
  sourcemap: false, legalComments: 'eof', loader: { '.svg': 'text' },
});
const packages = new Map();
async function copyRuntime(name, from = root, optional = false) {
  let current = from;
  let source;
  let metadata;
  for (;;) {
    const candidate = join(current, 'node_modules', name);
    try {
      metadata = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
      source = candidate;
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) {
      if (optional) return;
      throw new Error(`Missing production dependency: ${name}`);
    }
    current = parent;
  }
  if (metadata.os && !metadata.os.includes(process.platform)) return;
  if (metadata.cpu && !metadata.cpu.includes(process.arch)) return;
  if (packages.has(source)) return;
  const destination = relative(root, source);
  if (!destination.startsWith('node_modules/')) throw new Error(`Dependency resolved outside this installation: ${name}`);
  packages.set(source, { version: metadata.version, source, metadata });
  await cp(source, join(dist, destination), {
    recursive: true,
    filter: path => !relative(source, path).split(/[\\/]/).some(part => ['node_modules', '.git', 'test', 'tests', 'bench', 'examples'].includes(part)),
  });
  for (const dependency of Object.keys(metadata.dependencies ?? {})) await copyRuntime(dependency, source);
  for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) await copyRuntime(dependency, source, true);
}
for (const name of Object.keys(manifest.dependencies)) await copyRuntime(name);
const native = `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`;
if (![...packages.values()].some(item => item.metadata.name === native)) throw new Error(`The original omp UI requires its platform addon: ${native}`);
const notices = [];
for (const { version, source, metadata } of [...packages.values()].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name) || a.version.localeCompare(b.version))) {
  const files = await readdir(source);
  const licenseFile = files.find(file => /^licen[sc]e(?:[.-]|$)/i.test(file));
  if (!licenseFile) throw new Error(`Missing distribution license: ${metadata.name}`);
  let license = await readFile(join(source, licenseFile), 'utf8');
  for (const file of files.filter(file => /^(?:third[-_]party[-_])?notices?(?:[.-]|$)/i.test(file))) license += '\n\n' + await readFile(join(source, file), 'utf8');
  notices.push(`${metadata.name} ${version}\nLicense: ${typeof metadata.license === 'string' ? metadata.license : JSON.stringify(metadata.license)}\n\n${license}`);
}
const noticeText = notices.join('\n\n' + '='.repeat(72) + '\n\n').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n';
await writeFile(join(dist, 'THIRD_PARTY_NOTICES.txt'), noticeText);
await writeFile(join(dist, 'runtime.json'), JSON.stringify({ platform: process.platform, arch: process.arch, sharedUI: manifest.dependencies['@oh-my-pi/pi-tui'] }, null, 2) + '\n');
process.stdout.write(`Built ${relative(root, join(dist, 'client.mjs'))} with original omp UI (${process.platform}-${process.arch})\n`);
