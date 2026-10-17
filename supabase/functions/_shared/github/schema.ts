import { Schema } from "effect";

export const Base64UrlSegment = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);

export const EncryptedTokenEnvelope = Schema.Struct({
  version: Schema.Literals(["v1"]),
  nonce: Base64UrlSegment,
  ciphertext: Base64UrlSegment,
});

export const Repository = Schema.Struct({
  id: Schema.Union([Schema.Number, Schema.String]),
  name: Schema.String,
  full_name: Schema.String,
  private: Schema.Boolean,
  default_branch: Schema.NullOr(Schema.String),
});
export interface Repository extends Schema.Schema.Type<typeof Repository> {}

export const ApiSchemas = {
  reference: Schema.Struct({
    object: Schema.Struct({ sha: Schema.String }),
  }),
  commit: Schema.Struct({
    tree: Schema.Struct({ sha: Schema.String }),
  }),
  defaultBranch: Schema.Struct({
    default_branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  sha: Schema.Struct({ sha: Schema.String }),
  contents: Schema.Struct({
    content: Schema.Struct({ sha: Schema.String }),
    commit: Schema.Struct({ sha: Schema.String }),
  }),
};

export function parseRepositoryName(fullName: string) {
  const parts = fullName.trim().split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) =>
      !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === ".."
    )
  ) {
    return null;
  }
  return { owner: parts[0], repository: parts[1] };
}
