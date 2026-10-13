// Symbol-level touch detection (FR-08). Pure: works over a minimal syntax-node interface so the same code
// runs on tree-sitter trees in the CLI (web-tree-sitter, Node) and in tests. The Worker never parses code;
// it only compares the "path#Symbol" strings the CLI reports.

export interface SyntaxNodeLike {
  type: string;
  startPosition: { row: number };
  endPosition: { row: number };
  namedChildren: readonly (SyntaxNodeLike | null)[];
  childForFieldName(name: string): SyntaxNodeLike | null;
  text: string;
}

export interface Decl {
  name: string; // "total", "Invoice", "Invoice.add"
  start: number; // 1-based inclusive
  end: number;
}

export type Lang = "js" | "ts" | "tsx" | "py";

export const langOf = (path: string): Lang | null => {
  if (/\.(m|c)?jsx?$/.test(path)) return "js";
  if (/\.(m|c)?ts$/.test(path)) return "ts";
  if (/\.tsx$/.test(path)) return "tsx";
  if (/\.py$/.test(path)) return "py";
  return null;
};

const kids = (n: SyntaxNodeLike): SyntaxNodeLike[] => n.namedChildren.filter((c): c is SyntaxNodeLike => c !== null);
const nameOf = (n: SyntaxNodeLike): string | null => n.childForFieldName("name")?.text ?? null;
const span = (n: SyntaxNodeLike) => ({ start: n.startPosition.row + 1, end: n.endPosition.row + 1 });

/** Top-level declarations and class members, with line spans. */
export const collectDecls = (root: SyntaxNodeLike, lang: Lang): Decl[] => {
  const out: Decl[] = [];
  const classMembers = (cls: SyntaxNodeLike, clsName: string): void => {
    const body = cls.childForFieldName("body");
    if (!body) return;
    for (const m of kids(body)) {
      const inner = m.type === "decorated_definition" ? (m.childForFieldName("definition") ?? m) : m;
      if (["method_definition", "function_definition", "public_field_definition", "field_definition", "abstract_method_signature", "method_signature"].includes(inner.type)) {
        const n = nameOf(inner) ?? inner.childForFieldName("property")?.text ?? null;
        if (n) out.push({ name: `${clsName}.${n}`, ...span(m) });
      }
    }
  };
  const visit = (n: SyntaxNodeLike): void => {
    if (n.type === "export_statement" || n.type === "decorated_definition") {
      const d = n.childForFieldName("declaration") ?? n.childForFieldName("definition");
      if (d) {
        const before = out.length;
        visit(d);
        // Widen the span to include the export keyword / decorators.
        for (let i = before; i < out.length; i += 1) {
          const e = out[i];
          if (e && !e.name.includes(".")) out[i] = { ...e, start: Math.min(e.start, n.startPosition.row + 1) };
        }
        return;
      }
      for (const c of kids(n)) visit(c);
      return;
    }
    switch (n.type) {
      case "function_declaration":
      case "generator_function_declaration":
      case "function_definition":
      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration":
      case "abstract_class_declaration":
      case "class_declaration":
      case "class_definition": {
        const name = nameOf(n);
        if (!name) return;
        out.push({ name, ...span(n) });
        if (n.type.includes("class")) classMembers(n, name);
        return;
      }
      case "lexical_declaration":
      case "variable_declaration":
        for (const d of kids(n)) {
          if (d.type !== "variable_declarator") continue;
          const name = nameOf(d);
          if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.push({ name, ...span(n) });
        }
        return;
      case "expression_statement": {
        // Python module-level assignment: NAME = ...
        const a = kids(n)[0];
        if (lang === "py" && a?.type === "assignment") {
          const left = a.childForFieldName("left");
          if (left?.type === "identifier") out.push({ name: left.text, ...span(n) });
        }
        return;
      }
      default:
        return;
    }
  };
  for (const c of kids(root)) visit(c);
  return out;
};

export interface Hunks {
  old: [number, number][]; // [start, end] 1-based inclusive in the base file
  new: [number, number][]; // in the working file
}

/** Parse `git diff -U0` output into per-file changed line ranges. */
export const parseHunks = (diff: string): Map<string, Hunks> => {
  const out = new Map<string, Hunks>();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f?.[1]) {
      file = f[1];
      if (!out.has(file)) out.set(file, { old: [], new: [] });
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const e = out.get(file);
      if (!e) continue;
      const oa = Number(h[1]);
      const ob = h[2] === undefined ? 1 : Number(h[2]);
      const na = Number(h[3]);
      const nb = h[4] === undefined ? 1 : Number(h[4]);
      if (ob > 0) e.old.push([oa, oa + ob - 1]);
      // A pure deletion still "touches" the declaration around the insertion point in the new file.
      e.new.push(nb > 0 ? [na, na + nb - 1] : [Math.max(1, na), Math.max(1, na)]);
    }
  }
  return out;
};

const hits = (decls: Decl[], ranges: [number, number][]): string[] =>
  decls.filter((d) => ranges.some(([a, b]) => a <= d.end && b >= d.start)).map((d) => d.name);

/** Symbols touched in one file: new-side declarations hit by added lines ∪ old-side declarations hit by removed lines. */
export const touchedSymbols = (newDecls: Decl[], oldDecls: Decl[], h: Hunks): string[] => {
  const names = new Set([...hits(newDecls, h.new), ...hits(oldDecls, h.old)]);
  // A class member edit also counts as an edit of the class only when the class line itself changed;
  // otherwise report the member alone (finer granularity is the point).
  for (const n of [...names]) {
    if (!n.includes(".")) {
      const members = [...names].filter((m) => m.startsWith(`${n}.`));
      if (members.length > 0) names.delete(n);
    }
  }
  return [...names].sort();
};

/** Compare two agents' symbol sets for one shared file. null = not enough information (treat as a real overlap). */
export const symbolOverlap = (a: readonly string[] | undefined, b: readonly string[] | undefined): string[] | null => {
  if (!a || !b || a.length === 0 || b.length === 0) return null;
  const same = (x: string, y: string) => x === y || x.startsWith(`${y}.`) || y.startsWith(`${x}.`);
  return a.filter((x) => b.some((y) => same(x, y)));
};
