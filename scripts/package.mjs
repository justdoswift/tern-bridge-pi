import { cp, mkdir, copyFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'artifacts', 'package', 'tern-bridge-pi');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const file of ['plugin.toml', 'host.luau', 'window.luau', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
  await copyFile(join(root, file), join(target, file));
}
await cp(join(root, 'bin'), join(target, 'bin'), { recursive: true });
await cp(join(root, 'shell'), join(target, 'shell'), { recursive: true });
await cp(join(root, 'dist'), join(target, 'dist'), { recursive: true });
process.stdout.write(`Installable plugin: ${target}\n`);
