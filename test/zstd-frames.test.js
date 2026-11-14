import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { constants, createZstdCompress, zstdCompressSync } from 'node:zlib';

import { decodeZstdFrames, splitZstdFrames, ZstdFrameError } from '../src/zstd-frames.js';

const partA =
  '{"type":"session_start","id":"s1"}\n' +
  '{"type":"message","role":"user","text":"hello"}\n';
const partB =
  '{"type":"message","role":"assistant","text":"hi"}\n' +
  '{"type":"session_end"}\n';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function twoFrameFixture() {
  // This is the real shape of session.v4.jsonl.zstd: two independently
  // compressed JSONL segments, concatenated without any container.
  const first = zstdCompressSync(Buffer.from(partA));
  const second = zstdCompressSync(Buffer.from(partB));

  return { first, second, fixture: Buffer.concat([first, second]) };
}

function countMagic(buffer) {
  let count = 0;

  for (let index = 0; index <= buffer.length - ZSTD_MAGIC.length; index += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, ZSTD_MAGIC.length, index, index + ZSTD_MAGIC.length) === 0) {
      count += 1;
    }
  }

  return count;
}

function lineCount(text) {
  return text.split('\n').filter((line) => line.length > 0).length;
}

function skippableFrame(payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x184d2a50, 0);
  header.writeUInt32LE(payload.length, 4);

  return Buffer.concat([header, payload]);
}

async function compressStream(chunks) {
  const compressor = createZstdCompress();
  const output = [];
  compressor.on('data', (chunk) => output.push(chunk));
  const ended = once(compressor, 'end');

  for (const chunk of chunks) compressor.write(Buffer.from(chunk));
  compressor.end();
  await ended;

  return Buffer.concat(output);
}

test('splits concatenated frames at their real boundaries', () => {
  const { first, second, fixture } = twoFrameFixture();

  assert.equal(countMagic(fixture), 2);

  const frames = splitZstdFrames(fixture);

  assert.deepEqual(
    frames.map((frame) => ({ offset: frame.offset, length: frame.length })),
    [
      { offset: 0, length: first.length },
      { offset: first.length, length: second.length },
    ],
  );
});

test('decodes both frames and keeps every JSONL line', () => {
  const { fixture } = twoFrameFixture();
  const decoded = decodeZstdFrames(fixture).toString('utf8');

  assert.equal(decoded, partA + partB);
  assert.equal(lineCount(decoded), lineCount(partA) + lineCount(partB));
  assert.match(decoded, /"role":"user"/);
  assert.match(decoded, /"role":"assistant"/);
});

test('decodes a single-frame file', () => {
  const compressed = zstdCompressSync(Buffer.from(partA));

  assert.equal(splitZstdFrames(compressed).length, 1);
  assert.equal(decodeZstdFrames(compressed).toString('utf8'), partA);
});

test('decodes three frames in order', () => {
  const parts = ['{"n":1}\n', '{"n":2}\n{"n":3}\n', '{"n":4}\n'];
  const fixture = Buffer.concat(parts.map((part) => zstdCompressSync(Buffer.from(part))));

  assert.equal(decodeZstdFrames(fixture).toString('utf8'), parts.join(''));
});

test('decodes concatenated streaming frames that omit the content size', async () => {
  const makeRows = (id, count) =>
    `${Array.from({ length: count }, (_, index) => JSON.stringify({ stream: id, index })).join('\n')}\n`;
  const firstPart = makeRows(1, 1500);
  const secondPart = makeRows(2, 900);
  // A streaming compressor does not know the total size, so its frame omits
  // the content-size field (frame header descriptor has single_segment=0).
  const first = await compressStream([firstPart]);
  const second = await compressStream([secondPart]);
  const fixture = Buffer.concat([first, second]);

  assert.equal(splitZstdFrames(fixture).length, 2);
  assert.equal(decodeZstdFrames(fixture).toString('utf8'), firstPart + secondPart);
});

test('decodes a frame with a content checksum', () => {
  const compressed = zstdCompressSync(Buffer.from(partA), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  });

  assert.equal(decodeZstdFrames(compressed).toString('utf8'), partA);
});

test('skips standard skippable frames', () => {
  const compressed = zstdCompressSync(Buffer.from(partA));
  const fixture = Buffer.concat([skippableFrame(Buffer.from('metadata')), compressed]);

  const frames = splitZstdFrames(fixture);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].skippable, true);
  assert.equal(decodeZstdFrames(fixture).toString('utf8'), partA);
});

test('rejects an empty file', () => {
  assert.throws(() => decodeZstdFrames(Buffer.alloc(0)), /input is empty/);
});

test('rejects data that does not start with a zstd frame', () => {
  assert.throws(
    () => decodeZstdFrames(Buffer.from('not zstd')),
    (error) => {
      assert.ok(error instanceof ZstdFrameError);
      assert.match(error.message, /invalid zstd frame magic/);
      assert.equal(error.offset, 0);
      return true;
    },
  );
});

test('rejects a truncated trailing frame instead of silently dropping it', () => {
  const { first, fixture } = twoFrameFixture();
  const truncated = fixture.subarray(0, first.length + 5);

  assert.throws(
    () => decodeZstdFrames(truncated),
    (error) => {
      assert.ok(error instanceof ZstdFrameError);
      assert.match(error.message, /truncated zstd frame/);
      assert.ok(error.offset >= first.length);
      return true;
    },
  );
});

test('rejects trailing garbage after the last frame', () => {
  const compressed = zstdCompressSync(Buffer.from(partA));
  const withGarbage = Buffer.concat([compressed, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);

  assert.throws(() => decodeZstdFrames(withGarbage), /invalid zstd frame magic/);
});
