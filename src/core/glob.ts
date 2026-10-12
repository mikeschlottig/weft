// Minimal glob support for intents: **, *, ?, {a,b}. Paths are repo-relative, "/"-separated.
// Ported unchanged from prototype/cli/src/glob.ts.

const cache = new Map<string, RegExp>();

const escape = (ch: string): string => (/[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch);

export const globToRegExp = (glob: string): RegExp => {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = "";
  let i = 0;
  let inBrace = false;
  while (i < glob.length) {
    const ch = glob[i] ?? "";
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 3 : 2;
        continue;
      }
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      inBrace = true;
      re += "(?:";
    } else if (ch === "}" && inBrace) {
      inBrace = false;
      re += ")";
    } else if (ch === "," && inBrace) {
      re += "|";
    } else {
      re += escape(ch);
    }
    i += 1;
  }
  const isLiteral = !/[*?{]/.test(glob);
  const compiled = new RegExp(isLiteral ? `^${re}(?:/.*)?$` : `^${re}$`);
  cache.set(glob, compiled);
  return compiled;
};

export const matches = (path: string, globs: readonly string[]): boolean => globs.some((g) => globToRegExp(g).test(path));

export const literalPrefix = (glob: string): string => {
  const idx = glob.search(/[*?{]/);
  return idx === -1 ? glob : glob.slice(0, idx);
};

export const prefixesOverlap = (a: readonly string[], b: readonly string[]): string[] => {
  const hits: string[] = [];
  for (const ga of a) {
    for (const gb of b) {
      const pa = literalPrefix(ga);
      const pb = literalPrefix(gb);
      if (pa.startsWith(pb) || pb.startsWith(pa)) hits.push(`${ga} ~ ${gb}`);
    }
  }
  return hits;
};
