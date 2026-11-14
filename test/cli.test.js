import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
