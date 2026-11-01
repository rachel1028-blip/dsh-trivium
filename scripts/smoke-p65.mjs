/**
 * The billion-context bridge must be inert unless asked, and harmless when the
 * proxy is missing, broken or slow.
 *
 * billion-context folds history inside the proxy, so the harness never emits
 * `compaction/end` and trivium never sees the fold. The proxy does keep the
 * record; this module reads it. Three rules matter:
 *   - detection is a disk read and defaults to "off", even when bili is present;
 *   - every network failure degrades to "no extra summary", never to an error;
 *   - a superseded block is not quoted, because it was re-folded into a newer one.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectHostFold, readHostFolds, readHostSummary, proxyOriginPath } from "../lib/host-fold.js";
import { hostFoldEnabledOf, writeUiSettings } from "../lib/settings.js";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p65-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log("ok " + label); } catch (e) { failures += 1; console.error("FAIL " + label + ": " + e.message); }
}
async function checkAsync(fn, label) {
  checks += 1;
  try { await fn(); console.log("ok " + label); } catch (e) { failures += 1; console.error("FAIL " + label + ": " + e.message); }
}

const originFile = proxyOriginPath(root);
const writeOrigin = (body) => {
  mkdirSync(join(root, ".local", "state", "billion-context"), { recursive: true });
  writeFileSync(originFile, typeof body === "string" ? body : JSON.stringify(body), "utf8");
};

/** A fake fetch that answers the two routes this module uses. */
function fakeFetch({ status = 200, body = {}, throws = null, onUrl = null } = {}) {
  return async (url) => {
    onUrl?.(String(url));
    if (throws) throw throws;
    return {
      ok: status >= 200 && status < 300,
      async json() { return typeof body === "function" ? body(String(url)) : body; },
    };
  };
}

