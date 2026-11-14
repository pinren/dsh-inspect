import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  extractInjectionManifest,
  formatInjectionManifest,
  InstructionManifestError,
  parseInstructionSections,
} from '../src/instruction-manifest.js';

const INTRO =
  'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.';
const REPLACEMENT_INTRO =
  'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.';
const UPDATED_NOTICE =
  'This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.';
const GLOBAL_GUIDANCE =
  'These user-global instructions apply to all work. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.';

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function frame(blocks) {
  return `<system-reminder>\n${blocks.filter((block) => block !== '').join('\n\n')}\n</system-reminder>`;
}

function baselineSection(path, content) {
  return `Instructions from: ${path}\n\n${content}`;
}

function additionalSection(path, content, guidance = GLOBAL_GUIDANCE) {
  return `Additional instructions from: ${path}\n\n${guidance}\n\n${content}`;
}

function updatedSection(path, content) {
  return `Updated instructions from: ${path}\n\n${UPDATED_NOTICE}\n\n${content}`;
}

function removedSection(path) {
  return `Instructions removed: ${path}\n\nThe previously loaded instructions from this file no longer apply.`;
}

function change(action, path, content) {
  return {
    action,
    scope: `.\u0000${path}`,
    path,
    ...(content === undefined ? {} : { digest: sha1(content) }),
  };
}

function instructionMessage(blocks, changes, { intro = undefined } = {}) {
  const text = frame(intro === undefined ? blocks : [intro, ...blocks]);

  return {
    type: 'user/message',
    data: {
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'agent-instructions', form: 'instructions', changes },
    },
  };
}

function baselineMessage(files, { replacement = false } = {}) {
  return instructionMessage(
    files.map((file) => baselineSection(file.path, file.content)),
    files.map((file) => change('set', file.path, file.content)),
    { intro: replacement ? REPLACEMENT_INTRO : INTRO },
  );
}

test('a session without injected instructions has an empty manifest', () => {
  const records = [
    { type: 'session', version: 4, id: 's1' },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant/message', data: { role: 'assistant', content: [] } },
  ];

  assert.deepEqual(extractInjectionManifest(records), []);
  assert.equal(formatInjectionManifest([]), '');
});

test('reports the path, byte length and sha256 of a single injected file', () => {
  const content = '# 工作约定\n\n- 只读，不写日志\n';
  const records = [baselineMessage([{ path: '~/.agents/AGENTS.md', content }])];

  const manifest = extractInjectionManifest(records);

  assert.deepEqual(manifest, [
    {
      path: '~/.agents/AGENTS.md',
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256(content),
    },
  ]);
  assert.equal(
    formatInjectionManifest(manifest),
    `~/.agents/AGENTS.md · ${Buffer.byteLength(content, 'utf8')} · ${sha256(content)}`,
  );
});

test('keeps the file bytes exactly, including a missing trailing newline', () => {
  const withNewline = 'line one\n';
  const withoutNewline = 'line one';
  const records = [
    baselineMessage([
      { path: 'AGENTS.md', content: withNewline },
      { path: 'nested/AGENTS.md', content: withoutNewline },
    ]),
  ];

  const manifest = extractInjectionManifest(records);

  assert.deepEqual(
    manifest.map((entry) => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 })),
    [
      { path: 'AGENTS.md', bytes: 9, sha256: sha256(withNewline) },
      { path: 'nested/AGENTS.md', bytes: 8, sha256: sha256(withoutNewline) },
    ],
  );
});

test('replays the chain: baseline order, later replacements, additions and removals', () => {
  const files = [
    { path: '~/.agents/AGENTS.md', content: 'global v1\n' },
    { path: 'AGENTS.md', content: 'root v1\n' },
    { path: 'nested/AGENTS.md', content: 'nested v1\n' },
  ];
  const records = [
    baselineMessage(files),
    instructionMessage(
      [updatedSection('AGENTS.md', 'root v2\n')],
      [change('replace', 'AGENTS.md', 'root v2\n')],
    ),
    instructionMessage(
      [additionalSection('nested/scenes/AGENTS.md', 'scene\n')],
      [change('set', 'nested/scenes/AGENTS.md', 'scene\n')],
    ),
    instructionMessage(
      [removedSection('~/.agents/AGENTS.md')],
      [change('remove', '~/.agents/AGENTS.md')],
    ),
  ];

  const manifest = extractInjectionManifest(records);

  assert.deepEqual(
    manifest.map((entry) => entry.path),
    ['AGENTS.md', 'nested/AGENTS.md', 'nested/scenes/AGENTS.md'],
  );
  assert.deepEqual(
    manifest.map((entry) => entry.sha256),
    [sha256('root v2\n'), sha256('nested v1\n'), sha256('scene\n')],
  );
});

test('a replacement baseline replaces the whole earlier chain', () => {
  const records = [
    baselineMessage([
      { path: 'AGENTS.md', content: 'old root\n' },
      { path: 'nested/AGENTS.md', content: 'old nested\n' },
    ]),
    baselineMessage([{ path: 'nested/AGENTS.md', content: 'new nested\n' }], {
      replacement: true,
    }),
  ];

  const manifest = extractInjectionManifest(records);

  assert.deepEqual(
    manifest.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    [{ path: 'nested/AGENTS.md', sha256: sha256('new nested\n') }],
  );
});

test('heading-shaped lines inside file content do not split the section', () => {
  const content = 'Read the format:\n\nInstructions from: ../fake/AGENTS.md\n\nnot a real file\n';
  const records = [baselineMessage([{ path: 'AGENTS.md', content }])];

  const manifest = extractInjectionManifest(records);

  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].bytes, Buffer.byteLength(content, 'utf8'));
  assert.equal(manifest[0].sha256, sha256(content));
});

test('rejects a frame with headings but no closing system-reminder tag', () => {
  const text = `<system-reminder>\nInstructions from: AGENTS.md\n\nhello`;

  assert.throws(
    () => parseInstructionSections(text),
    (error) => error instanceof InstructionManifestError && /closing/.test(error.message),
  );
});
