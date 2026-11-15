import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

import {
  detectDrift,
  formatDriftReport,
  hasDrift,
  resolveManifestPath,
} from '../src/drift-detection.js';

const binPath = fileURLToPath(new URL('../bin/dsh-inspect.js', import.meta.url));

let tempDir;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dsh-inspect-drift-'));
});

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function bytes(text) {
  return Buffer.byteLength(text, 'utf8');
}

async function makeDirectory(prefix) {
  return mkdtemp(join(tempDir, `${prefix}-`));
}

function frame(blocks) {
  return `<system-reminder>\n${blocks.filter((block) => block !== '').join('\n\n')}\n</system-reminder>`;
}

function instructionsRecord(files) {
  const blocks = [
    'The following workspace instructions may be relevant to your work.',
    ...files.map(({ path, content }) => `Instructions from: ${path}\n\n${content}`),
  ];

  return {
    type: 'user/message',
    data: {
      role: 'user',
      content: [{ type: 'text', text: frame(blocks) }],
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        changes: files.map(({ path, content }) => ({
          action: 'set',
          path,
          digest: sha1(content),
        })),
      },
    },
  };
}

async function writeSession(name, files) {
  const records = [{ type: 'session', version: 4, id: name }];

  if (files.length > 0) records.push(instructionsRecord(files));

  const path = join(tempDir, `${name}.v4.jsonl.zstd`);
  await writeFile(path, zstdCompressSync(Buffer.from(
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  )));

  return path;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

test('resolves relative, absolute and tilde manifest paths', () => {
  assert.equal(
    resolveManifestPath('AGENTS.md', { cwd: '/work', home: '/home/someone' }),
    '/work/AGENTS.md',
  );
  assert.equal(
    resolveManifestPath('scenes/dsh/AGENTS.md', { cwd: '/work', home: '/home/someone' }),
    '/work/scenes/dsh/AGENTS.md',
  );
  assert.equal(
    resolveManifestPath('/etc/AGENTS.md', { cwd: '/work', home: '/home/someone' }),
    '/etc/AGENTS.md',
  );
  assert.equal(
    resolveManifestPath('~/.agents/AGENTS.md', { cwd: '/work', home: '/home/someone' }),
    '/home/someone/.agents/AGENTS.md',
  );
  assert.equal(resolveManifestPath('~', { home: '/home/someone' }), '/home/someone');
});

test('classifies unchanged, changed and missing files by sha256', async () => {
  const project = await makeDirectory('classify');
  await mkdir(join(project, 'nested'), { recursive: true });
  await mkdir(join(project, 'directory-as-file'), { recursive: true });

  const unchanged = 'unchanged content\n';
  const changedFrom = 'before\n';
  const changedTo = 'after!\n';
  const missing = 'deleted later\n';
  const directoryContent = 'pretend file\n';
  const absoluteContent = '# absolute\n';

  await writeFile(join(project, 'AGENTS.md'), unchanged);
  await writeFile(join(project, 'nested', 'AGENTS.md'), changedTo);
  await writeFile(join(project, 'absolute.md'), absoluteContent);

  const entries = [
    { path: 'AGENTS.md', bytes: bytes(unchanged), sha256: sha256(unchanged) },
    { path: 'nested/AGENTS.md', bytes: bytes(changedFrom), sha256: sha256(changedFrom) },
    { path: 'deleted/AGENTS.md', bytes: bytes(missing), sha256: sha256(missing) },
    {
      path: 'directory-as-file',
      bytes: bytes(directoryContent),
      sha256: sha256(directoryContent),
    },
    {
      path: join(project, 'absolute.md'),
      bytes: bytes(absoluteContent),
      sha256: sha256(absoluteContent),
    },
    { path: 'empty.md', bytes: 0, sha256: sha256('') },
  ];

  await writeFile(join(project, 'empty.md'), '');

  assert.deepEqual(await detectDrift(entries, { cwd: project }), [
    {
      status: 'unchanged',
      path: 'AGENTS.md',
      injectedBytes: bytes(unchanged),
      currentBytes: bytes(unchanged),
    },
    {
      status: 'changed',
      path: 'nested/AGENTS.md',
      injectedBytes: bytes(changedFrom),
      currentBytes: bytes(changedTo),
    },
    {
      status: 'missing',
      path: 'deleted/AGENTS.md',
      injectedBytes: bytes(missing),
      currentBytes: null,
    },
    {
      status: 'missing',
      path: 'directory-as-file',
      injectedBytes: bytes(directoryContent),
      currentBytes: null,
    },
    {
      status: 'unchanged',
      path: join(project, 'absolute.md'),
      injectedBytes: bytes(absoluteContent),
      currentBytes: bytes(absoluteContent),
    },
    {
      status: 'unchanged',
      path: 'empty.md',
      injectedBytes: 0,
      currentBytes: 0,
    },
  ]);
});

test('same byte length with different content is changed, not unchanged', async () => {
  const project = await makeDirectory('digest');
  await writeFile(join(project, 'AGENTS.md'), 'bbbb\n');

  const [result] = await detectDrift(
    [{ path: 'AGENTS.md', bytes: 5, sha256: sha256('aaaa\n') }],
    { cwd: project },
  );

  assert.equal(result.status, 'changed');
  assert.equal(result.currentBytes, 5);
});

test('renders tabs, the missing dash and changed → missing → unchanged order', () => {
  const results = [
    { status: 'unchanged', path: 'u1', injectedBytes: 1, currentBytes: 1 },
    { status: 'missing', path: 'm1', injectedBytes: 2, currentBytes: null },
    { status: 'changed', path: 'c1', injectedBytes: 3, currentBytes: 4 },
    { status: 'unchanged', path: 'u2', injectedBytes: 5, currentBytes: 5 },
    { status: 'missing', path: 'm2', injectedBytes: 6, currentBytes: null },
  ];

  assert.equal(
    formatDriftReport(results),
    [
      'changed\tc1\t3\t4',
      'missing\tm1\t2\t-',
      'missing\tm2\t6\t-',
      'unchanged\tu1\t1',
      'unchanged\tu2\t5',
    ].join('\n'),
  );
  assert.equal(formatDriftReport([]), '');
});

test('hasDrift is false only when every file is unchanged', () => {
  assert.equal(hasDrift([]), false);
  assert.equal(hasDrift([{ status: 'unchanged' }]), false);
  assert.equal(hasDrift([{ status: 'unchanged' }, { status: 'missing' }]), true);
  assert.equal(hasDrift([{ status: 'changed' }]), true);
});

test('CLI drift reports three states, sorted, and exits 1', async () => {
  const project = await makeDirectory('cli-states');
  await mkdir(join(project, 'scenes', 'dsh'), { recursive: true });

  const unchanged = '# root\n\nkeep\n';
  const changedFrom = 'old scene\n';
  const changedTo = 'new scene content\n';
  const missing = 'deleted scene\n';

  await writeFile(join(project, 'AGENTS.md'), unchanged);
  await writeFile(join(project, 'scenes', 'dsh', 'AGENTS.md'), changedTo);

  const session = await writeSession('states', [
    { path: 'AGENTS.md', content: unchanged },
    { path: 'scenes/dsh/AGENTS.md', content: changedFrom },
    { path: 'deleted/AGENTS.md', content: missing },
  ]);

  const result = runCli(['drift', session], { cwd: project });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(
    result.stdout,
    [
      `changed\tscenes/dsh/AGENTS.md\t${bytes(changedFrom)}\t${bytes(changedTo)}`,
      `missing\tdeleted/AGENTS.md\t${bytes(missing)}\t-`,
      `unchanged\tAGENTS.md\t${bytes(unchanged)}`,
    ].join('\n') + '\n',
  );
});

test('CLI drift exits 0 and prints nothing for an empty manifest', async () => {
  const project = await makeDirectory('cli-empty');
  const session = await writeSession('empty', []);

  const result = runCli(['drift', session], { cwd: project });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('CLI drift reports a directory in the manifest as missing', async () => {
  const project = await makeDirectory('cli-directory');
  await mkdir(join(project, 'directory', 'AGENTS.md'), { recursive: true });

  const content = 'not a file\n';
  const session = await writeSession('directory', [
    { path: 'directory/AGENTS.md', content },
  ]);

  const result = runCli(['drift', session], { cwd: project });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `missing\tdirectory/AGENTS.md\t${bytes(content)}\t-\n`);
});

test('CLI drift resolves an absolute manifest path independently of the cwd', async () => {
  const project = await makeDirectory('cli-absolute');
  const other = await makeDirectory('cli-absolute-cwd');
  const content = '# absolute instructions\n';
  const absolutePath = join(project, 'AGENTS.md');

  await writeFile(absolutePath, content);

  const session = await writeSession('absolute', [
    { path: absolutePath, content },
  ]);

  const result = runCli(['drift', session], { cwd: other });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `unchanged\t${absolutePath}\t${bytes(content)}\n`);
});

test('CLI drift expands a tilde path using HOME', async () => {
  const home = await makeDirectory('cli-home');
  await mkdir(join(home, '.agents'), { recursive: true });

  const content = '# global instructions\n';
  await writeFile(join(home, '.agents', 'AGENTS.md'), content);

  const session = await writeSession('tilde', [
    { path: '~/.agents/AGENTS.md', content },
  ]);

  const result = runCli(['drift', session], {
    env: { ...process.env, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(
    result.stdout,
    `unchanged\t~/.agents/AGENTS.md\t${bytes(content)}\n`,
  );
});

test('CLI drift exits 2 when the session log cannot be read or decoded', async () => {
  const corrupt = join(tempDir, 'corrupt.v4.jsonl.zstd');
  await writeFile(corrupt, 'this is not zstd');

  const corruptResult = runCli(['drift', corrupt]);

  assert.equal(corruptResult.status, 2);
  assert.equal(corruptResult.stdout, '');
  assert.match(corruptResult.stderr, /invalid zstd frame magic/);

  const missingResult = runCli(['drift', join(tempDir, 'does-not-exist.v4.jsonl.zstd')]);

  assert.equal(missingResult.status, 2);
  assert.equal(missingResult.stdout, '');
  assert.match(missingResult.stderr, /cannot read/);
});

test('CLI drift exits 2 with usage when the path is missing or repeated', () => {
  const noPath = runCli(['drift']);

  assert.equal(noPath.status, 2);
  assert.equal(noPath.stdout, '');
  assert.match(noPath.stderr, /missing path argument for drift/);

  const twoPaths = runCli(['drift', 'one', 'two']);

  assert.equal(twoPaths.status, 2);
  assert.equal(twoPaths.stdout, '');
  assert.match(twoPaths.stderr, /expected exactly one path argument for drift/);
});
