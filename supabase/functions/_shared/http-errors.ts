import { Schema } from "effect";

/** Errors produced by the HTTP adapter before an application use case runs. */
export class FunctionError
  extends Schema.TaggedError<FunctionError>()("FunctionError", {
    message: Schema.String,
    status: Schema.Int,
  }) {}
