#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { decodeZstdFrames, ZstdFrameError } from '../src/zstd-frames.js';

const USAGE = 'Usage: dsh-inspect <path-to-session.v4.jsonl.zstd>';

function fail(message) {
  process.stderr.write(`dsh-inspect: ${message}\n`);
}

async function writeStdout(bytes) {
  if (bytes.length === 0) return;

  await new Promise((resolve, reject) => {
    process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

async function main(args) {
  if (args.length !== 1) {
    fail(
      args.length === 0
        ? `missing path argument\n${USAGE}`
        : `expected exactly one path argument, got ${args.length}\n${USAGE}`,
    );
    return 2;
  }

  const path = args[0];
  let input;

  try {
    input = await readFile(path);
  } catch (error) {
    fail(`cannot read ${JSON.stringify(path)}: ${error.message}`);
    return 1;
  }

  let output;

  try {
    output = decodeZstdFrames(input);
  } catch (error) {
    if (error instanceof ZstdFrameError) {
      fail(`${JSON.stringify(path)}: ${error.message}`);
      return 1;
    }

    fail(`${JSON.stringify(path)}: unexpected error while decoding: ${error.message}`);
    return 1;
  }

  try {
    await writeStdout(output);
  } catch (error) {
    fail(`cannot write decoded output: ${error.message}`);
    return 1;
  }

  return 0;
}

process.exitCode = await main(process.argv.slice(2));
