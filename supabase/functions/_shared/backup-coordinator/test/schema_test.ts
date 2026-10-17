import { Effect, Exit, Schema } from "effect";
import { ActionInput } from "../schema.ts";

Deno.test("accepts omitted request fields but rejects explicit undefined", async () => {
  const input = await Effect.runPromise(
    Schema.decodeUnknownEffect(ActionInput)({ action: "status" }),
  );
  assertEquals(input.action, "status");

  const explicitUndefined = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(ActionInput)({
      action: "status",
      token: undefined,
    }),
  );
  assert(Exit.isFailure(explicitUndefined));
});

function assert(condition: boolean): asserts condition {
  if (!condition) throw new Error("Assertion failed");
}

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}
