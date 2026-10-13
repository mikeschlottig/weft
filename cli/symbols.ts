// CLI side of FR-08: parse changed files with tree-sitter (WASM, Node) and report which declarations the
// agent touched. The server only ever sees "file → [symbols]"; source never leaves the agent's machine.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { type Lang, type SyntaxNodeLike, collectDecls, langOf, parseHunks, touchedSymbols } from "../src/core/symbols.ts";

const GRAMMAR: Record<Lang, [string, string]> = {
  js: ["tree-sitter-javascript", "tree-sitter-javascript.wasm"],
  ts: ["tree-sitter-typescript", "tree-sitter-typescript.wasm"],
  tsx: ["tree-sitter-typescript", "tree-sitter-tsx.wasm"],
  py: ["tree-sitter-python", "tree-sitter-python.wasm"],
};
const MAX_BYTES = 512_000;

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);

/** Locate a grammar's .wasm (package exports may hide subpaths, so fall back to node_modules on disk). */
const wasmPath = (pkg: string, file: string): string | null => {
  const candidates = [join(here, "..", "node_modules", pkg, file)];
  try {
    candidates.unshift(join(dirname(req.resolve(`${pkg}/package.json`)), file));
  } catch {
    // package.json not exported: the on-disk fallback below covers it
  }
  return candidates.find((p) => existsSync(p)) ?? null;
};

let ready: Promise<void> | null = null;
const parsers = new Map<Lang, Parser | null>();

const parserFor = async (lang: Lang): Promise<Parser | null> => {
  if (parsers.has(lang)) return parsers.get(lang) ?? null;
  ready ??= Parser.init();
  await ready;
  const [pkg, file] = GRAMMAR[lang];
  const path = wasmPath(pkg, file);
  if (!path) {
    parsers.set(lang, null);
    return null;
  }
  const p = new Parser();
  p.setLanguage(await Language.load(path));
  parsers.set(lang, p);
  return p;
};

const declsOf = async (lang: Lang, source: string | null) => {
  if (source === null || source.length > MAX_BYTES) return [];
  const p = await parserFor(lang);
  const tree = p?.parse(source);
  if (!tree) return [];
  return collectDecls(tree.rootNode as unknown as SyntaxNodeLike, lang);
};

const gitOut = (cwd: string, args: string[], allow: number[] = []): string | null => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) return r.stdout;
  return allow.includes(r.status ?? -1) ? null : null;
};

/**
 * Touched symbols per file, for the working tree relative to `base` (tracked changes + untracked files).
 * Best effort by design: any file it cannot parse is simply reported without symbols, which the server
 * treats as a whole-file touch (never weaker than before FR-08).
 */
export const symbolsForWorktree = async (cwd: string, base: string, files: string[]): Promise<Record<string, string[]>> => {
  const out: Record<string, string[]> = {};
  const supported = files.filter((f) => langOf(f) !== null);
  if (supported.length === 0) return out;
  const hunks = parseHunks(gitOut(cwd, ["diff", "-U0", "--no-color", base, "--", ...supported]) ?? "");
  for (const f of supported) {
    const lang = langOf(f);
    if (!lang) continue;
    try {
      const abs = join(cwd, f);
      const now = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      const before = gitOut(cwd, ["show", `${base}:${f}`], [128]);
      const h = hunks.get(f);
      if (!h) {
        // Untracked (new) file: every declaration in it is touched.
        const all = (await declsOf(lang, now)).map((d) => d.name);
        if (all.length > 0) out[f] = all.sort();
        continue;
      }
      const syms = touchedSymbols(await declsOf(lang, now), await declsOf(lang, before), h);
      if (syms.length > 0) out[f] = syms;
    } catch (err: unknown) {
      if (process.env.WEFT_DEBUG) process.stderr.write(`symbols: ${f}: ${String(err)}\n`);
    }
  }
  return out;
};
