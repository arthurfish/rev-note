import * as Schema from "effect/Schema";

const idSchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i));

export const NoteId = idSchema;
export type NoteId = typeof NoteId.Type;
export const RevisionId = idSchema;
export type RevisionId = typeof RevisionId.Type;

export const DeviceType = Schema.Literal("desktop", "laptop", "phone", "tablet", "unknown");
export type DeviceType = typeof DeviceType.Type;
export const OperatingSystem = Schema.Literal("windows", "macos", "linux", "android", "ios", "unknown");
export type OperatingSystem = typeof OperatingSystem.Type;

export const Author = Schema.Struct({
  type: Schema.Literal("human", "llm", "program"),
  name: Schema.optional(Schema.String),
});
export type Author = typeof Author.Type;

export const CaptureContext = Schema.Struct({
  time: Schema.Struct({ datetime: Schema.String, timezone: Schema.String }),
  place: Schema.optional(Schema.Struct({ city: Schema.optional(Schema.String) })),
  device: Schema.optional(Schema.Struct({
    type: Schema.optional(DeviceType),
    os: Schema.optional(OperatingSystem),
  })),
});
export type CaptureContext = typeof CaptureContext.Type;

export const Note = Schema.Struct({
  id: NoteId,
  ownerId: Schema.String,
  currentRevisionId: RevisionId,
  createdAt: Schema.String,
  status: Schema.Literal("active", "deleted"),
});
export type Note = typeof Note.Type;

export const Revision = Schema.Struct({
  id: RevisionId,
  noteId: NoteId,
  parentRevisionId: Schema.optional(RevisionId),
  content: Schema.String,
  captureContext: CaptureContext,
  author: Author,
});
export type Revision = typeof Revision.Type;

export const NoteColor = Schema.Literal("neutral", "red", "orange", "yellow", "green", "blue", "purple");
export type NoteColor = typeof NoteColor.Type;

export const NoteUserPreference = Schema.Struct({
  userId: Schema.String,
  noteId: NoteId,
  color: Schema.optional(NoteColor),
  pinned: Schema.optional(Schema.Boolean),
});
export type NoteUserPreference = typeof NoteUserPreference.Type;

export const NoteDerived = Schema.Struct({
  noteId: NoteId,
  revisionId: RevisionId,
  searchDocument: Schema.optional(Schema.String),
  embedding: Schema.optional(Schema.Array(Schema.Number)),
  language: Schema.optional(Schema.String),
  characterCount: Schema.optional(Schema.Number),
  derivedAt: Schema.optional(Schema.String),
});
export type NoteDerived = typeof NoteDerived.Type;

export const SyncOperation = Schema.Struct({
  clientOpId: idSchema,
  type: Schema.Literal("note.created", "revision.created", "note.deleted", "note.restored", "revision.selected", "preference.changed"),
  ownerId: Schema.String,
  noteId: NoteId,
  createdAt: Schema.String,
  payload: Schema.Unknown,
  attempts: Schema.Number,
  queueSeq: Schema.optional(Schema.Number),
});
export type SyncOperation = typeof SyncOperation.Type;

export const LocalSnapshot = Schema.Struct({
  notes: Schema.Array(Note),
  revisions: Schema.Array(Revision),
  preferences: Schema.Array(NoteUserPreference),
  derived: Schema.Array(NoteDerived),
  outbox: Schema.Array(SyncOperation),
  lastPulledSeq: Schema.Number,
});
export type LocalSnapshot = typeof LocalSnapshot.Type;
