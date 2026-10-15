// Check-log excerpts for rejection reasons — pure, no Cloudflare imports.
//
// The runner records stdout then stderr. Package managers write install chatter (deprecations, funding,
// audit notices) to stderr, so a plain tail of the log often shows that chatter instead of the failing
// test (seen live 2026-10-15: an is-number rejection whose reason was npm's deprecation warnings).
// The full log stays available (`weft logs <cs>`); this only chooses what the one-line reason shows.

/** Lines that never explain a failure: package-manager install noise and the runner's own markers. */
const NOISE =
  /^(npm (warn|WARN|notice|NOTICE)\b|npm ERR! (A complete log|\s*$)|(added|removed|changed|up to date)\b.*\b(packages?|in \d)|\d+ packages? (are|is) looking for funding|\s*run `npm (fund|audit)|found \d+ vulnerabilit|WARNING: Running pip as|\[notice\]|Requirement already satisfied|Collecting |Downloading |Installing collected packages|Successfully installed|# (commit|exit) )/;

/**
 * The last `max` characters of the log with install noise and blank runs removed, so the reason a
 * changeset was rejected names the failing test or error. Falls back to the plain tail when filtering
 * leaves nothing.
 */
export const failureExcerpt = (log: string, max = 500): string => {
  const kept = log
    .split("\n")
    .filter((l) => l.trim().length > 0 && !NOISE.test(l.trimStart()))
    .join("\n")
    .trim();
  const text = kept.length > 0 ? kept : log.trim();
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
};
