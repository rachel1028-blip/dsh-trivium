/**
 * Read the fold history a billion-context proxy keeps for this session.
 *
 * billion-context (bili) replaces the host's native compaction: it folds old
 * history into a summary *in the proxy*, so the harness never emits
 * `compaction/end` and trivium never learns that the session was compacted.
 * The proxy does keep the record — `GET /__bili/plugin/status` reports the
 * blocks it created, and `/__bili/sessions/<id>/detail` carries their summaries.
 *
 * Everything here is optional and read-only. Nothing in this module runs unless
 * `hostFoldEnabled` is on, and no failure is ever fatal: a proxy that is absent,
 * slow or speaking a different version just means "no extra summary today".
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateTokens, clipToTokenBudget } from "./tokens.js";

/** Where bili records the origin of its running proxy. Written on every start. */
export function proxyOriginPath(home = homedir()) {
  return join(home, ".local", "state", "billion-context", "proxy-origin");
}

/**
 * Detect a running bili proxy from disk. No network, so this is safe to call at
 * load time and on every settings read.
 *
 * Returns `{ detected, origin, instanceId }`. `detected: false` means "no bili",
 * not "bili is broken" — a stale file with no reachable origin still counts as
 * detected, because the user does have bili installed and the settings panel
 * should still be able to offer the switch.
 */
export function detectHostFold({ home = homedir() } = {}) {
  try {
    const raw = readFileSync(proxyOriginPath(home), "utf8");
    const parsed = JSON.parse(raw);
    const origin = String(parsed?.origin || "").trim();
    if (!/^https?:\/\//.test(origin)) return { detected: false, origin: "", instanceId: "" };
    return { detected: true, origin, instanceId: String(parsed?.instanceId || "") };
  } catch {
    return { detected: false, origin: "", instanceId: "" };
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Summarise the folds bili is currently applying to a conversation.
 *
 * Only blocks with `active === true` are reported: a superseded block was
 * re-folded into a newer one, and quoting it would describe history twice.
 * `folds` is the proxy's own accounting; `blocks` is what the model was built
 * from, so the two are reported separately rather than merged into one number.
 */
export async function readHostFolds(origin, conversationId, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const base = String(origin || "").replace(/\/+$/, "");
  if (!base || !conversationId) return null;
  const controller = new AbortController();
  // Not unref'd: the timeout has to be able to fire on its own, and the finally
  // block below always clears it, so it can never outlive this call.
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const url = `${base}/__bili/plugin/status?conversationId=${encodeURIComponent(conversationId)}`;
    const resp = await fetchImpl(url, { signal: controller.signal });
    if (!resp?.ok) return null;
    const body = await resp.json();
    const blocks = asArray(body?.blocks);
    const active = blocks.filter((block) => block?.active === true);
    const folds = asArray(body?.contextView?.folds);
    return {
      origin: base,
      conversationId: String(conversationId),
      blocks: active.map((block) => ({ id: String(block.id || ""), tier: Number(block.tier) || 0 })),
      blockCount: blocks.length,
      superseded: blocks.length - active.length,
      folds: folds.map((fold) => ({
        seq: Number(fold?.seq) || 0,
        at: Number(fold?.at) || 0,
        tokens: Number(fold?.s) || 0,
        reclaimed: Number(fold?.reclaimed) || 0,
      })),
      foldCount: folds.length,
    };
  } catch {
    // Absent, refused, timed out or not JSON: all mean "no extra summary".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the active block summaries, packed to a token budget newest-first.
 *
 * Each block summary describes one folded range, and the newest block is the
 * most recent folded history — so when the budget cannot hold them all, the
 * older ones yield. Head-clipping the concatenation would do the opposite and
 * keep only the oldest, which is the exact failure this whole change exists to
 * remove.
 *
 * `/detail` is a UI route rather than a documented plugin route, so this is
 * deliberately best-effort: any failure returns "" and extraction proceeds with
 * the recent turns only, exactly as it would without bili installed.
 */
export async function readHostSummary(origin, conversationId, { fetchImpl = fetch, timeoutMs = 1500, budget = 1200 } = {}) {
  const base = String(origin || "").replace(/\/+$/, "");
  if (!base || !conversationId) return "";
  const controller = new AbortController();
  // Same reasoning as readHostFolds: the timeout must be able to fire, and the
  // finally block clears it on every path.
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const url = `${base}/__bili/sessions/${encodeURIComponent(conversationId)}/detail`;
    const resp = await fetchImpl(url, { signal: controller.signal });
    if (!resp?.ok) return "";
    const body = await resp.json();
    const details = asArray(body?.blockDetails).filter((row) => row?.active === true);
    if (!details.length) return "";
    const texts = details
      .map((row) => String(row?.summary || "").trim())
      .filter(Boolean);
    if (!texts.length) return "";
    const cap = Math.max(1, Number(budget) || 1200);
    const kept = [];
    let used = 0;
    for (let i = texts.length - 1; i >= 0; i--) {
      const text = texts[i];
      const cost = estimateTokens(text) + 2;
      const room = cap - used;
      if (cost <= room) {
        kept.push(text);
        used += cost;
        continue;
      }
      if (!kept.length && room > 24) kept.push(clipToTokenBudget(text, room));
      break;
    }
    kept.reverse();
    return kept.join("\n\n");
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
