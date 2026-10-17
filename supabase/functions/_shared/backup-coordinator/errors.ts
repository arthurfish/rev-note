import { Schema } from "effect";

export class GithubAccountError
  extends Schema.TaggedError<GithubAccountError>()("GithubAccountError", {
    message: Schema.String,
    status: Schema.Int,
  }) {}

export class GithubBackupError
  extends Schema.TaggedError<GithubBackupError>()("GithubBackupError", {
    message: Schema.String,
    status: Schema.Int,
  }) {}
