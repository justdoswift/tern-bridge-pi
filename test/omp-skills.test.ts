import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { piSkillView } from '../src/omp-skills.js';
import { peerHarness, until } from './pi-peer.js';
import { skillFixture, SYNTHETIC_SKILL_BODY } from './skill-fixture.js';

test('Pi skill projection retains the whole wire text and canonical metadata', () => {
  const raw = skillFixture('Review  two files\nwith literal arguments');
  const view = piSkillView(raw)!;
  assert.equal(view.content, raw);
  assert.deepEqual(view.details, {
    name: 'review', path: '/synthetic/skills/review/SKILL.md',
    args: 'Review  two files\nwith literal arguments', lineCount: SYNTHETIC_SKILL_BODY.split('\n').length,
  });
  assert.equal(piSkillView(skillFixture())?.details?.args, undefined);
});

test('ordinary prose, skill examples and incomplete wrappers are never folded', () => {
  for (const raw of [
    'Please use /skill:review for this example.', '/skill:review arguments',
    'Example:\n' + skillFixture(), '```xml\n' + skillFixture() + '\n```',
    skillFixture().replace('location=', 'path='), skillFixture().replace('</skill>', '</skills>'),
    skillFixture().replace(' name="review"', ' name=""'),
    '<skill name="review" location="/example/SKILL.md">\nOrdinary markup example\n</skill>',
    skillFixture().slice(0, -8), skillFixture() + '\n',
    skillFixture().replace('References are relative to ', 'Other heading: '),
  ]) assert.equal(piSkillView(raw), undefined, raw);
});

test('synthetic Pi expands the skill remotely and preserves raw history, images and fork identity', async () => {
  const peer = await peerHarness();
  try {
    await peer.bridge.open(peer.sessionPath);
    const command = '/skill:review Inspect  synthetic files';
    const raw = skillFixture('Inspect  synthetic files');
    const images = [{ data: 'YQ==', mimeType: 'image/png' as const }];
    let accepted = 0;
    await peer.bridge.send(command, () => accepted++, images);
    await until(() => peer.bridge.state.phase === 'idle');
    assert.equal(accepted, 1);
    const prompt = (await peer.commands()).find(c => c.type === 'prompt');
    assert.equal(prompt?.message, command);
    assert.deepEqual(prompt?.images, images.map(image => ({ type: 'image', ...image })));
    const message = peer.bridge.state.messages.at(-1)!;
    assert.equal(message.role, 'user');
    assert.ok(message.blocks.some(b => b.kind === 'text' && b.text === raw));
    assert.ok(message.blocks.some(b => b.kind === 'image' && b.data === 'YQ=='));
    const choices = await peer.bridge.forkMessages();
    const choice = choices.find(c => c.text === raw)!;
    assert.ok(choice);
    await until(() => peer.bridge.state.messages.at(-1)?.id === choice.entryId);
    assert.equal(peer.bridge.state.messages.filter(m => m.id === choice.entryId).length, 1);
    const file = peer.bridge.state.session!.file!;
    const entries = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const saved = entries.find(e => e.id === choice.entryId);
    assert.equal(saved.message.content[0].text, raw);
    await peer.bridge.open(file);
    const restored = peer.bridge.state.messages.filter(m => m.id === choice.entryId);
    assert.equal(restored.length, 1);
    assert.ok(restored[0]!.blocks.some(b => b.kind === 'text' && b.text === raw));
    await peer.bridge.fork(choice.entryId);
    assert.equal(peer.bridge.state.editorText?.text, raw);
  } finally { await peer.dispose(); }
});

