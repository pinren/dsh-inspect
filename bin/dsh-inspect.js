#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';

import {
  extractInjectionManifest,
  formatInjectionManifest,
  InstructionManifestError,
} from '../src/instruction-manifest.js';
import { parseSessionLog, SessionLogError } from '../src/session-log.js';
import { summarizeDirectory } from '../src/session-summary.js';
import { decodeZstdFrames, ZstdFrameError } from '../src/zstd-frames.js';

const USAGE = [
  'Usage: dsh-inspect <path-to-session.v4.jsonl.zstd>',
  '       dsh-inspect inject <path-to-session.v4.jsonl.zstd>',
  '       dsh-inspect report <directory>',
].join('\n');

class FileReadError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FileReadError';
  }
}

const KNOWN_ERRORS = [
  ZstdFrameError,
  SessionLogError,
  InstructionManifestError,
  FileReadError,
];

function fail(message) {
  process.stderr.write(`dsh-inspect: ${message}\n`);
}

function explain(error) {
  if (KNOWN_ERRORS.some((type) => error instanceof type)) return error.message;
  return `unexpected error: ${error.message}`;
}

function failForPath(path, error) {
  fail(
    error instanceof FileReadError
      ? error.message
      : `${JSON.stringify(path)}: ${explain(error)}`,
  );
}

async function writeStdout(bytes) {
  if (bytes.length === 0) return;

  await new Promise((resolve, reject) => {
    process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

async function readSessionLog(path) {
  let input;

  try {
    input = await readFile(path);
  } catch (error) {
    throw new FileReadError(
      `cannot read ${JSON.stringify(path)}: ${error.message}`,
      error,
    );
  }

  return input;
}

function usageError(args, command) {
  if (command === undefined) {
    fail(
      args.length === 0
        ? `missing path argument\n${USAGE}`
        : `expected exactly one path argument, got ${args.length}\n${USAGE}`,
    );
  } else {
    fail(
      args.length === 0
        ? `missing path argument for ${command}\n${USAGE}`
        : `expected exactly one path argument for ${command}, got ${args.length}\n${USAGE}`,
    );
  }

  return 2;
}

async function decodeCommand(args) {
  if (args.length !== 1) return usageError(args);

  const path = args[0];
  let output;

  try {
    output = decodeZstdFrames(await readSessionLog(path));
  } catch (error) {
    failForPath(path, error);
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

async function injectCommand(args) {
  if (args.length !== 1) return usageError(args, 'inject');

  const path = args[0];
  let manifest;

  try {
    manifest = extractInjectionManifest(
      parseSessionLog(decodeZstdFrames(await readSessionLog(path))),
    );
  } catch (error) {
    failForPath(path, error);
    return 1;
  }

  const text = formatInjectionManifest(manifest);

  try {
    if (text !== '') await writeStdout(`${text}\n`);
  } catch (error) {
    fail(`cannot write injection manifest: ${error.message}`);
    return 1;
  }

  return 0;
}

async function reportCommand(args) {
  if (args.length !== 1) return usageError(args, 'report');

  const directory = args[0];
  let report;

  try {
    report = await summarizeDirectory(directory);
  } catch (error) {
    fail(`cannot read ${JSON.stringify(directory)}: ${error.message}`);
    return 1;
  }

  try {
    await writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    fail(`cannot write summary report: ${error.message}`);
    return 1;
  }

  if (report.errors.length > 0) {
    fail(
      `${report.errors.length} session log(s) could not be read; see "errors" in the report`,
    );
    return 1;
  }

  return 0;
}

async function main(args) {
  const [command, ...rest] = args;

  if (command === 'inject') return injectCommand(rest);
  if (command === 'report') return reportCommand(rest);

  return decodeCommand(args);
}

process.exitCode = await main(process.argv.slice(2));
