// Minimal glob support for intents: **, *, ?, {a,b}. Paths are repo-relative, "/"-separated.
// Ported unchanged from prototype/cli/src/glob.ts.

const cache = new Map<string, RegExp>();

const escape = (ch: string): string => (/[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch);

/** Intents may name a symbol: `src/billing/invoice.js#total`. Path matching uses the part before `#`. */
export const pathOf = (glob: string): string => glob.split("#")[0] ?? glob;

/** Symbol intents: path → declared symbol names (only for globs written as `path#Symbol`). */
export const symbolIntents = (globs: readonly string[]): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>();
  for (const g of globs) {
    const i = g.indexOf("#");
    if (i <= 0 || i === g.length - 1) continue;
    const path = g.slice(0, i);
    const set = out.get(path) ?? new Set<string>();
    set.add(g.slice(i + 1));
    out.set(path, set);
  }
  return out;
};

export const globToRegExp = (raw: string): RegExp => {
  const glob = pathOf(raw);
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

export const literalPrefix = (raw: string): string => {
  const glob = pathOf(raw);
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