try {
  // 1. No file at all: not detected, and nothing throws.
  check(() => assert.deepEqual(detectHostFold({ home: root }), { detected: false, origin: "", instanceId: "" }), "a machine without bili reports not-detected");

  // 2. Malformed or origin-less files are "not detected", not a crash.
  writeOrigin("{ this is not json");
  check(() => assert.equal(detectHostFold({ home: root }).detected, false), "malformed proxy-origin is not detected");
  writeOrigin({ origin: "not-a-url" });
  check(() => assert.equal(detectHostFold({ home: root }).detected, false), "an origin that is not a URL is not detected");

  // 3. A real origin is detected, with the instance id.
  writeOrigin({ origin: "http://127.0.0.1:18814", instanceId: "abc-123" });
  const detected = detectHostFold({ home: root });
  check(() => assert.equal(detected.detected, true), "a running proxy origin is detected");
  check(() => assert.equal(detected.origin, "http://127.0.0.1:18814"), "the origin is reported");
  check(() => assert.equal(detected.instanceId, "abc-123"), "the instance id is reported");

  // 4. The switch defaults off, even on a machine where bili is installed.
  check(() => assert.equal(hostFoldEnabledOf({}), false), "host fold defaults off when the key is missing");
  check(() => assert.equal(hostFoldEnabledOf({ hostFoldEnabled: true }), true), "host fold can be turned on");
  writeUiSettings({ hostFoldEnabled: true });
  check(() => assert.equal(writeUiSettings({}).hostFoldEnabled, true), "the switch persists through the settings file");
  writeUiSettings({ hostFoldEnabled: false });
  check(() => assert.equal(writeUiSettings({}).hostFoldEnabled, false), "the switch persists off");

  // 5. Only active blocks are quoted; superseded ones are reported, not repeated.
  const statusBody = {
    blocks: [
      { id: "b1", tier: 1, active: false },
      { id: "b2", tier: 1, active: true },
      { id: "b3", tier: 1, active: true },
    ],
    contextView: { folds: [{ seq: 7, at: 1793561923868, s: 62894, reclaimed: 60992 }] },
  };
  const folds = await readHostFolds("http://127.0.0.1:18814", "session-1", { fetchImpl: fakeFetch({ body: statusBody }) });
  check(() => assert.deepEqual(folds.blocks.map((b) => b.id), ["b2", "b3"]), "superseded blocks are not quoted");
  check(() => assert.equal(folds.superseded, 1), "superseded blocks are still counted");
  check(() => assert.equal(folds.foldCount, 1), "the proxy fold ledger is reported");
  check(() => assert.equal(folds.folds[0].reclaimed, 60992), "reclaimed tokens are reported");

  // 6. The request is scoped to one conversation, and the URL is not mangled.
  let seen = "";
  await readHostFolds("http://127.0.0.1:18814/", "session-a b", { fetchImpl: fakeFetch({ body: statusBody, onUrl: (u) => { seen = u; } }) });
  check(() => assert.ok(seen.startsWith("http://127.0.0.1:18814/__bili/plugin/status?conversationId=session-a%20b")), `the conversation id is encoded: ${seen}`);

  // 7. Every failure mode degrades to null / "", never to a throw.
  for (const [label, fetchImpl] of [
    ["a throwing fetch", fakeFetch({ throws: new Error("ECONNREFUSED") })],
    ["a non-200 response", fakeFetch({ status: 503 })],
    ["a body that is not JSON", async () => ({ ok: true, async json() { throw new SyntaxError("Unexpected token <"); } })],
  ]) {
    await checkAsync(async () => {
      assert.equal(await readHostFolds("http://127.0.0.1:18814", "session-1", { fetchImpl }), null);
      assert.equal(await readHostSummary("http://127.0.0.1:18814", "session-1", { fetchImpl }), "");
    }, `${label} degrades quietly`);
  }

  // 8. A slow proxy is abandoned, not awaited forever.
  const never = (url, opts) => new Promise((_, reject) => {
    opts?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const started = Date.now();
  const timedOut = await readHostFolds("http://127.0.0.1:18814", "session-1", { fetchImpl: never, timeoutMs: 120 });
  check(() => assert.equal(timedOut, null), "a hanging proxy yields no folds");
  check(() => assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`), "the timeout is enforced");

  // 9. An empty origin or conversation id short-circuits without any request.
  let called = false;
  const spy = fakeFetch({ body: statusBody, onUrl: () => { called = true; } });
  await readHostFolds("", "session-1", { fetchImpl: spy });
  await readHostFolds("http://127.0.0.1:18814", "", { fetchImpl: spy });
  check(() => assert.equal(called, false), "no request without an origin and a conversation id");

  // 10. The summary comes from active blocks only, in order, and skips blanks.
  const detailBody = {
    blockDetails: [
      { blockId: "b1", active: false, summary: "旧的历史，已经被重新折叠，不应再引用。" },
      { blockId: "b2", active: true, summary: "第一段有效历史。" },
      { blockId: "b3", active: true, summary: "" },
      { blockId: "b4", active: true, summary: "第二段有效历史。" },
    ],
  };
  const summary = await readHostSummary("http://127.0.0.1:18814", "session-1", { fetchImpl: fakeFetch({ body: detailBody }) });
  check(() => assert.equal(summary, "第一段有效历史。\n\n第二段有效历史。"), "only active, non-empty summaries are joined in order");
  check(() => assert.ok(!summary.includes("不应再引用")), "a superseded summary is never quoted");

  // 11. No active block means no summary — not an empty string glued in.
  const noActive = await readHostSummary("http://127.0.0.1:18814", "session-1", {
    fetchImpl: fakeFetch({ body: { blockDetails: [{ blockId: "b1", active: false, summary: "x" }] } }),
  });
  check(() => assert.equal(noActive, ""), "a session with no active block yields no summary");

  // 12. Over budget, the NEWEST summaries survive. Head-clipping the join would
  // keep only the oldest history, which is the bug this change exists to remove.
  const bigBlocks = {
    blockDetails: [
      { blockId: "old", active: true, summary: "旧历史".repeat(900) },
      { blockId: "new", active: true, summary: "最新历史，必须留下。" },
    ],
  };
  const packed = await readHostSummary("http://127.0.0.1:18814", "session-1", {
    fetchImpl: fakeFetch({ body: bigBlocks }),
    budget: 300,
  });
  check(() => assert.ok(packed.includes("最新历史，必须留下。")), "the newest summary survives a tight budget");
  check(() => assert.ok(!packed.includes("旧历史旧历史旧历史")), "the older summary yields its budget");
  check(() => assert.ok(packed.length <= 1200), `the packed summary stays bounded, got ${packed.length}`);

  console.log(`P65: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
