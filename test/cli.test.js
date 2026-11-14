import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const binPath = fileURLToPath(new URL('../bin/dsh-inspect.js', import.meta.url));

const partA =
  '{"type":"session_start","id":"s1"}\n' +
  '{"type":"message","role":"user","text":"hello"}\n';
const partB =
  '{"type":"message","role":"assistant","text":"hi"}\n' +
  '{"type":"session_end"}\n';

let tempDir;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dsh-inspect-'));
});

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function runCli(args) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });
}

function lineCount(text) {
  return text.split('\n').filter((line) => line.length > 0).length;
}

test('CLI decodes a two-frame session log and preserves every line', async () => {
  const path = join(tempDir, 'two-frames.v4.jsonl.zstd');
  await writeFile(
    path,
    Buffer.concat([zstdCompressSync(Buffer.from(partA)), zstdCompressSync(Buffer.from(partB))]),
  );

  const result = runCli([path]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, partA + partB);
  assert.equal(lineCount(result.stdout), lineCount(partA) + lineCount(partB));
});

test('CLI decodes a single-frame session log', async () => {
  const path = join(tempDir, 'single-frame.v4.jsonl.zstd');
  await writeFile(path, zstdCompressSync(Buffer.from(partA)));

  const result = runCli([path]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, partA);
});

test('CLI exits 2 with usage when no path is given', () => {
  const result = runCli([]);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Usage: dsh-inspect/);
});

test('CLI exits non-zero and explains an unreadable path', () => {
  const result = runCli([join(tempDir, 'does-not-exist.v4.jsonl.zstd')]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /cannot read/);
});

test('CLI exits non-zero without partial stdout when a frame is truncated', async () => {
  const first = zstdCompressSync(Buffer.from(partA));
  const complete = Buffer.concat([first, zstdCompressSync(Buffer.from(partB))]);
  const path = join(tempDir, 'truncated.v4.jsonl.zstd');
  await writeFile(path, complete.subarray(0, first.length + 5));

  const result = runCli([path]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /truncated zstd frame/);
});

test('CLI exits non-zero and explains corrupt input instead of printing nothing', async () => {
  const path = join(tempDir, 'corrupt.v4.jsonl.zstd');
  await writeFile(path, 'this is not zstd');

  const result = runCli([path]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /invalid zstd frame magic/);
});

function encodeRecords(records) {
  const text = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

  return zstdCompressSync(Buffer.from(text));
}

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function instructionsRecord(path, content) {
  const text = [
    '<system-reminder>',
    'The following workspace instructions may be relevant to your work.',
    `Instructions from: ${path}\n\n${content}`,
    '</system-reminder>',
  ].join('\n');

  return {
    type: 'user/message',
    data: {
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        changes: [{ action: 'set', path, digest: sha1(content) }],
      },
    },
  };
}

test('CLI inject prints one path · bytes · sha256 line per injected file', async () => {
  const path = join(tempDir, 'with-instructions.v4.jsonl.zstd');
  const content = '# root instructions\n\nbe careful\n';
  await writeFile(
    path,
    encodeRecords([
      { type: 'session', version: 4, id: 's1' },
      instructionsRecord('AGENTS.md', content),
    ]),
  );

  const result = runCli(['inject', path]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(
    result.stdout,
    `AGENTS.md · ${Buffer.byteLength(content)} · ${sha256(content)}\n`,
  );
});

test('CLI inject prints nothing for a session without instructions', async () => {
  const path = join(tempDir, 'no-instructions.v4.jsonl.zstd');
  await writeFile(path, encodeRecords([{ type: 'session', version: 4, id: 's1' }]));

  const result = runCli(['inject', path]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('CLI inject exits 2 with usage when no path is given', () => {
  const result = runCli(['inject']);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /missing path argument for inject/);
});

test('CLI report writes a JSON summary for a directory tree', async () => {
  const root = join(tempDir, 'report-cli');
  await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(
    join(root, 'session.v4.jsonl.zstd'),
    encodeRecords([
      { type: 'session', version: 4, id: 'outer' },
      { type: 'user/message', data: {} },
      { type: 'tool/call', data: { name: 'bash' } },
    ]),
  );
  await writeFile(
    join(root, 'nested', 'session.v4.jsonl.zstd'),
    encodeRecords([
      { type: 'session', version: 4, id: 'inner' },
      { type: 'assistant/message', data: { usage: { inputTokens: 3, outputTokens: 2 } } },
      { type: 'tool/call', data: { name: 'read' } },
    ]),
  );

  const result = runCli(['report', root]);
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.sessionCount, 2);
  assert.equal(report.messageCount, 2);
  assert.equal(report.toolCalls.total, 2);
  assert.deepEqual(
    report.sessions.map((session) => session.path),
    ['nested/session.v4.jsonl.zstd', 'session.v4.jsonl.zstd'],
  );
  assert.equal(report.tokenUsage.totalTokens, 5);
});

test('CLI report still prints the report but exits non-zero when a log is damaged', async () => {
  const root = join(tempDir, 'report-damaged');
  await mkdir(join(root, 'good'), { recursive: true });
  await mkdir(join(root, 'bad'), { recursive: true });
  await writeFile(
    join(root, 'good', 'session.v4.jsonl.zstd'),
    encodeRecords([{ type: 'session', version: 4, id: 'good' }]),
  );
  await writeFile(join(root, 'bad', 'session.v4.jsonl.zstd'), 'not zstd');

  const result = runCli(['report', root]);
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 session log\(s\) could not be read/);
  assert.equal(report.sessionCount, 1);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].path, 'bad/session.v4.jsonl.zstd');
});

test('CLI report exits 2 with usage when no directory is given', () => {
  const result = runCli(['report']);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /missing path argument for report/);
});
