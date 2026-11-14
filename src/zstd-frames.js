import { zstdDecompressSync } from 'node:zlib';

const FRAME_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;

const BYTES_PER_DICTIONARY_ID_FLAG = [0, 1, 2, 4];
const BYTES_PER_CONTENT_SIZE_FLAG = [0, 2, 4, 8];

/**
 * Error raised for anything that stops the input from being decoded as a
 * sequence of complete zstd frames. `offset` is the byte offset in the input
 * where the problem was detected.
 */
export class ZstdFrameError extends Error {
  constructor(message, offset, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ZstdFrameError';
    this.offset = offset;
  }
}

function requireBytes(buffer, offset, count, what) {
  if (offset + count > buffer.length) {
    throw new ZstdFrameError(
      `truncated zstd frame at byte ${offset}: need ${count} byte(s) for ${what}, but only ${buffer.length - offset} remain`,
      offset,
    );
  }
}

/**
 * Walk a buffer of concatenated zstd frames and return each frame's byte range.
 *
 * The boundaries come from the zstd frame/block headers, not from searching for
 * the magic number: compressed payload bytes may legitimately contain the magic
 * sequence, so scanning for it would split frames in the wrong place.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {{ offset: number, length: number, skippable: boolean }[]}
 */
export function splitZstdFrames(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer.length - offset < 4) {
      throw new ZstdFrameError(
        `trailing bytes at byte ${offset}: expected a zstd frame magic, but only ${buffer.length - offset} byte(s) remain`,
        offset,
      );
    }

    const magic = buffer.readUInt32LE(offset);

    if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
      requireBytes(buffer, offset, 8, 'skippable frame header');
      const payloadSize = buffer.readUInt32LE(offset + 4);
      requireBytes(buffer, offset + 8, payloadSize, 'skippable frame payload');
      frames.push({ offset, length: 8 + payloadSize, skippable: true });
      offset += 8 + payloadSize;
      continue;
    }

    if (magic !== FRAME_MAGIC) {
      throw new ZstdFrameError(
        `invalid zstd frame magic 0x${magic.toString(16)} at byte ${offset}; expected 0x${FRAME_MAGIC.toString(16)}`,
        offset,
      );
    }

    const frameStart = offset;
    offset += 4;

    requireBytes(buffer, offset, 1, 'frame header descriptor');
    const descriptor = buffer[offset];
    offset += 1;

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor >>> 5) & 1;
    const hasChecksum = (descriptor >>> 2) & 1;
    const dictionaryIdFlag = descriptor & 3;

    if (!singleSegment) {
      requireBytes(buffer, offset, 1, 'window descriptor');
      offset += 1;
    }

    const dictionaryIdSize = BYTES_PER_DICTIONARY_ID_FLAG[dictionaryIdFlag];
    requireBytes(buffer, offset, dictionaryIdSize, 'dictionary id');
    offset += dictionaryIdSize;

    const contentSizeSize =
      contentSizeFlag === 0
        ? singleSegment
          ? 1
          : 0
        : BYTES_PER_CONTENT_SIZE_FLAG[contentSizeFlag];
    requireBytes(buffer, offset, contentSizeSize, 'frame content size');
    offset += contentSizeSize;

    for (;;) {
      requireBytes(buffer, offset, 3, 'block header');
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;

      const lastBlock = blockHeader & 1;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;

      if (blockType === 3) {
        throw new ZstdFrameError(
          `reserved zstd block type at byte ${offset - 3} inside frame at byte ${frameStart}`,
          offset - 3,
        );
      }

      if (blockType === 1) {
        // RLE block: one stored byte regenerates `blockSize` bytes.
        requireBytes(buffer, offset, 1, 'RLE block byte');
        offset += 1;
      } else {
        requireBytes(buffer, offset, blockSize, 'block payload');
        offset += blockSize;
      }

      if (lastBlock) break;
    }

    if (hasChecksum) {
      requireBytes(buffer, offset, 4, 'content checksum');
      offset += 4;
    }

    frames.push({ offset: frameStart, length: offset - frameStart, skippable: false });
  }

  if (frames.length === 0) {
    throw new ZstdFrameError('input is empty; expected at least one zstd frame', 0);
  }

  return frames;
}

/**
 * Decode every zstd frame in `input`, in order, and return the concatenated
 * uncompressed bytes.
 *
 * `zlib.zstdDecompressSync()` stops after the first frame when it receives a
 * concatenated stream, so each frame is decompressed separately.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {Buffer}
 */
export function decodeZstdFrames(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const frames = splitZstdFrames(buffer);
  const chunks = [];
  let dataFrameCount = 0;

  for (const frame of frames) {
    if (frame.skippable) continue;

    dataFrameCount += 1;
    const frameBytes = buffer.subarray(frame.offset, frame.offset + frame.length);

    try {
      chunks.push(zstdDecompressSync(frameBytes));
    } catch (cause) {
      throw new ZstdFrameError(
        `frame ${dataFrameCount} at byte ${frame.offset} could not be decompressed: ${cause.message}`,
        frame.offset,
        cause,
      );
    }
  }

  if (dataFrameCount === 0) {
    throw new ZstdFrameError('input contains only skippable zstd frames; nothing to decode', 0);
  }

  return Buffer.concat(chunks);
}
