import { Schema } from "effect";

export class GithubApiError
  extends Schema.TaggedError<GithubApiError>()("GithubApiError", {
    message: Schema.String,
    status: Schema.Int,
    retryAfterMs: Schema.optional(Schema.Number),
  }) {}

export class TokenEncryptionError
  extends Schema.TaggedError<TokenEncryptionError>()("TokenEncryptionError", {
    message: Schema.String,
  }) {}
