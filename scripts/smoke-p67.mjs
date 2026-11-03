/**
 * p67 — a reasoning host that ignores "effort off" must still produce an answer.
 *
 * p66 made the effort fallback reachable. That was necessary but not sufficient:
 * dropping `reasoningEffort` puts the model back in thinking mode, and a thinking
 * model spends the output budget before it writes anything. Measured on this
 * host, 69% of the output tokens were reasoning, so a 900-token extraction call
 * ended with `stop_reason=max_tokens` and no text — the request succeeded, cost
 * money, and returned nothing, which the caller reported as `llmFailed`.
 *
 * Two rules are pinned here:
 *   1. the fallback attempt gets a larger budget than the effort-off attempt;
 *   2. a blank answer is retried once with a larger budget again, and only a
 *      second blank answer is a failure — one that names the budget and finish
 *      reason instead of surfacing as a bare empty string.
 */
import assert from "node:assert/strict";

const { makeLlmCall, EXTRACT_MAX_TOKENS, EXTRACT_FALLBACK_MAX_TOKENS, EXTRACT_ESCALATED_MAX_TOKENS } =
  await import("../lib/index.js");

const PROVIDER = "workbuddy";
const MODEL = "deepseek-v4.1-flash";

const session = {
  id: "smoke-p67",
  requestHeader: () => ({ config: { provider: PROVIDER, model: MODEL } }),
};

/** Feed one canned chunk script per call; `calls` records the configs asked for. */
const makeCtx = (calls, chunkScripts) => ({
  llm: {
    async *stream(config) {
      const index = calls.length;
      calls.push(config);
      const chunks = chunkScripts[Math.min(index, chunkScripts.length - 1)];
      for (const chunk of chunks) yield chunk;
    },
  },
});

const effortRejected = [
  {
    type: "finish",
    reason: {
      kind: "error",
      failure: { code: "UNSUPPORTED_REASONING_EFFORT", message: "does not support reasoning effort" },
    },
  },
];
/** The failure this test exists for: the stream ends cleanly, having said nothing. */
const blankAnswer = () => [{ type: "finish", reason: { kind: "stop" } }];
const okAnswer = (text) => [
  { type: "text-delta", index: 0, text },
  { type: "finish", reason: { kind: "stop" } },
];

/* 1. The reported sequence: effort rejected, then the fallback thinks so long it
 *    returns nothing, then a bigger budget finally gets the JSON out. */
{
  const calls = [];
  const notes = {};
  const ctx = makeCtx(calls, [effortRejected, blankAnswer(), okAnswer('{"candidates":[]}')]);
  const text = await makeLlmCall(ctx, session, undefined, notes)("extract this");

  assert.equal(text, '{"candidates":[]}', "the escalated attempt must produce the answer");
  assert.equal(calls.length, 3, "one effort attempt, one fallback, one escalation");
  assert.equal(calls[0].reasoningEffort, "off");
  assert.equal(calls[0].maxTokens, EXTRACT_MAX_TOKENS);
  assert.equal(calls[1].reasoningEffort, undefined, "the fallback drops the effort");
  assert.equal(
    calls[1].maxTokens,
    EXTRACT_FALLBACK_MAX_TOKENS,
    "the fallback must not keep the effort-off budget",
  );
  assert.ok(
    calls[1].maxTokens > calls[0].maxTokens,
    "a thinking host needs more room than a non-thinking one",
  );
  assert.equal(calls[2].maxTokens, EXTRACT_ESCALATED_MAX_TOKENS, "the escalation is the largest");
  assert.equal(calls[2].reasoningEffort, undefined, "the escalation keeps the working effort setting");
  assert.deepEqual(notes.fallback, { code: "UNSUPPORTED_REASONING_EFFORT", maxTokens: EXTRACT_FALLBACK_MAX_TOKENS });
  assert.equal(notes.escalated.from, EXTRACT_FALLBACK_MAX_TOKENS);
  assert.equal(notes.escalated.to, EXTRACT_ESCALATED_MAX_TOKENS);
  assert.equal(notes.emptyAnswer, undefined, "a recovered call is not an empty-answer failure");
}

/* 2. Blank on every attempt is still a failure — but one that says why, so the
 *    status can be read without a debugger. */
{
  const calls = [];
  const notes = {};
  const ctx = makeCtx(calls, [blankAnswer()]);
  await assert.rejects(
    () => makeLlmCall(ctx, session, undefined, notes)("extract this"),
    (err) => {
      assert.equal(err.code, "EXTRACT_EMPTY_ANSWER");
      assert.match(err.message, /no text/);
      assert.match(err.message, new RegExp(`maxTokens=${EXTRACT_ESCALATED_MAX_TOKENS}`));
      return true;
    },
  );
  assert.equal(calls.length, 2, "effort-off blank, then one escalated blank, then give up");
  assert.deepEqual(notes.emptyAnswer, { maxTokens: EXTRACT_ESCALATED_MAX_TOKENS, finish: "stop" });
}

/* 3. A first attempt that simply works must not pay for any retry. */
{
  const calls = [];
  const notes = {};
  const ctx = makeCtx(calls, [okAnswer('{"candidates":[]}')]);
  const text = await makeLlmCall(ctx, session, undefined, notes)("extract this");
  assert.equal(text, '{"candidates":[]}');
  assert.equal(calls.length, 1, "a working call is not retried");
  assert.equal(calls[0].maxTokens, EXTRACT_MAX_TOKENS, "the common path keeps the cheap budget");
  assert.deepEqual(notes, {}, "nothing to report when the first attempt works");
}

/* 4. A non-effort terminal error must not be swallowed by the escalation path. */
{
  const calls = [];
  const ctx = makeCtx(calls, [
    [{ type: "finish", reason: { kind: "error", failure: { code: "QUOTA", message: "balance exhausted" } } }],
  ]);
  await assert.rejects(
    () => makeLlmCall(ctx, session, undefined)("extract this"),
    (err) => {
      assert.equal(err.code, "QUOTA");
      return true;
    },
  );
  assert.equal(calls.length, 1, "an unrelated failure is not retried");
}

console.log("P67: extraction grows its budget instead of dying on a thinking model");
