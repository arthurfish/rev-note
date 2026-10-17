import { Schema } from "effect";

export const NamedKeys = Schema.Struct({
  default: Schema.optionalKey(Schema.String),
});

export const ConnectionInfoRow = Schema.Struct({
  repository_full_name: Schema.String,
});
export interface ConnectionInfoRow
  extends Schema.Schema.Type<typeof ConnectionInfoRow> {}

export const EncryptedConnectionRow = Schema.Struct({
  token_ciphertext: Schema.String,
  repository_full_name: Schema.String,
});
export interface EncryptedConnectionRow
  extends Schema.Schema.Type<typeof EncryptedConnectionRow> {}

export const NoteRow = Schema.Struct({
  id: Schema.String,
  current_revision_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  status: Schema.Literals(["active", "deleted"]),
});
export interface NoteRow extends Schema.Schema.Type<typeof NoteRow> {}

export const PreferenceRow = Schema.Struct({
  note_id: Schema.String,
  color: Schema.NullOr(
    Schema.Literals([
      "neutral",
      "red",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
    ]),
  ),
  pinned: Schema.Boolean,
});
export interface PreferenceRow
  extends Schema.Schema.Type<typeof PreferenceRow> {}

export const RevisionRow = Schema.Struct({
  id: Schema.String,
  note_id: Schema.String,
  parent_revision_id: Schema.NullOr(Schema.String),
  content: Schema.String,
  captured_at: Schema.String,
  timezone: Schema.String,
  city: Schema.NullOr(Schema.String),
  device_type: Schema.NullOr(
    Schema.Literals(["desktop", "laptop", "phone", "tablet", "unknown"]),
  ),
  os: Schema.NullOr(
    Schema.Literals(["windows", "macos", "linux", "android", "ios", "unknown"]),
  ),
  author_type: Schema.Literals(["human", "llm", "program"]),
  author_name: Schema.NullOr(Schema.String),
});
export interface RevisionRow extends Schema.Schema.Type<typeof RevisionRow> {}

export interface ConnectionInfo {
  readonly repositoryFullName: string;
}

export interface EncryptedConnection extends ConnectionInfo {
  readonly tokenCiphertext: string;
}
