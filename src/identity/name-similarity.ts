/**
 * Fuzzy name matching for dedup Tier E (`.agents/skills/alias-identity.md`:
 * "identical E.164 phone and name similarity >= 0.9"; prompts/010 Assumption 7
 * repurposes the same threshold for name-only matching, since no phone data
 * exists yet). No fuzzy-match package exists in this project and neither Bun
 * nor Node's stdlib has one — a normalised Levenshtein ratio is the whole
 * implementation (prompts/010 Assumption 8, Bun-native check: not a dependency).
 */

function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Classic O(n*m) edit distance, single-row DP. */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previousRow = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i += 1) {
    const currentRow = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(
        Math.min(
          previousRow[j]! + 1, // deletion
          currentRow[j - 1]! + 1, // insertion
          previousRow[j - 1]! + cost, // substitution
        ),
      );
    }
    previousRow = currentRow;
  }

  return previousRow[b.length]!;
}

/**
 * 0–1 similarity between two names, normalised (trim, lowercase, collapse
 * whitespace) before comparison. Idempotent: `nameSimilarity(normalise(a), a)`
 * is unaffected by re-normalising. Two empty names are identical (`1`); one
 * empty and one not are maximally dissimilar (`0`).
 */
export function nameSimilarity(a: string, b: string): number {
  const left = normalise(a);
  const right = normalise(b);
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 1;

  return 1 - levenshteinDistance(left, right) / maxLength;
}
