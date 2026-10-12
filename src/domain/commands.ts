import type { Author, CaptureContext, LocalSnapshot, Note, NoteColor, NoteId, NoteUserPreference, Revision, RevisionId, SyncOperation } from "./schema";

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

const stamp = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

export function createNote(input: {
  ownerId: string;
  content: string;
  captureContext: CaptureContext;
  author?: Author;
  now?: string;
}): { note: Note; revision: Revision; operation: SyncOperation } {
  const now = input.now ?? stamp();
  const noteId = uuid() as NoteId;
  const revisionId = uuid() as RevisionId;
  const note: Note = { id: noteId, ownerId: input.ownerId, currentRevisionId: revisionId, createdAt: now, status: "active" };
  const revision: Revision = Object.freeze({
    id: revisionId,
    noteId,
    content: input.content,
    captureContext: Object.freeze(input.captureContext),
    author: input.author ?? { type: "human" as const },
  });
  return { note, revision, operation: makeOperation(note, "note.created", { note, revision }, now) };
}

export function reviseNote(input: {
  note: Note;
  revisions: readonly Revision[];
  content: string;
  captureContext: CaptureContext;
  author?: Author;
  now?: string;
}): { note: Note; revision: Revision; operation: SyncOperation } {
  if (input.note.status !== "active") throw new DomainError("已删除的笔记不能修改");
  const parent = input.revisions.find((revision) => revision.id === input.note.currentRevisionId);
  if (!parent || parent.noteId !== input.note.id) throw new DomainError("当前版本不属于这条笔记");
  if (parent.content === input.content) throw new DomainError("内容没有变化");
  const now = input.now ?? stamp();
  const revision: Revision = Object.freeze({
    id: uuid() as RevisionId,
    noteId: input.note.id,
    parentRevisionId: parent.id,
    content: input.content,
    captureContext: Object.freeze(input.captureContext),
    author: input.author ?? { type: "human" as const },
  });
  const note: Note = { ...input.note, currentRevisionId: revision.id };
  return { note, revision, operation: makeOperation(note, "revision.created", { note, revision, expectedParentRevisionId: parent.id }, now) };
}

export function deleteNote(note: Note, now = stamp()): { note: Note; operation: SyncOperation } {
  if (note.status === "deleted") throw new DomainError("这条笔记已经在回收站中");
  const updated = { ...note, status: "deleted" as const };
  return { note: updated, operation: makeOperation(updated, "note.deleted", { note: updated }, now) };
}

export function restoreNote(note: Note, now = stamp()): { note: Note; operation: SyncOperation } {
  if (note.status === "active") throw new DomainError("这条笔记当前未删除");
  const updated = { ...note, status: "active" as const };
  return { note: updated, operation: makeOperation(updated, "note.restored", { note: updated }, now) };
}

export function selectRevision(input: {
  note: Note;
  revisions: readonly Revision[];
  revisionId: RevisionId;
  now?: string;
}): { note: Note; operation: SyncOperation } {
  const selected = input.revisions.find((revision) => revision.id === input.revisionId);
  if (!selected || selected.noteId !== input.note.id) throw new DomainError("这个版本不属于当前笔记");
  const note = { ...input.note, currentRevisionId: selected.id };
  return { note, operation: makeOperation(note, "revision.selected", { note, revisionId: selected.id }, input.now ?? stamp()) };
}

export function setNotePreference(input: {
  userId: string;
  noteId: NoteId;
  previous?: NoteUserPreference;
  color?: NoteColor;
  pinned?: boolean;
  now?: string;
}): { preference: NoteUserPreference; operation: SyncOperation } {
  const preference: NoteUserPreference = {
    userId: input.userId,
    noteId: input.noteId,
    ...(input.color !== undefined ? { color: input.color } : input.previous?.color ? { color: input.previous.color } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : input.previous?.pinned !== undefined ? { pinned: input.previous.pinned } : {}),
  };
  const operation: SyncOperation = {
    clientOpId: uuid(), type: "preference.changed", ownerId: input.userId,
    noteId: input.noteId, createdAt: input.now ?? stamp(), payload: { preference }, attempts: 0,
  };
  return { preference, operation };
}

export function assertSnapshotIntegrity(snapshot: LocalSnapshot): void {
  const notes = new Map(snapshot.notes.map((note) => [note.id, note]));
  const revisions = new Map(snapshot.revisions.map((revision) => [revision.id, revision]));
  if (notes.size !== snapshot.notes.length || revisions.size !== snapshot.revisions.length) throw new DomainError("备份中有重复的笔记或版本 ID");
  for (const note of snapshot.notes) {
    const current = revisions.get(note.currentRevisionId);
    if (!current || current.noteId !== note.id) throw new DomainError("备份里的当前版本不属于对应笔记");
  }
  for (const revision of snapshot.revisions) {
    if (!notes.has(revision.noteId)) throw new DomainError("备份里有找不到笔记的版本");
    if (revision.parentRevisionId) {
      const parent = revisions.get(revision.parentRevisionId);
      if (!parent || parent.noteId !== revision.noteId) throw new DomainError("备份里的版本关系无效");
    }
  }
  for (const revision of snapshot.revisions) {
    const visited = new Set<string>();
    let cursor: Revision | undefined = revision;
    while (cursor?.parentRevisionId) {
      if (visited.has(cursor.id)) throw new DomainError("备份里的版本关系形成了循环");
      visited.add(cursor.id);
      cursor = revisions.get(cursor.parentRevisionId);
    }
    if (cursor && visited.has(cursor.id)) throw new DomainError("备份里的版本关系形成了循环");
  }
  for (const preference of snapshot.preferences) if (!notes.has(preference.noteId)) throw new DomainError("备份里有找不到笔记的偏好设置");
  for (const derived of snapshot.derived) {
    const revision = revisions.get(derived.revisionId);
    if (!notes.has(derived.noteId) || !revision || revision.noteId !== derived.noteId) throw new DomainError("备份里的派生数据引用了无效版本");
  }
  for (const operation of snapshot.outbox) if (!notes.has(operation.noteId)) throw new DomainError("备份里的待同步操作引用了找不到的笔记");
}

function makeOperation(note: Note, type: SyncOperation["type"], payload: unknown, now: string): SyncOperation {
  return { clientOpId: uuid(), type, ownerId: note.ownerId, noteId: note.id, createdAt: now, payload, attempts: 0 };
}