test('stock skill cards collapse live and restored messages without changing source or duplicating rows', () => {
  const result = spawnSync('bun', ['--eval', String.raw`
    import assert from 'node:assert/strict';
    import { Composer } from '@oh-my-pi/pi-tui/prompt/composer';
    import { SkillMessageComponent } from '@oh-my-pi/pi-tui/chat/skill-message';
    import { PiTranscript } from './src/omp-transcript.ts';
    import { skillFixture } from './test/skill-fixture.ts';
    const composer = new Composer({ preferences: { quiet: true }, exit() {} });
    const transcript = new PiTranscript(composer.ui, '/nonexistent');
    const cx = { cols: 100, dark: true, reduceMotion: true, supports: () => true, feature: () => true };
    const flatten = child => {
      const node = 'k' in child ? child : child.describe ? child.describe(cx) : { k: 'rows', p: { rows: child.render(100) } };
      return [{ ...node, c: undefined }, ...(node.c ?? []).flatMap(flatten)];
    };
    const state = { phase: 'running', needsInterrupt: true, session: { id: 'skills' }, messages: [
      { id: 'source-id', role: 'user', streaming: true, blocks: [{ id: 'block-id', kind: 'text', text: skillFixture('Inspect synthetic arguments') }] },
    ] };
    const json = () => JSON.stringify(flatten(transcript.container));
    const card = () => transcript.container.children[0].children[0].children[0];
    try {
      const source = JSON.stringify(state.messages);
      transcript.sync(state);
      const row = transcript.container.children[0];
      const skill = card();
      assert.ok(skill instanceof SkillMessageComponent);
      assert.equal(skill.describe().p.role, 'omp.skill');
      assert.equal(skill.describe().p.collapsed, true);
      assert.deepEqual(skill.describe().p.preview, { lines: 3 });
      assert.equal(skill.describe(), skill.describe());
      assert.ok(json().includes('review'));
      assert.ok(json().includes('Inspect synthetic arguments'));
      assert.equal(json().includes('SYNTHETIC_SKILL_BODY_SENTINEL'), false);
      assert.equal(skill.render(100).join('\n').includes('SYNTHETIC_SKILL_BODY_SENTINEL'), false);
      skill.handleNativeEvent({ type: 'toggle', key: '', collapsed: false });
      assert.equal(skill.describe().p.collapsed, false);
      assert.equal(skill.describe().p.preview, undefined);
      assert.ok(json().includes('SYNTHETIC_SKILL_BODY_SENTINEL'));
      assert.ok(json().includes('<skill name='));
      assert.ok(json().includes('</skill>'));
      assert.ok(skill.render(100).join('\n').includes('SYNTHETIC_SKILL_BODY_SENTINEL'));
      transcript.sync(state);
      assert.equal(card(), skill);
      assert.equal(JSON.stringify(state.messages), source);
      state.messages[0].blocks[0].text = skillFixture('Revised arguments');
      transcript.sync(state);
      assert.equal(transcript.container.children[0], row);
      assert.equal(card().describe().p.collapsed, false);
      assert.ok(json().includes('Revised arguments'));
      card().handleNativeEvent({ type: 'toggle', key: '', collapsed: true });
      assert.equal(json().includes('SYNTHETIC_SKILL_BODY_SENTINEL'), false);
      assert.deepEqual(card().describe().p.preview, { lines: 3 });
      state.messages[0].streaming = undefined;
      state.needsInterrupt = false;
      transcript.sync(state);
      assert.equal(transcript.container.children.length, 1);
      assert.equal(card().describe().p.collapsed, true);
      transcript.setExpanded(true);
      assert.ok(json().includes('SYNTHETIC_SKILL_BODY_SENTINEL'));
      transcript.setExpanded(false);
      assert.equal(json().includes('SYNTHETIC_SKILL_BODY_SENTINEL'), false);

      // Restored source objects enter the same projection, preserving saved identity.
      state.session = { id: 'restored' };
      state.messages = JSON.parse(JSON.stringify(state.messages));
      transcript.sync(state);
      assert.ok(card() instanceof SkillMessageComponent);
      assert.equal(card().describe().p.collapsed, true);
      assert.deepEqual(card().describe().p.preview, { lines: 3 });
      assert.equal(state.messages[0].id, 'source-id');
      assert.equal(state.messages[0].blocks[0].id, 'block-id');
      state.messages[0].blocks[0].text = skillFixture().slice(0, -8);
      transcript.sync(state);
      assert.equal(card() instanceof SkillMessageComponent, false);
      assert.ok(json().includes('SYNTHETIC_SKILL_BODY_SENTINEL'));
      // A partial live wrapper becomes exactly one card only after it is complete.
      state.messages[0].blocks[0].text = skillFixture();
      transcript.sync(state);
      assert.ok(card() instanceof SkillMessageComponent);
      assert.equal(card().describe().p.preview, undefined);
      assert.equal(transcript.container.children[0].children.length, 1);
      state.messages[0].role = 'assistant';
      transcript.sync(state);
      assert.ok(json().includes('SYNTHETIC_SKILL_BODY_SENTINEL'));
      assert.equal(flatten(transcript.container).some(n => n.p?.role === 'omp.skill'), false);
    } finally { transcript.dispose(); composer.stop(); }
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
