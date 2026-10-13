// FR-08 symbol-level collisions: tree-sitter declarations, diff hunks, forecast. Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { Language, Parser } from "web-tree-sitter";
import { forecast } from "../src/core/forecast.ts";
import { type SyntaxNodeLike, collectDecls, parseHunks, symbolOverlap, touchedSymbols } from "../src/core/symbols.ts";
import type { RepoConfig, Workspace } from "../src/core/types.ts";

await Parser.init();
const parse = async (wasm: string, src: string) => {
  const p = new Parser();
  p.setLanguage(await Language.load(`node_modules/${wasm}`));
  const t = p.parse(src);
  if (!t) throw new Error("parse failed");
  return t.rootNode as unknown as SyntaxNodeLike;
};

const JS = `export function discount(subtotal) {
  return subtotal >= 100 ? subtotal * 0.1 : 0;
}

export function total(items) {
  return items.length;
}

class Invoice {
  add(item) {
    this.items.push(item);
  }
  sum() {
    return 0;
  }
}

const TAX = 0.08;
`;

test("symbols: JS declarations incl. class members and consts", async () => {
  const d = collectDecls(await parse("tree-sitter-javascript/tree-sitter-javascript.wasm", JS), "js");
  assert.deepEqual(d.map((x) => x.name), ["discount", "total", "Invoice", "Invoice.add", "Invoice.sum", "TAX"]);
  assert.deepEqual(d.find((x) => x.name === "total"), { name: "total", start: 5, end: 7 });
});

test("symbols: TS interfaces/types and Python classes/methods", async () => {
  const ts = collectDecls(await parse("tree-sitter-typescript/tree-sitter-typescript.wasm", "export interface A { x: number }\ntype B = string;\nexport const f = (n: number): number => n;\n"), "ts");
  assert.deepEqual(ts.map((x) => x.name), ["A", "B", "f"]);
  const py = collectDecls(await parse("tree-sitter-python/tree-sitter-python.wasm", "RATE = 3\n\ndef f(x):\n    return x\n\nclass Cart:\n    @property\n    def size(self):\n        return 0\n"), "py");
  assert.deepEqual(py.map((x) => x.name), ["RATE", "f", "Cart", "Cart.size"]);
});

test("symbols: hunks → touched declarations (edits and deletions)", async () => {
  const root = await parse("tree-sitter-javascript/tree-sitter-javascript.wasm", JS);
  const decls = collectDecls(root, "js");
  const diff = "diff --git a/src/x.js b/src/x.js\n--- a/src/x.js\n+++ b/src/x.js\n@@ -6 +6 @@ export function total(items) {\n-  return 0;\n+  return items.length;\n@@ -11,0 +12 @@ class Invoice {\n+    this.dirty = true;\n";
  const h = parseHunks(diff).get("src/x.js");
  assert.ok(h);
  assert.deepEqual(touchedSymbols(decls, decls, h), ["Invoice.add", "total"]);
});

const CONFIG: RepoConfig = { checkCommand: null, batchSize: 4, reviewThreshold: 60, sensitiveGlobs: [], unionGlobs: ["CHANGELOG.md"], leaseTtlSeconds: 1800, batchWindowMs: 0, judge: { enabled: false, model: "", holdOnSecurity: 0.7, holdOnAlignment: 1 } };
const ws = (id: string, touched: string[], syms?: Record<string, string[]>, globs = ["src/billing/**"]): Workspace => ({
  id, repo: "shop", agentId: `agt_${id}`, agentName: id, model: "m", task: id, branch: `weft/${id}`, forkRepo: id, forkRemote: "", forkTokenId: null, baseCommit: "a",
  status: "active", intent: { globs, mode: "soft", task: id, createdAt: "", expiresAt: new Date(Date.now() + 60_000).toISOString() }, touched, touchedSymbols: syms,
  createdAt: "", updatedAt: "", changesetId: null, rejections: 0,
});

test("forecast FR-08: same file, different functions = symbols-disjoint (low); same function = touched (high)", () => {
  const files = ["src/billing/invoice.js"];
  const peer = ws("atlas", files, { "src/billing/invoice.js": ["total"] });
  const disjoint = forecast([peer], { wsId: "cedar", globs: ["src/billing/**"], touched: files, symbols: { "src/billing/invoice.js": ["discount"] } }, files, CONFIG, Date.now());
  assert.equal(disjoint.risk, "low");
  assert.equal(disjoint.overlaps[0]?.strength, "symbols-disjoint");
  const same = forecast([peer], { wsId: "cedar", globs: ["src/billing/**"], touched: files, symbols: { "src/billing/invoice.js": ["total", "discount"] } }, files, CONFIG, Date.now());
  assert.equal(same.risk, "high");
  assert.equal(same.overlaps[0]?.strength, "touched");
  assert.deepEqual(same.overlaps[0]?.symbols, ["src/billing/invoice.js#total"]);
  const unknown = forecast([ws("atlas", files)], { wsId: "cedar", globs: ["src/billing/**"], touched: files, symbols: { "src/billing/invoice.js": ["discount"] } }, files, CONFIG, Date.now());
  assert.equal(unknown.overlaps[0]?.strength, "touched", "no symbol info on one side = conservative whole-file overlap");
});

test("forecast FR-08: declared symbol intents (path#Symbol) on disjoint symbols do not collide", () => {
  const files = ["src/billing/invoice.js"];
  const peer = ws("atlas", [], undefined, ["src/billing/invoice.js#total"]);
  const fc = forecast([peer], { wsId: "cedar", globs: ["src/billing/invoice.js#discount"], touched: [] }, files, CONFIG, Date.now());
  assert.equal(fc.overlaps[0]?.strength, "symbols-disjoint");
  const clash = forecast([peer], { wsId: "cedar", globs: ["src/billing/invoice.js#total"], touched: [] }, files, CONFIG, Date.now());
  assert.equal(clash.overlaps[0]?.strength, "files");
  assert.deepEqual(symbolOverlap(["Invoice"], ["Invoice.add"]), ["Invoice"]);
});
