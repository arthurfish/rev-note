import { Effect, Schema } from "effect";
import { NoteRow } from "../schema.ts";

Deno.test("rejects unsupported persisted note states at the Supabase seam", async () => {
  const error = await Effect.runPromise(Effect.flip(
    Schema.decodeUnknownEffect(NoteRow)({
      id: "note-1",
      current_revision_id: null,
      created_at: "2026-10-15T10:00:00.000Z",
      status: "archived",
    }),
  ));

  assert(error instanceof Schema.SchemaError);
});

function assert(condition: boolean): asserts condition {
  if (!condition) throw new Error("Assertion failed");
}
