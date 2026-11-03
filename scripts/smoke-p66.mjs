/**
 * The extraction call must survive a host that reports "reasoning effort
 * unsupported" the way a dsh host actually does it: the stream ends normally
 * carrying `finish.kind = "error"` instead of throwing. Before the fix the
 * fallback only watched for a thrown error, so the retry never ran, the call
 * failed, and automatic extraction stayed dead for the whole session.
 *
 * Also pins the sibling rule: a terminal error finish must not be swallowed into
 * an empty-but-successful result, and the machine code must survive on the error.
 */
import assert from "node:assert/strict";

const { makeLlmCall } = await import("../lib/index.js");

const PROVIDER = "workbuddy";
const MODEL = "deepseek-v4.1-flash";

const session = {
  id: "smoke-p66",
  requestHeader: () => ({ config: { provider: PROVIDER, model: MODEL } }),
};

/** Feed a canned chunk script per call; `calls` records what each invocation asked for. */
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

const errorFinish = (code, message) => [
  { type: "finish", reason: { kind: "error", failure: { code, message } } },
];
const abortedFinish = () => [
  { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "aborted" } } },
];
const okFinish = (text) => [
  { type: "text-delta", index: 0, text },
  { type: "finish", reason: { kind: "stop" } },
];

/* 1. The reported failure mode: effort rejected through finish.kind="error".
 *    The host catalog has no `reasoning` for this model, so dsh-llm refuses the
 *    "off" effort before any request leaves the process. */
{
  const calls = [];
  const ctx = makeCtx(calls, [errorFinish("UNSUPPORTED_REASONING_EFFORT", "does not support reasoning effort"), okFinish('{"candidates":[]}')]);
  const llmCall = makeLlmCall(ctx, session, undefined);
  assert.equal(typeof llmCall, "function", "provider/model must resolve");
  const text = await llmCall("extract this");
  assert.equal(text, '{"candidates":[]}', "the no-effort retry must produce the answer");
  assert.equal(calls.length, 2, "the call must be retried exactly once");
  assert.equal(calls[0].reasoningEffort, "off", "first attempt asks for effort off");
  assert.equal(calls[1].reasoningEffort, undefined, "retry drops the effort");
}

/* 2. Same rejection delivered as a thrown error — that path already worked and
 *    must keep working, so the two shapes stay interchangeable. */
{
  const calls = [];
  const ctx = {
    llm: {
      async *stream(config) {
        const index = calls.length;
        calls.push(config);
        if (index === 0) {
          const err = new Error("does not support reasoning effort");
          err.code = "UNSUPPORTED_REASONING_EFFORT";
          throw err;
        }
        yield { type: "text-delta", index: 0, text: "fallback" };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  };
  const text = await makeLlmCall(ctx, session, undefined)("extract this");
  assert.equal(text, "fallback");
  assert.equal(calls.length, 2, "thrown rejection still retries once");
}

/* 3. Every other terminal error must surface, not be mistaken for the effort
 *    case, and must keep its machine code so callers can classify it. */
{
  const calls = [];
  const ctx = makeCtx(calls, [errorFinish("QUOTA", "balance exhausted")]);
  await assert.rejects(
    () => makeLlmCall(ctx, session, undefined)("extract this"),
    (err) => {
      assert.equal(err.message, "balance exhausted");
      assert.equal(err.code, "QUOTA", "the machine code must survive");
      return true;
    },
  );
  assert.equal(calls.length, 1, "an unrelated failure must not be retried");
}

/* 4. An abort is not an effort problem either: no retry, and no silent empty
 *    success that would make the caller believe the window was processed. */
{
  const calls = [];
  const ctx = makeCtx(calls, [abortedFinish()]);
  await assert.rejects(() => makeLlmCall(ctx, session, undefined)("extract this"));
  assert.equal(calls.length, 1, "an abort must not be retried");
}

console.log("P66: extraction retries when the host reports an unsupported reasoning effort");
