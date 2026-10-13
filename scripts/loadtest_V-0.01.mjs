#!/usr/bin/env node
// Spec §14 load test: ≥ 1,000 req/min on status (snapshot) + heartbeat, p95 reported, no 5xx.
// Open-loop: requests are fired on a fixed schedule regardless of response time, so a slow
// server shows up as latency, not as a quietly reduced request rate. No retries (they would mask 5xx).
//
// Usage: WEFT_ADMIN_TOKEN=… node scripts/loadtest_V-0.01.mjs --repo <existing-repo> [--rpm 3000] [--seconds 60]
//   (WEFT_ADMIN_TOKEN / WEFT_REMOTE are read from ~/.env/weft.env when not set)
// Exit 0 only if: zero 5xx, zero network errors, achieved rate ≥ target × 0.95.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const envFile = join(homedir(), ".env", "weft.env");
if (!process.env.WEFT_ADMIN_TOKEN && existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const REMOTE = (args.remote ?? process.env.WEFT_REMOTE ?? "https://weft.ceo-a53.workers.dev").replace(/\/$/, "");
const ADMIN = process.env.WEFT_ADMIN_TOKEN;
const REPO = args.repo;
const RPM = Number(args.rpm ?? 3000);
const SECONDS = Number(args.seconds ?? 60);
if (!ADMIN) throw new Error("WEFT_ADMIN_TOKEN is not set (and ~/.env/weft.env not found)");
if (!REPO) throw new Error("--repo <existing repo with a trunk commit> is required");

const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

async function api(method, path, token, body) {
  const res = await fetch(`${REMOTE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  return json.data;
}

// ---- setup: one agent, one workspace to heartbeat against
const reg = await api("POST", "/v1/agents", ADMIN, { name: "loadtest", model: "loadtest-harness", ttlHours: 2 });
const agentToken = reg.token;
const started = await api("POST", `/v1/repos/${REPO}/workspaces`, agentToken, { task: "spec §14 load test", touch: ["loadtest/**"], mode: "soft" });
const wsId = started.workspace.id;
log("setup", { remote: REMOTE, repo: REPO, wsId, rpm: RPM, seconds: SECONDS });

// ---- run
const kinds = [
  { name: "snapshot", method: "GET", path: `/v1/repos/${REPO}/snapshot`, token: agentToken, body: undefined },
  { name: "heartbeat", method: "POST", path: `/v1/repos/${REPO}/workspaces/${wsId}/heartbeat`, token: agentToken, body: { touched: [] } },
];
const results = []; // { kind, status, ms }
const total = Math.round((RPM / 60) * SECONDS);
const intervalMs = 60_000 / RPM;
const t0 = performance.now();
const inflight = [];
for (let i = 0; i < total; i++) {
  const due = t0 + i * intervalMs;
  const wait = due - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const k = kinds[i % kinds.length];
  const s = performance.now();
  inflight.push(
    fetch(`${REMOTE}${k.path}`, {
      method: k.method,
      headers: { authorization: `Bearer ${k.token}`, "content-type": "application/json" },
      body: k.body === undefined ? undefined : JSON.stringify(k.body),
      signal: AbortSignal.timeout(600_000),
    })
      .then(async (res) => {
        await res.arrayBuffer();
        results.push({ kind: k.name, status: res.status, ms: performance.now() - s });
      })
      .catch((err) => results.push({ kind: k.name, status: 0, ms: performance.now() - s, err: String(err?.cause?.code ?? err?.name ?? err) })),
  );
}
const sendSeconds = (performance.now() - t0) / 1000;
await Promise.all(inflight);
const wallSeconds = (performance.now() - t0) / 1000;

// ---- teardown (best effort, reported)
try {
  await api("DELETE", `/v1/repos/${REPO}/workspaces/${wsId}`, agentToken);
  log("teardown", { wsId, abandoned: true });
} catch (err) {
  log("teardown_failed", { wsId, error: String(err) });
}

// ---- report
const pct = (arr, p) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]);
};
const summarize = (rows) => {
  const ms = rows.map((r) => r.ms);
  const statuses = {};
  for (const r of rows) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  return { n: rows.length, p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99), max: pct(ms, 100), statuses };
};
const fivexx = results.filter((r) => r.status >= 500).length;
const neterr = results.filter((r) => r.status === 0).length;
const achievedRpm = Math.round((results.length / sendSeconds) * 60);
const report = {
  target: { rpm: RPM, seconds: SECONDS, requests: total },
  achieved: { rpm: achievedRpm, sendSeconds: Number(sendSeconds.toFixed(1)), wallSeconds: Number(wallSeconds.toFixed(1)) },
  all: summarize(results),
  snapshot: summarize(results.filter((r) => r.kind === "snapshot")),
  heartbeat: summarize(results.filter((r) => r.kind === "heartbeat")),
  fivexx,
  networkErrors: neterr,
  errorSamples: results.filter((r) => r.err).slice(0, 5).map((r) => r.err),
};
const pass = fivexx === 0 && neterr === 0 && achievedRpm >= RPM * 0.95;
log(pass ? "PASS" : "FAIL", report);
process.exit(pass ? 0 : 1);
