/**
 * Parsing for the decoded contents of a `session.v4.jsonl.zstd` log.
 *
 * A session log is JSON Lines: one JSON value per line. Blank lines are
 * tolerated, but any line that is not valid JSON makes the whole log unusable
 * for inspection, so the error names the offending line instead of silently
 * skipping it.
 */

export class SessionLogError extends Error {
  /**
   * @param {string} message
   * @param {number} line 1-based line number in the decoded log
   * @param {Error} [cause]
   */
  constructor(message, line, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SessionLogError';
    this.line = line;
  }
}

/**
 * @param {string} text decoded JSONL
 * @returns {unknown[]}
 */
export function parseSessionLogText(text) {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = [];

  for (const [index, line] of input.split('\n').entries()) {
    if (line.trim() === '') continue;

    try {
      records.push(JSON.parse(line));
    } catch (cause) {
      throw new SessionLogError(
        `invalid JSON on line ${index + 1}: ${cause.message}`,
        index + 1,
        cause,
      );
    }
  }

  return records;
}

/**
 * @param {Buffer|Uint8Array|string} input decoded JSONL bytes
 * @returns {unknown[]}
 */
export function parseSessionLog(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);

  return parseSessionLogText(text);
}
