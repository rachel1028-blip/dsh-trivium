/**
 * The host's compaction summary must reach the extraction prompt end to end.
 *
 * `compaction/summary` arrives as its own event and lands in the session buffer;
 * `compaction/end` then schedules extraction. The summary is the only surviving
 * evidence for the history the host folded away, so it has to be prepended to
 * the transcript the model reads. This drives the real plugin wiring with a stub
 * host: no model, no network.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p64-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const cwd = join(root, "workspace");
const plugin = await import("../lib/index.js");
const { loadPending } = await import("../lib/extract.js");

const handlers = new Map();
const prompts = [];
const warnings = [];
const ctx = {
  logger: () => ({ warn: (msg) => warnings.push(String(msg)), info() {}, error() {}, debug() {} }),
  inject(_deps, fn) { fn(ctx); },
  on(event, fn) { handlers.set(event, fn); return () => {}; },
  effect(fn) { fn(); return () => {}; },
  tools: { register: () => () => {} },
  llm: {
    async *stream(options) {
      prompts.push(options.messages.map((m) => (m.content || []).map((c) => c.text || "").join("")).join(""));
      yield { type: "text-delta", index: 0, text: '{"candidates":[]}' };
    },
  },
};

try {
  plugin.apply(ctx, {});
  const onEvent = handlers.get("session/event");
  assert.equal(typeof onEvent, "function");
  const session = {
    id: "p64",
    header: { cwd },
    // makeLlmCall resolves provider/model from the request header.
    requestHeader: () => ({ config: { provider: "deepseek-official", model: "deepseek-flash" } }),
  };

  onEvent(session, {
    type: "compaction/summary",
    seq: 1,
    data: {
      compactionId: "c-1",
      summary: "早前确定了仓库鉴权走 X-Request-Id，AuthGateway 下周再改，不要动。",
      shadowedRange: { end: 1 },
    },
  });
  onEvent(session, {
    type: "user/message",
    seq: 2,
    data: { source: { kind: "user" }, content: [{ type: "text", text: "以后都用 pnpm，不要用 npm。" }], turn: 1 },
  });
  onEvent(session, { type: "compaction/end", seq: 3, data: { compactionId: "c-1" } });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !prompts.length) await new Promise((done) => setTimeout(done, 20));

  assert.equal(prompts.length, 1, `exactly one extraction call, warnings: ${warnings.join("; ")}`);
  const prompt = prompts[0];
  assert.ok(prompt.includes("X-Request-Id"), "the folded history summary reaches the model");
  assert.ok(prompt.includes("以后都用 pnpm"), "the live window still reaches the model");
  assert.ok(
    prompt.indexOf("X-Request-Id") < prompt.indexOf("以后都用 pnpm"),
    "the summary is prepended, so older history is read before the recent turns",
  );
  assert.ok(prompt.includes("already compacted by the host"), "the summary is labelled as history, not as user words");
  assert.equal(loadPending(cwd), null, "a successful extraction consumes the window");
  console.log("P64: compaction summary reaches the extraction prompt, labelled and prepended");
} finally {
  rmSync(root, { recursive: true, force: true });
}
