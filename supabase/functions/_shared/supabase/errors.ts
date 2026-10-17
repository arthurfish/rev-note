import { Schema } from "effect";

export class SupabaseError
  extends Schema.TaggedError<SupabaseError>()("SupabaseError", {
    message: Schema.String,
    operation: Schema.String,
  }) {}
