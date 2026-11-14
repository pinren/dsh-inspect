import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { parseSessionLog } from './session-log.js';
import { decodeZstdFrames } from './zstd-frames.js';

/**
 * Summarize every `session.v4.jsonl.zstd` below a directory.
 *
 * The report is intentionally plain data: session count, per-session message
 * counts, tool-call counts grouped by tool name and, when the log contains it,
 * token usage. A session that cannot be read or decoded is reported in
 * `errors` instead of aborting the whole report, so one damaged log does not
 * hide every other session.
 */

export const SESSION_FILENAME = 'session.v4.jsonl.zstd';

const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
];

function emptyTokens() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

function tokenCount(value) {
  return Number.isFinite(value) ? value : 0;
}

function addUsage(target, usage) {
  const computedTotal =
    tokenCount(usage.inputTokens) +
    tokenCount(usage.outputTokens) +
    tokenCount(usage.cacheReadTokens) +
    tokenCount(usage.cacheWriteTokens);

  for (const field of TOKEN_FIELDS) target[field] += tokenCount(usage[field]);
  target.totalTokens += Number.isFinite(usage.totalTokens)
    ? usage.totalTokens
    : computedTotal;
}

function sessionIdOf(records) {
  const session = records.find(
    (record) => record?.type === 'session' && typeof record.id === 'string',
  );

  return session?.id ?? null;
}

/**
 * @param {unknown[]} records records from one decoded session log
 * @param {{ path?: string|null }} [options]
 * @returns {{
 *   path: string|null,
 *   id: string|null,
 *   messageCount: number,
 *   toolCallCount: number,
 *   tokens: ReturnType<typeof emptyTokens>|null,
 *   toolCallsByName: Map<string, number>,
 * }}
 */
export function summarizeSession(records, { path = null } = {}) {
  let messageCount = 0;
  let toolCallCount = 0;
  let sawUsage = false;
  let tokens = emptyTokens();
  const toolCallsByName = new Map();

  for (const record of records) {
    if (record?.type === 'user/message' || record?.type === 'assistant/message') {
      messageCount += 1;
    }

    if (record?.type === 'tool/call') {
      const name = typeof record.data?.name === 'string' && record.data.name !== ''
        ? record.data.name
        : 'unknown';

      toolCallCount += 1;
      toolCallsByName.set(name, (toolCallsByName.get(name) ?? 0) + 1);
    }

    if (record?.type === 'assistant/message' && record.data?.usage) {
      sawUsage = true;
      addUsage(tokens, record.data.usage);
    }
  }

  return {
    path,
    id: sessionIdOf(records),
    messageCount,
    toolCallCount,
    tokens: sawUsage ? tokens : null,
    toolCallsByName,
  };
}

function mergeUsage(target, usage) {
  for (const field of TOKEN_FIELDS) target[field] += usage[field];
  target.totalTokens += usage.totalTokens;
}

/**
 * Recursively list session logs below `root`, in stable sorted order.
 * Symbolic links are not followed, which keeps traversal free of cycles and
 * makes the report reflect the directory tree that actually contains the logs.
 *
 * @param {string} root absolute directory
 * @returns {Promise<string[]>} absolute file paths
 */
export async function findSessionLogs(root) {
  const found = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name));
      } else if (entry.isFile() && entry.name === SESSION_FILENAME) {
        found.push(join(directory, entry.name));
      }
    }
  }

  await walk(root);
  found.sort();

  return found;
}

function relativeReportPath(root, file) {
  return relative(root, file).split(sep).join('/');
}

/**
 * @param {string} directory
 * @returns {Promise<object>} report ready for JSON serialization
 */
export async function summarizeDirectory(directory) {
  const root = resolve(directory);
  const files = await findSessionLogs(root);
  const sessions = [];
  const errors = [];
  let messageCount = 0;
  let toolCallCount = 0;
  let tokens = emptyTokens();
  let sawUsage = false;
  const toolCallsByName = new Map();

  for (const file of files) {
    const reportPath = relativeReportPath(root, file);

    try {
      const decoded = decodeZstdFrames(await readFile(file));
      const summary = summarizeSession(parseSessionLog(decoded), { path: reportPath });

      messageCount += summary.messageCount;
      toolCallCount += summary.toolCallCount;

      for (const [name, count] of summary.toolCallsByName) {
        toolCallsByName.set(name, (toolCallsByName.get(name) ?? 0) + count);
      }

      if (summary.tokens !== null) {
        sawUsage = true;
        mergeUsage(tokens, summary.tokens);
      }

      sessions.push({
        path: reportPath,
        id: summary.id,
        messageCount: summary.messageCount,
        toolCallCount: summary.toolCallCount,
        tokenUsage: summary.tokens,
      });
    } catch (error) {
      errors.push({
        path: reportPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const byName = [...toolCallsByName]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

  return {
    directory: root,
    sessionCount: sessions.length,
    messageCount,
    toolCalls: {
      total: toolCallCount,
      byName,
    },
    tokenUsage: sawUsage ? tokens : null,
    sessions,
    errors,
  };
}
