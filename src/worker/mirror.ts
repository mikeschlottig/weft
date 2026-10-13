// D5 (FR-39 "import and mirror"): mirror-out. A repo may name one https git remote (GitHub, or any host that
// takes a Basic/Bearer header). After every landing the MergeQueue Workflow force-pushes main and
// refs/notes/weft there, so the mirror is an exact, signed, provenance-carrying copy of trunk.
// The credential is sealed (AES-GCM) in KV `mirror/<repo>` and never appears in config, events or logs.

import { WeftError, usage } from "../core/errors.ts";
import { mirrorAuthHeader, sealText, unsealText } from "../core/keys.ts";
import { headOf, headerToken, mintToken, resolveShard } from "./artifacts.ts";
import { runner } from "./runner-client.ts";

interface Stored {
  url: string;
  kind: "github" | "bearer";
  sealed: string;
  setBy: string;
  setAt: string;
  last: { at: string; ok: boolean; pushed: string | null; remoteMain: string | null; error: string | null } | null;
}

const key = (repo: string): string => `mirror/${repo}`;
const purpose = (repo: string): string => `weft/mirror/${repo}`;

export interface MirrorView {
  url: string;
  kind: "github" | "bearer";
  setBy: string;
  setAt: string;
  last: Stored["last"];
}

const view = (s: Stored): MirrorView => ({ url: s.url, kind: s.kind, setBy: s.setBy, setAt: s.setAt, last: s.last });

export const setMirror = async (env: Env, repo: string, input: { url: string; kind: "github" | "bearer"; token: string; by: string }): Promise<MirrorView> => {
  if (!/^https:\/\/[^\s@]+\.git$|^https:\/\/github\.com\/[^\s@/]+\/[^\s@/]+$/.test(input.url)) {
    throw usage("mirror url must be an https git URL without credentials", "e.g. https://github.com/owner/repo.git");
  }
  if (input.token.length < 8) throw usage("mirror token missing", "pass it through an env var: weft mirror set --url U --token-env VAR");
  const stored: Stored = { url: input.url, kind: input.kind, sealed: await sealText(input.token, env.JWT_SIGNING_SECRET, purpose(repo)), setBy: input.by, setAt: new Date().toISOString(), last: null };
  await env.CONFIG.put(key(repo), JSON.stringify(stored));
  return view(stored);
};

export const getMirror = async (env: Env, repo: string): Promise<MirrorView | null> => {
  const s = await env.CONFIG.get<Stored>(key(repo), "json");
  return s ? view(s) : null;
};

export const removeMirror = async (env: Env, repo: string): Promise<boolean> => {
  const had = (await env.CONFIG.get(key(repo))) !== null;
  await env.CONFIG.delete(key(repo));
  return had;
};

/**
 * Push trunk (`head`, or the current main) to the mirror. Returns null when the repo has no mirror.
 * Never throws for a mirror failure: the result is recorded and returned, landing is never blocked by it.
 */
export const pushMirror = async (env: Env, repo: string, trunkRemote: string, head: string | null, lane = 0): Promise<Stored["last"]> => {
  const s = await env.CONFIG.get<Stored>(key(repo), "json");
  if (!s) return null;
  const at = new Date().toISOString();
  let last: NonNullable<Stored["last"]>;
  try {
    await resolveShard(env, repo);
    const tip = head ?? (await headOf(env, repo));
    if (!tip) throw new WeftError("INVALID_STATE", "trunk is empty");
    const token = await unsealText(s.sealed, env.JWT_SIGNING_SECRET, purpose(repo));
    const read = headerToken((await mintToken(env, repo, "read", 900)).plaintext);
    const r = await runner(env, repo, lane).mirror({ trunk: { remote: trunkRemote, token: read }, trunkHead: tip, target: { url: s.url, authHeader: mirrorAuthHeader(s.kind, token) } });
    last = { at, ok: r.remoteMain === tip, pushed: r.pushed, remoteMain: r.remoteMain, error: r.remoteMain === tip ? null : `mirror main is ${r.remoteMain ?? "unreadable"} after push` };
  } catch (err: unknown) {
    last = { at, ok: false, pushed: null, remoteMain: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 400) };
  }
  await env.CONFIG.put(key(repo), JSON.stringify({ ...s, last }));
  return last;
};
