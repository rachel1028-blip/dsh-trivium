/**
 * Measure what the extraction prompt actually carries, before and after.
 *
 * Run against a checked-out revision to get its numbers; the point is that the
 * numbers are comparable, not that this script knows which revision it is on.
 *   node scripts/repro-extract-window.mjs
 */
import { buildExtractPrompt } from "../lib/extract.js";

/** A realistic window: 40 turns of Chinese conversation with tool noise mixed in. */
function window40() {
  const turns = [];
  for (let i = 0; i < 40; i++) {
    turns.push({ role: "user", text: `第 ${i} 轮：${"我们把这件事再确认一下。".repeat(4)}` });
    turns.push({ role: "assistant", text: `收到，${"我按刚才说的继续推进。".repeat(3)}` });
  }
  // The durable fact the extractor is supposed to find, stated at the very end.
  turns.push({ role: "user", text: "记住，以后部署前必须人工核对，不要直接上线。" });
  turns.push({ role: "assistant", text: "明白，以后部署前一定先人工核对。" });
  return turns;
}

const turns = window40();
const rawChars = turns.map((t) => `${t.role}: ${t.text}`).join("\n").length;
const prompt = buildExtractPrompt(turns);
const newest = turns.at(-1).text;
const oldest = turns[0].text;
const fact = "以后部署前必须人工核对";

const summary = "早前确定了仓库鉴权走 X-Request-Id，AuthGateway 下周再改。";
const withSummary = buildExtractPrompt(turns, { summary });

const row = (k, v) => console.log(`${k.padEnd(34)} ${v}`);

row("window characters", rawChars);
row("prompt characters", prompt.length);
row("prompt / window", `${((prompt.length / rawChars) * 100).toFixed(1)}%`);
row("newest turn in prompt", prompt.includes(newest));
row("oldest turn in prompt", prompt.includes(oldest));
row("durable fact in prompt", prompt.includes(fact));
row("summary reaches prompt", withSummary.includes("X-Request-Id"));
row("prompt chars with summary", withSummary.length);
