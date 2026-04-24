// sound_map.js — Letter similarity groups for aviation phonetic matching
// Letters in the same group are considered "sound-alike" and get partial credit

const SOUND_GROUPS = [
  "EI",      // short vowels: Echo / India
  "AE",      // broad vowels: Alpha / Echo
  "OU",      // rounded vowels: Oscar / Uniform
  "BP",      // bilabial stops
  "DT",      // alveolar stops
  "GKC",     // velar/hard stops
  "FV",      // labiodental fricatives
  "SZC",     // sibilants
  "MN",      // nasals
  "LR",      // liquids
  "JY",      // glides
  "XKS",     // X sounds like KS
];

// Build a fast lookup: char → group index(es)
const CHAR_GROUPS = {};
for (let gi = 0; gi < SOUND_GROUPS.length; gi++) {
  for (const ch of SOUND_GROUPS[gi]) {
    if (!CHAR_GROUPS[ch]) CHAR_GROUPS[ch] = [];
    CHAR_GROUPS[ch].push(gi);
  }
}

/**
 * Returns a similarity score (0-1) between two individual characters.
 * 1.0 = identical, 0.6 = same sound group, 0.0 = unrelated
 */
function charSimilarity(a, b) {
  if (a === b) return 1.0;
  const ga = CHAR_GROUPS[a];
  const gb = CHAR_GROUPS[b];
  if (!ga || !gb) return 0;
  for (const g of ga) {
    if (gb.includes(g)) return 0.6;
  }
  return 0;
}

/**
 * Position-by-position sound similarity score between two strings.
 * Returns a score from 0 to (shorter length), where each position
 * contributes 0 to 1 based on character similarity.
 * Normalized to 0-100 scale based on the longer string length.
 */
function soundSimilarityScore(a, b) {
  a = String(a || "").toUpperCase();
  b = String(b || "").toUpperCase();
  if (!a || !b) return 0;

  const maxLen = Math.max(a.length, b.length);
  const minLen = Math.min(a.length, b.length);
  if (maxLen === 0) return 0;

  let totalSim = 0;

  // Position-aligned comparison
  for (let i = 0; i < minLen; i++) {
    totalSim += charSimilarity(a[i], b[i]);
  }

  // Normalize: perfect match = 100, partial = proportional
  // Penalize length differences
  const lengthPenalty = 1 - (maxLen - minLen) / maxLen;
  return Math.round((totalSim / maxLen) * 100 * lengthPenalty);
}
