#!/usr/bin/env node
// Wait until a repo's event log contains one of the given event types after `since`.
// Usage: node scripts/wait-events.mjs <repo> <since> <type[,type…]> [timeoutSec=300] [--print]
// Exit 0 when matched (prints matching events as JSON lines with --print), 1 on timeout.
const [repo, sinceArg, typesArg, timeoutArg = "300", flag] = process.argv.slice(2);
if (!repo || !sinceArg || !typesArg) {
  console.error("usage: wait-events.mjs <repo> <since> <type[,type…]> [timeoutSec] [--print]");
  process.exit(2);
}
const remote = (process.env.WEFT_REMOTE ?? "https://weft.ceo-a53.workers.dev").replace(/\/$/, "");
const types = new Set(typesArg.split(","));
const deadline = Date.now() + Number(timeoutArg) * 1000;
const since = Number(sinceArg);
const headers = process.env.WEFT_TOKEN ? { authorization: `Bearer ${process.env.WEFT_TOKEN}` } : {};
for (;;) {
  try {
    const res = await fetch(`${remote}/v1/repos/${repo}/events?since=${since}`, { headers, signal: AbortSignal.timeout(30_000) });
    const env = await res.json();
    const evs = env.ok ? env.data : [];
    const hit = evs.find((e) => types.has(e.type));
    if (hit) {
      if (flag === "--print") for (const e of evs) console.log(JSON.stringify({ seq: e.seq, type: e.type, data: e.data }));
      process.exit(0);
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "warn", msg: "poll failed", err: String(err) }));
  }
  if (Date.now() > deadline) {
    console.error(`timeout waiting for ${typesArg} on ${repo} after seq ${since}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 4000));
}
