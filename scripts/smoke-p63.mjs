/**
 * The extraction prompt must carry the recent window, not the oldest slice.
 *
 * Regression: `buildExtractPrompt` used `clip(turnsText(turns), 2400)`, a head
 * slice. A full 80-turn buffer is far longer than 2400 characters, so the model
 * read the beginning of the window and never the end — the turns that had just
 * happened. A compacted session therefore kept reporting `applied: 0`.
 */
import assert from "node:assert/strict";
import { buildExtractPrompt, packTurns, EXTRACT_TRANSCRIPT_TOKENS } from "../lib/extract.js";

const filler = (tag, n) => `${tag}${"内容".repeat(n)}`;

/** 40 user/assistant pairs: ~18k characters, well past any single-turn budget. */
const window = [];
for (let i = 0; i < 40; i++) {
  window.push({ role: "user", text: filler(`用户第${i}轮 `, 60) });
  window.push({ role: "assistant", text: filler(`助手第${i}轮 `, 45) });
}

// The whole point: the newest turn survives, the oldest one does not.
const prompt = buildExtractPrompt(window);
assert.ok(prompt.includes("用户第39轮"), "the newest user turn must reach the model");
assert.ok(prompt.includes("助手第39轮"), "the newest assistant turn must reach the model");
assert.ok(!prompt.includes("用户第0轮"), "the oldest turn must yield its budget to the newest");

// The prompt stays inside its budget even though the window does not.
assert.ok(prompt.length < 6000, `prompt should stay bounded, got ${prompt.length}`);

// Newest-first packing: the kept turns are a contiguous tail, in order.
const packed = packTurns(window);
assert.ok(packed.kept > 0 && packed.dropped > 0);
assert.ok(packed.tokens <= EXTRACT_TRANSCRIPT_TOKENS);
const keptLines = packed.text.split("\n");
assert.equal(keptLines.at(-1), `assistant: ${filler("助手第39轮 ", 45)}`);
assert.ok(keptLines.length === packed.kept);

// A single oversized turn cannot evict everything behind it: it is clipped, and
// it is still the turn that gets in, because the present is never dropped.
const huge = [
  { role: "user", text: filler("早期 ", 50) },
  { role: "user", text: filler("巨型工具输出 ", 4000) },
];
const clipped = packTurns(huge);
assert.equal(clipped.kept, 1);
assert.ok(clipped.text.startsWith("user: 巨型工具输出"));
assert.ok(clipped.tokens <= EXTRACT_TRANSCRIPT_TOKENS + 8);

// A tiny window is passed through untouched — no clipping, no reordering.
const small = [
  { role: "user", text: "以后都用 pnpm。" },
  { role: "assistant", text: "好。" },
];
const smallPacked = packTurns(small);
assert.equal(smallPacked.text, "user: 以后都用 pnpm。\nassistant: 好。");
assert.equal(smallPacked.dropped, 0);

// A host compaction summary is prepended and labelled as history, not as words
// the user said. Without a summary the section is absent entirely.
const summary = "早前讨论了仓库鉴权走 X-Request-Id，以及 AuthGateway 下周再改。";
const withSummary = buildExtractPrompt(small, { summary });
assert.ok(withSummary.includes(summary));
assert.ok(withSummary.indexOf(summary) < withSummary.indexOf("user: 以后都用 pnpm。"));
assert.ok(withSummary.includes("already compacted by the host"));
assert.ok(!buildExtractPrompt(small).includes("already compacted by the host"));

// A huge summary cannot push the window out: it gets its own reserved budget.
const longSummary = filler("摘要", 3000);
const bounded = buildExtractPrompt(small, { summary: longSummary });
assert.ok(bounded.includes("user: 以后都用 pnpm。"));
assert.ok(bounded.length < 6000, `summary must stay bounded, got ${bounded.length}`);

console.log("P63 extraction window passed: newest turns kept, oldest dropped, budget bounded, oversized turn clipped, small window untouched, host summary prepended and bounded");
