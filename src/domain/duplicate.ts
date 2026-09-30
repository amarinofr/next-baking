/** Auto-numbered duplicate names — same "(N)" scheme as the legacy app. */

const SUFFIX_RE = /\s*\((\d+)\)$/;

export interface ParsedName { base: string; n: number }

/** "Pizza (3)" → { base: "Pizza", n: 3 } ; "Pizza" → { base: "Pizza", n: 0 } */
export function parseDuplicateName(name: string): ParsedName {
  const trimmed = name.trim();
  const match = SUFFIX_RE.exec(trimmed);
  if (!match) return { base: trimmed, n: 0 };
  return { base: trimmed.slice(0, match.index).trim(), n: Number(match[1]) };
}

/**
 * Next free name for a duplicate.
 * Legacy behaviour scanned `base (` prefixes; this version strips an existing
 * "(N)" suffix first so duplicating "Pizza (1)" yields "Pizza (2)" instead of
 * "Pizza (1) (2)". Collisions with any existing name are avoided.
 */
export function nextDuplicateName(baseName: string, existingNames: Iterable<string>): string {
  const base = parseDuplicateName(baseName).base;
  const taken = new Set<string>();
  let maxN = 0;
  for (const name of existingNames) {
    const parsed = parseDuplicateName(name);
    if (parsed.base !== base) continue;
    taken.add(name.trim());
    if (parsed.n > maxN) maxN = parsed.n;
  }
  let candidate = `${base} (${maxN + 1})`;
  while (taken.has(candidate)) {
    maxN += 1;
    candidate = `${base} (${maxN + 1})`;
  }
  return candidate;
}
