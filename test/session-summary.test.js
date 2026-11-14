import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import { summarizeDirectory, summarizeSession } from '../src/session-summary.js';

let tempDir;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dsh-summary-'));
});

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function encode(records, { frames = 1 } = {}) {
  const lines = records.map((record) => JSON.stringify(record));
  const perFrame = Math.ceil(lines.length / frames);
  const chunks = [];

  for (let start = 0; start < lines.length; start += perFrame) {
    const text = `${lines.slice(start, start + perFrame).join('\n')}\n`;
    chunks.push(zstdCompressSync(Buffer.from(text)));
  }

  return Buffer.concat(chunks);
}

function usage(inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

test('summarizes one session: messages, tools and token usage', () => {
  const records = [
    { type: 'session', version: 4, id: 's1' },
    { type: 'user/message', data: { role: 'user', content: [] } },
    {
      type: 'assistant/message',
      data: { role: 'assistant', content: [], usage: usage(10, 5, 2, 1) },
    },
    {
      type: 'assistant/message',
      data: { role: 'assistant', content: [], usage: usage(4, 1) },
    },
    { type: 'tool/call', data: { name: 'bash' } },
    { type: 'tool/call', data: { name: 'bash' } },
    { type: 'tool/call', data: { name: 'read' } },
    { type: 'tool/call', data: {} },
    { type: 'tool/result', data: {} },
  ];

  const summary = summarizeSession(records, { path: 'a/session.v4.jsonl.zstd' });

  assert.equal(summary.path, 'a/session.v4.jsonl.zstd');
  assert.equal(summary.id, 's1');
  assert.equal(summary.messageCount, 3);
  assert.equal(summary.toolCallCount, 4);
  assert.deepEqual(summary.tokens, {
    inputTokens: 14,
    outputTokens: 6,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    totalTokens: 23,
  });
  assert.deepEqual([...summary.toolCallsByName], [
    ['bash', 2],
    ['read', 1],
    ['unknown', 1],
  ]);
});

test('a session without usage records reports no token usage', () => {
  const records = [
    { type: 'session', version: 4, id: 's2' },
    { type: 'user/message', data: { role: 'user', content: [] } },
  ];

  assert.equal(summarizeSession(records).tokens, null);
});

test('walks a directory recursively and aggregates every session log', async () => {
  const root = join(tempDir, 'report-tree');
  await mkdir(join(root, 'alpha'), { recursive: true });
  await mkdir(join(root, 'nested', 'beta'), { recursive: true });
  await mkdir(join(root, 'empty'), { recursive: true });

  await writeFile(
    join(root, 'alpha', 'session.v4.jsonl.zstd'),
    encode([
      { type: 'session', version: 4, id: 'alpha' },
      { type: 'user/message', data: {} },
      { type: 'assistant/message', data: { usage: usage(10, 5) } },
      { type: 'tool/call', data: { name: 'bash' } },
      { type: 'tool/call', data: { name: 'bash' } },
    ]),
  );
  await writeFile(
    join(root, 'nested', 'beta', 'session.v4.jsonl.zstd'),
    encode(
      [
        { type: 'session', version: 4, id: 'beta' },
        { type: 'user/message', data: {} },
        { type: 'assistant/message', data: {} },
        { type: 'user/message', data: {} },
        { type: 'tool/call', data: { name: 'read' } },
      ],
      { frames: 2 },
    ),
  );
  await writeFile(join(root, 'nested', 'beta', 'notes.txt'), 'not a session');

  const report = await summarizeDirectory(root);

  assert.equal(report.directory, root);
  assert.equal(report.sessionCount, 2);
  assert.equal(report.messageCount, 5);
  assert.deepEqual(report.toolCalls, {
    total: 3,
    byName: [
      { name: 'bash', count: 2 },
      { name: 'read', count: 1 },
    ],
  });
  assert.deepEqual(report.tokenUsage, usage(10, 5));
  assert.deepEqual(
    report.sessions.map((session) => ({
      path: session.path,
      id: session.id,
      messageCount: session.messageCount,
      toolCallCount: session.toolCallCount,
      tokenUsage: session.tokenUsage,
    })),
    [
      {
        path: 'alpha/session.v4.jsonl.zstd',
        id: 'alpha',
        messageCount: 2,
        toolCallCount: 2,
        tokenUsage: usage(10, 5),
      },
      {
        path: 'nested/beta/session.v4.jsonl.zstd',
        id: 'beta',
        messageCount: 3,
        toolCallCount: 1,
        tokenUsage: null,
      },
    ],
  );
  assert.deepEqual(report.errors, []);
});

test('an empty directory and a directory without session logs report zero sessions', async () => {
  const empty = join(tempDir, 'empty-dir');
  await mkdir(join(empty, 'nested'), { recursive: true });
  await writeFile(join(empty, 'nested', 'README.md'), 'no sessions here');

  const report = await summarizeDirectory(empty);

  assert.equal(report.sessionCount, 0);
  assert.equal(report.messageCount, 0);
  assert.deepEqual(report.toolCalls, { total: 0, byName: [] });
  assert.equal(report.tokenUsage, null);
  assert.deepEqual(report.sessions, []);
  assert.deepEqual(report.errors, []);
});

test('reports a damaged session log without hiding the healthy ones', async () => {
  const root = join(tempDir, 'damaged');
  await mkdir(join(root, 'good'), { recursive: true });
  await mkdir(join(root, 'bad'), { recursive: true });

  await writeFile(
    join(root, 'good', 'session.v4.jsonl.zstd'),
    encode([{ type: 'session', version: 4, id: 'good' }]),
  );
  await writeFile(
    join(root, 'bad', 'session.v4.jsonl.zstd'),
    Buffer.from('this is not zstd'),
  );

  const report = await summarizeDirectory(root);

  assert.equal(report.sessionCount, 1);
  assert.equal(report.sessions[0].id, 'good');
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].path, 'bad/session.v4.jsonl.zstd');
  assert.match(report.errors[0].error, /invalid zstd frame magic/);
});
