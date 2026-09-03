/**
 * Subsequence match, the way every command palette works: `gc` finds
 * "Start GC frontend" because g and c appear in order, not adjacently.
 *
 * Returns a score, or null when the query does not appear at all. Lower is
 * better.
 */
export function score(query: string, text: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()

  let at = 0
  let total = 0
  let previous = -1

  for (const char of q) {
    const found = t.indexOf(char, at)
    if (found === -1) return null
    // A gap between matched characters is what makes a match feel like a
    // stretch, so it is what the score counts.
    total += previous === -1 ? found : found - previous - 1
    // Landing at the start of a word beats landing mid-word, so typing `res`
    // puts "Restart api" above "Configure forest".
    if (found === 0 || t[found - 1] === ' ') total -= 2
    previous = found
    at = found + 1
  }
  return total
}
