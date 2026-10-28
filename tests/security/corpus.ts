/**
 * Hostile strings injected at every position the client accepts input. None contains NUL: that character is
 * rejected by design and has its own test (see injection.test.ts).
 */
const RLO = String.fromCharCode(0x202e); // right-to-left override

export const INJECTION_PAYLOADS: readonly string[] = [
  "' OR 1=1 --",
  '" OR ""="',
  "'; DROP TABLE \"User\"; --",
  '1; DELETE FROM "Post"',
  "*/ OR /*",
  "%' OR '%'='",
  "\\' OR 1=1 --",
  "') OR ('a'='a",
  "UNION SELECT * FROM sqlite_master --",
  "admin'--",
  "ʼ OR 1=1 --", // modifier letter apostrophe
  `a${RLO}b`, // right-to-left override
  "\u{1F642}' OR '\u{1F642}'='\u{1F642}",
  "'".repeat(10_000),
];
