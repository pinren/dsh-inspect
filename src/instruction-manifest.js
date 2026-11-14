import { createHash } from 'node:crypto';

/**
 * Extract the AGENTS.md chain a DSH session was actually injected with.
 *
 * DSH writes workspace instructions to the session log as user messages whose
 * `source.kind` is `agent-instructions`. The message text is a
 * `<system-reminder>` frame containing one section per instruction file:
 *
 *   Instructions from: <path>            complete baseline
 *   Additional instructions from: <path> file added after the baseline
 *   Updated instructions from: <path>    file replaced after the baseline
 *   Instructions removed: <path>         file withdrawn
 *
 * Later records are applied on top of earlier ones, so replaying them in log
 * order yields the instructions active at the end of the session. A record that
 * carries a complete baseline resets the chain first, because DSH renders such
 * a baseline as a replacement for every earlier baseline.
 *
 * Sizes and digests are computed over the instruction content recorded in the
 * log, not by reading the file from disk. That is deliberate: the manifest
 * describes what the session actually received, including a file that was
 * truncated to fit the instruction budget or changed later on disk.
 */

const HEADER_PATTERN =
  /^(Instructions removed|Additional instructions from|Updated instructions from|Instructions from): (.*)$/gm;

const REMINDER_CLOSE = '</system-reminder>';
const REPLACEMENT_BASELINE_MARKER =
  'This complete workspace instruction baseline replaces all earlier workspace instruction baselines.';

/** Raised when an `agent-instructions` message does not match the documented frame layout. */
export class InstructionManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstructionManifestError';
  }
}

function messageText(record) {
  const content = record?.data?.content;

  if (!Array.isArray(content)) return '';

  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function instructionRecords(records) {
  return records.filter(
    (record) =>
      record?.type === 'user/message' &&
      record?.data?.source?.kind === 'agent-instructions',
  );
}

/**
 * Parse the sections of one rendered instruction frame.
 *
 * Each section starts at a heading line. The frame renders blocks joined by a
 * blank line and leaves the file content byte-for-byte intact, so the content
 * of a section is everything up to the next heading (or the closing tag) with
 * the two joining newlines removed. A section at the end of the frame is joined
 * to the closing tag with a single newline.
 *
 * @param {string} text
 * @param {{ allowedPaths?: Set<string> }} [options] paths named by the record's
 *   `changes`; heading-shaped lines inside file content are ignored when given
 * @returns {{ kind: 'baseline'|'additional'|'updated'|'removed', path: string, content: string|null }[]}
 */
export function parseInstructionSections(text, { allowedPaths } = {}) {
  const allHeadings = [...text.matchAll(HEADER_PATTERN)];
  let headings = allHeadings;

  if (allowedPaths !== undefined) {
    const allowed = allHeadings.filter((heading) => allowedPaths.has(heading[2]));
    // A render whose `changes` do not use the same display paths should still be
    // inspectable rather than silently producing an empty manifest.
    headings = allowed.length > 0 ? allowed : allHeadings;
  }

  if (headings.length === 0) return [];

  const closeIndex = text.lastIndexOf(REMINDER_CLOSE);

  if (closeIndex < 0) {
    throw new InstructionManifestError(
      'instruction message has headings but no closing </system-reminder> tag',
    );
  }

  const sections = [];

  for (const [index, heading] of headings.entries()) {
    const label = heading[1];
    const path = heading[2];
    const kind = label === 'Instructions from'
      ? 'baseline'
      : label === 'Additional instructions from'
        ? 'additional'
        : label === 'Updated instructions from'
          ? 'updated'
          : 'removed';

    const sectionEnd = index + 1 < headings.length ? headings[index + 1].index : closeIndex;
    let raw = text.slice(heading.index + heading[0].length, sectionEnd);

    if (!raw.startsWith('\n\n')) {
      throw new InstructionManifestError(
        `instruction heading for ${path} is not followed by a blank line`,
      );
    }

    raw = raw.slice(2);

    const trailingNewlines = index + 1 < headings.length ? 2 : 1;

    if (raw.endsWith('\n'.repeat(trailingNewlines))) {
      raw = raw.slice(0, -trailingNewlines);
    } else {
      throw new InstructionManifestError(
        `instruction section for ${path} is not separated from the next block by a blank line`,
      );
    }

    if (kind === 'removed') {
      sections.push({ kind, path, content: null });
      continue;
    }

    if (kind === 'additional' || kind === 'updated') {
      // Both forms insert one explanatory paragraph between the heading and the
      // file content: the scope sentence for additional files, the "this file
      // changed" notice for replacements.
      const paragraphEnd = raw.indexOf('\n\n');

      if (paragraphEnd < 0) {
        throw new InstructionManifestError(
          `instruction section for ${path} has no content after its notice paragraph`,
        );
      }

      raw = raw.slice(paragraphEnd + 2);
    }

    sections.push({ kind, path, content: raw });
  }

  return sections;
}

/**
 * @param {unknown[]} records records from one decoded session log
 * @returns {{ path: string, bytes: number, sha256: string }[]} active chain in injection order
 */
export function extractInjectionManifest(records) {
  /** @type {Map<string, string>} */
  const chain = new Map();

  for (const record of instructionRecords(records)) {
    const text = messageText(record);

    if (text === '') continue;

    // The `changes` list names the files this render actually represents. Use it
    // to ignore heading-shaped lines that belong to file content (for example a
    // README that documents this very frame format).
    const changedPaths = new Set(
      (Array.isArray(record.data.source.changes) ? record.data.source.changes : [])
        .map((change) => change?.path)
        .filter((path) => typeof path === 'string'),
    );
    const sections = parseInstructionSections(
      text,
      changedPaths.size === 0 ? {} : { allowedPaths: changedPaths },
    );

    if (sections.length === 0) {
      // An empty replacement baseline explicitly clears every earlier file.
      if (text.includes(REPLACEMENT_BASELINE_MARKER)) chain.clear();
      continue;
    }

    if (sections.some((section) => section.kind === 'baseline')) {
      chain.clear();
    }

    for (const section of sections) {
      if (section.kind === 'removed') {
        chain.delete(section.path);
      } else {
        chain.set(section.path, section.content ?? '');
      }
    }
  }

  return [...chain].map(([path, content]) => {
    const bytes = Buffer.from(content, 'utf8');

    return {
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

/**
 * @param {{ path: string, bytes: number, sha256: string }[]} entries
 * @returns {string} one `path · bytes · sha256` line per file, without a trailing newline
 */
export function formatInjectionManifest(entries) {
  return entries
    .map((entry) => `${entry.path} · ${entry.bytes} · ${entry.sha256}`)
    .join('\n');
}
