import { Schema } from "effect";

export const Note = Schema.Struct({
  id: Schema.String,
  currentRevisionId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  status: Schema.Literals(["active", "deleted"]),
});
export interface Note extends Schema.Schema.Type<typeof Note> {}

export const Preference = Schema.Struct({
  noteId: Schema.String,
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
export interface Preference extends Schema.Schema.Type<typeof Preference> {}

export const Revision = Schema.Struct({
  id: Schema.String,
  noteId: Schema.String,
  parentRevisionId: Schema.NullOr(Schema.String),
  content: Schema.String,
  capturedAt: Schema.String,
  timezone: Schema.String,
  city: Schema.NullOr(Schema.String),
  deviceType: Schema.NullOr(
    Schema.Literals(["desktop", "laptop", "phone", "tablet", "unknown"]),
  ),
  os: Schema.NullOr(
    Schema.Literals(["windows", "macos", "linux", "android", "ios", "unknown"]),
  ),
  authorType: Schema.Literals(["human", "llm", "program"]),
  authorName: Schema.NullOr(Schema.String),
});
export interface Revision extends Schema.Schema.Type<typeof Revision> {}

export interface Snapshot {
  readonly notes: ReadonlyArray<Note>;
  readonly preferences: ReadonlyArray<Preference>;
  readonly revisions: ReadonlyArray<Revision>;
}

export interface File {
  readonly path: string;
  readonly content: string;
}
