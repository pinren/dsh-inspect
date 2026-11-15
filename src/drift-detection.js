import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/**
 * Compare the injection manifest of a session with the files currently on disk.
 *
 * The manifest records the path, byte length and sha256 of the instructions a
 * session received. This module only reads those paths; it never writes or
 * repairs anything, and a file that can no longer be read is reported as
 * `missing` instead of aborting the whole comparison.
 */

const STATUS_ORDER = {
  changed: 0,
  missing: 1,
  unchanged: 2,
};

/**
 * Expand a leading `~` the way a shell would. DSH records the expanded absolute
 * path in real sessions, but hand-written fixtures commonly keep `~/`; both
 * forms must resolve.
 *
 * @param {string} path
 * @param {string} [home]
 * @returns {string}
 */
export function expandHome(path, home = homedir()) {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home}${path.slice(1)}`;
  return path;
}

/**
 * Resolve a manifest path to the file it refers to: relative paths are resolved
 * against the current working directory, absolute paths are used as-is.
 *
 * @param {string} manifestPath
 * @param {{ cwd?: string, home?: string }} [options]
 * @returns {string}
 */
export function resolveManifestPath(manifestPath, { cwd = process.cwd(), home = homedir() } = {}) {
  const expanded = expandHome(manifestPath, home);

  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * Read a file and describe its current content. Returns `null` when the path
 * cannot be read as a regular file (ENOENT, EACCES, a directory, ...), which the
 * caller reports as `missing`.
 *
 * @param {string} absolutePath
 * @returns {Promise<{ bytes: number, sha256: string }|null>}
 */
async function fingerprintFile(absolutePath) {
  let info;

  try {
    info = await stat(absolutePath);
  } catch {
    return null;
  }

  if (!info.isFile()) return null;

  let content;

  try {
    content = await readFile(absolutePath);
  } catch {
    return null;
  }

  return {
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

/**
 * Compare every manifest entry with its current file on disk.
 *
 * @param {{ path: string, bytes: number, sha256: string }[]} entries
 * @param {{ cwd?: string, home?: string }} [options]
 * @returns {Promise<{
 *   status: 'unchanged'|'changed'|'missing',
 *   path: string,
 *   injectedBytes: number,
 *   currentBytes: number|null,
 * }[]>} results in manifest order
 */
export async function detectDrift(entries, options = {}) {
  const results = [];

  for (const entry of entries) {
    const current = await fingerprintFile(resolveManifestPath(entry.path, options));

    results.push({
      status: current === null
        ? 'missing'
        : current.sha256 === entry.sha256
          ? 'unchanged'
          : 'changed',
      path: entry.path,
      injectedBytes: entry.bytes,
      currentBytes: current === null ? null : current.bytes,
    });
  }

  return results;
}

/**
 * @param {{ status: string, path: string, injectedBytes: number, currentBytes: number|null }[]} results
 * @returns {boolean} whether any file changed or disappeared
 */
export function hasDrift(results) {
  return results.some((result) => result.status !== 'unchanged');
}

/**
 * Render one tab-separated line per file, sorted changed → missing → unchanged.
 * Files that share a status keep their manifest order.
 *
 * `missing` lines end with `-` because the current byte count is unknown, and
 * `unchanged` lines omit the current byte count because it equals the injected
 * one.
 *
 * @param {{ status: string, path: string, injectedBytes: number, currentBytes: number|null }[]} results
 * @returns {string} report without a trailing newline
 */
export function formatDriftReport(results) {
  return [...results]
    .sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status])
    .map((result) => {
      if (result.status === 'missing') {
        return `${result.status}\t${result.path}\t${result.injectedBytes}\t-`;
      }

      if (result.status === 'changed') {
        return `${result.status}\t${result.path}\t${result.injectedBytes}\t${result.currentBytes}`;
      }

      return `${result.status}\t${result.path}\t${result.injectedBytes}`;
    })
    .join('\n');
}
