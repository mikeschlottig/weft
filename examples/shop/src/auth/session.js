export const SESSION_TTL_SECONDS = 86400;

export function isExpired(issuedAt, now) {
  return now - issuedAt > SESSION_TTL_SECONDS;
}
