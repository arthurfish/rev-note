import { Cause, Effect, Exit } from "effect";
import { SupabaseError } from "../errors.ts";
import { executeSupabaseQuery } from "../client.ts";

Deno.test("maps Supabase response errors into typed failures", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      executeSupabaseQuery("read notes", () =>
        Promise.resolve({
          data: null,
          error: { message: "permission denied" },
        })),
    ),
  );

  assert(error instanceof SupabaseError);
  assertEquals(error.operation, "read notes");
  assertEquals(error.message, "permission denied");
});

Deno.test("maps Supabase transport rejections into typed failures", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      executeSupabaseQuery(
        "write backup state",
        () => Promise.reject(new Error("network unavailable")),
      ),
    ),
  );

  assert(error instanceof SupabaseError);
  assertEquals(error.operation, "write backup state");
  assertEquals(error.message, "network unavailable");
});

Deno.test("aborts an in-flight Supabase request when its Effect is interrupted", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  let resolveStarted!: () => void;
  let transportAborted = false;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const query = (signal?: AbortSignal) => {
    receivedSignal = signal;
    resolveStarted();
    if (!signal) return new Promise<{ data: null; error: null }>(() => {});
    return new Promise<{ data: null; error: null }>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        transportAborted = true;
        reject(signal.reason);
      }, { once: true });
    });
  };

  const pending = Effect.runPromiseExit(
    executeSupabaseQuery("read notes", query),
    { signal: controller.signal },
  );
  await started;
  controller.abort();
  const exit = await pending;

  assert(Exit.isFailure(exit));
  assert(Cause.hasInterruptsOnly(exit.cause));
  assert(receivedSignal !== undefined);
  assert(receivedSignal.aborted);
  assert(transportAborted);
});

function assert(condition: boolean): asserts condition {
  if (!condition) throw new Error("Assertion failed");
}

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}
