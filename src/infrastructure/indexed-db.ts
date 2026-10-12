import * as Schema from "effect/Schema";
import { assertSnapshotIntegrity } from "../domain/commands";
import { LocalSnapshot, Note, NoteUserPreference, Revision, SyncOperation } from "../domain/schema";
import type { Note as NoteValue, NoteDerived as DerivedValue, NoteUserPreference as PreferenceValue, Revision as RevisionValue, SyncOperation as OperationValue } from "../domain/schema";

const DB_NAME = "jianjian-local";
const DB_VERSION = 2;
const STORE_NAMES = ["notes", "revisions", "preferences", "derived", "outbox", "metadata"] as const;
type StoreName = (typeof STORE_NAMES)[number];

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;
      if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
      if (!db.objectStoreNames.contains("revisions")) db.createObjectStore("revisions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("preferences")) db.createObjectStore("preferences", { keyPath: "noteId" });
      if (!db.objectStoreNames.contains("derived")) db.createObjectStore("derived", { keyPath: "noteId" });
      const outbox = db.objectStoreNames.contains("outbox")
        ? request.transaction!.objectStore("outbox")
        : db.createObjectStore("outbox", { keyPath: "clientOpId" });
      if (!outbox.indexNames.contains("queueSeq")) outbox.createIndex("queueSeq", "queueSeq", { unique: true });
      const metadata = db.objectStoreNames.contains("metadata")
        ? request.transaction!.objectStore("metadata")
        : db.createObjectStore("metadata", { keyPath: "key" });
      if (oldVersion > 0) {
        let queueSeq = 1;
        const cursor = outbox.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) {
            metadata.put({ key: "nextQueueSeq", value: queueSeq });
            return;
          }
          item.update({ ...item.value, queueSeq: queueSeq++ });
          item.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地笔记库"));
    request.onblocked = () => reject(new Error("本地笔记库正在被其他标签页占用，请刷新后重试"));
  });
  return databasePromise;
}

async function transaction<T>(stores: StoreName[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openDatabase();
  const tx = db.transaction(stores, mode);
  const complete = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("本地保存失败"));
    tx.onerror = () => reject(tx.error ?? new Error("本地保存失败"));
  });
  try {
    const result = await work(tx);
    await complete;
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* transaction already completed */ }
    throw error;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("读取本地笔记失败"));
  });
}

export async function getLocalOwnerId(): Promise<string> {
  return transaction(["metadata"], "readwrite", async (tx) => {
    const store = tx.objectStore("metadata");
    const row = await requestResult<{ key: string; value: string } | undefined>(store.get("localOwnerId"));
    if (row?.value) return row.value;
    const id = crypto.randomUUID();
    store.put({ key: "localOwnerId", value: id });
    return id;
  });
}

export async function loadSnapshot(): Promise<LocalSnapshot> {
  return transaction([...STORE_NAMES], "readonly", async (tx) => {
    const [notes, revisions, preferences, derived, outbox, cursor] = await Promise.all([
      requestResult<NoteValue[]>(tx.objectStore("notes").getAll()),
      requestResult<RevisionValue[]>(tx.objectStore("revisions").getAll()),
      requestResult<PreferenceValue[]>(tx.objectStore("preferences").getAll()),
      requestResult<DerivedValue[]>(tx.objectStore("derived").getAll()),
      requestResult<OperationValue[]>(tx.objectStore("outbox").index("queueSeq").getAll()),
      requestResult<{ key: string; value: number } | undefined>(tx.objectStore("metadata").get("lastPulledSeq")),
    ]);
    return Schema.decodeUnknownSync(LocalSnapshot)({ notes, revisions, preferences, derived, outbox, lastPulledSeq: cursor?.value ?? 0 });
  });
}

export async function persistNewNote(note: NoteValue, revision: RevisionValue, operation: OperationValue): Promise<void> {
  await transaction(["notes", "revisions", "derived", "outbox", "metadata"], "readwrite", async (tx) => {
    tx.objectStore("notes").add(Schema.decodeUnknownSync(Note)(note));
    tx.objectStore("revisions").add(Schema.decodeUnknownSync(Revision)(revision));
    tx.objectStore("derived").put(derive(revision));
    await queueOperation(tx, operation);
  });
}

export async function persistRevision(note: NoteValue, revision: RevisionValue, operation: OperationValue): Promise<void> {
  await transaction(["notes", "revisions", "derived", "outbox", "metadata"], "readwrite", async (tx) => {
    tx.objectStore("notes").put(Schema.decodeUnknownSync(Note)(note));
    tx.objectStore("revisions").add(Schema.decodeUnknownSync(Revision)(revision));
    tx.objectStore("derived").put(derive(revision));
    await queueOperation(tx, operation);
  });
}

export async function persistNoteAndOperation(note: NoteValue, operation: OperationValue): Promise<void> {
  await transaction(["notes", "outbox", "metadata"], "readwrite", async (tx) => {
    tx.objectStore("notes").put(Schema.decodeUnknownSync(Note)(note));
    await queueOperation(tx, operation);
  });
}

export async function persistPreference(preference: PreferenceValue, operation: OperationValue): Promise<void> {
  await transaction(["preferences", "outbox", "metadata"], "readwrite", async (tx) => {
    tx.objectStore("preferences").put(Schema.decodeUnknownSync(NoteUserPreference)(preference));
    await queueOperation(tx, operation);
  });
}

export async function updateLastPulledSeq(sequence: number): Promise<void> {
  await transaction(["metadata"], "readwrite", async (tx) => {
    tx.objectStore("metadata").put({ key: "lastPulledSeq", value: sequence });
  });
}

export async function acknowledgeOperations(clientOpIds: string[]): Promise<void> {
  if (clientOpIds.length === 0) return;
  await transaction(["outbox"], "readwrite", async (tx) => {
    const store = tx.objectStore("outbox");
    for (const id of clientOpIds) store.delete(id);
  });
}

export type RemoteSyncEvent = {
  server_seq: number | string;
  client_op_id: string;
  note_id: string;
  event_type: OperationValue["type"];
  payload: Record<string, unknown>;
  is_conflict: boolean;
  created_at: string;
};

export async function applyRemoteEvents(events: RemoteSyncEvent[], localOwnerId: string): Promise<{ applied: number; conflicts: number }> {
  if (events.length === 0) return { applied: 0, conflicts: 0 };
  return transaction(["notes", "revisions", "preferences", "derived", "outbox", "metadata"], "readwrite", async (tx) => {
    const noteStore = tx.objectStore("notes");
    const revisionStore = tx.objectStore("revisions");
    const preferenceStore = tx.objectStore("preferences");
    const derivedStore = tx.objectStore("derived");
    const queued = await requestResult<OperationValue[]>(tx.objectStore("outbox").getAll());
    const dirtyNotes = new Set(queued.map((operation) => operation.noteId));
    let applied = 0;
    let conflicts = 0;
    let lastSeq = 0;

    for (const event of events) {
      const payload = event.payload ?? {};
      const isDirty = dirtyNotes.has(event.note_id);
      lastSeq = Math.max(lastSeq, Number(event.server_seq));
      if (event.is_conflict) conflicts++;

      if (event.event_type === "note.created") {
        const rawNote = payload.note;
        const rawRevision = payload.revision;
        if (!rawNote || !rawRevision) continue;
        const revision = Schema.decodeUnknownSync(Revision)(rawRevision);
        const existing = await requestResult<NoteValue | undefined>(noteStore.get(event.note_id));
        const note = Schema.decodeUnknownSync(Note)({
          ...(rawNote as Record<string, unknown>), ownerId: localOwnerId,
          currentRevisionId: String(payload.serverCurrentRevisionId ?? revision.id), status: "active",
        });
        if (!existing) noteStore.put(note);
        revisionStore.put(revision);
        derivedStore.put(derive(revision));
        applied++;
        continue;
      }

      const current = await requestResult<NoteValue | undefined>(noteStore.get(event.note_id));
      if (!current) continue;
      if (event.event_type === "revision.created") {
        const rawRevision = payload.revision;
        if (!rawRevision) continue;
        const revision = Schema.decodeUnknownSync(Revision)(rawRevision);
        revisionStore.put(revision);
        derivedStore.put(derive(revision));
        const currentIsParent = revision.parentRevisionId === current.currentRevisionId;
        const fromThisClientConflict = event.is_conflict && revision.id === current.currentRevisionId;
        if (!isDirty && !fromThisClientConflict && currentIsParent) {
          noteStore.put({ ...current, currentRevisionId: revision.id });
        }
        applied++;
      } else if (event.event_type === "revision.selected") {
        const revisionId = String(payload.revisionId ?? "");
        if (!isDirty && revisionId) noteStore.put({ ...current, currentRevisionId: revisionId });
        applied++;
      } else if (event.event_type === "note.deleted" || event.event_type === "note.restored") {
        if (!isDirty) noteStore.put({ ...current, status: event.event_type === "note.deleted" ? "deleted" : "active" });
        applied++;
      } else if (event.event_type === "preference.changed") {
        const rawPreference = payload.preference;
        if (rawPreference) preferenceStore.put(Schema.decodeUnknownSync(NoteUserPreference)({
          ...(rawPreference as Record<string, unknown>), userId: localOwnerId, noteId: event.note_id,
        }));
        applied++;
      }
    }

    tx.objectStore("metadata").put({ key: "lastPulledSeq", value: lastSeq });
    return { applied, conflicts };
  });
}

export async function exportLocalBackup(): Promise<LocalSnapshot> {
  return loadSnapshot();
}

export async function importLocalBackup(value: unknown): Promise<void> {
  const snapshot = Schema.decodeUnknownSync(LocalSnapshot)(value);
  assertSnapshotIntegrity(snapshot);
  await transaction([...STORE_NAMES], "readwrite", async (tx) => {
    for (const name of ["notes", "revisions", "preferences", "derived", "outbox"] as const) tx.objectStore(name).clear();
    for (const note of snapshot.notes) tx.objectStore("notes").put(note);
    for (const revision of snapshot.revisions) tx.objectStore("revisions").put(revision);
    for (const preference of snapshot.preferences) tx.objectStore("preferences").put(preference);
    for (const item of snapshot.derived) tx.objectStore("derived").put(item);
    let nextQueueSeq = 1;
    for (const [index, operation] of snapshot.outbox.entries()) {
      const queueSeq = operation.queueSeq ?? index + 1;
      tx.objectStore("outbox").put({ ...operation, queueSeq });
      nextQueueSeq = Math.max(nextQueueSeq, queueSeq + 1);
    }
    // The backup cursor may belong to a different browser/account; replay the durable server log.
    tx.objectStore("metadata").put({ key: "lastPulledSeq", value: 0 });
    tx.objectStore("metadata").put({ key: "nextQueueSeq", value: nextQueueSeq });
  });
}

function derive(revision: RevisionValue): DerivedValue {
  return {
    noteId: revision.noteId,
    revisionId: revision.id,
    searchDocument: revision.content,
    characterCount: [...revision.content].length,
    derivedAt: new Date().toISOString(),
  };
}

async function queueOperation(tx: IDBTransaction, operation: OperationValue): Promise<void> {
  const metadata = tx.objectStore("metadata");
  const current = await requestResult<{ key: string; value: number } | undefined>(metadata.get("nextQueueSeq"));
  const queueSeq = current?.value ?? 1;
  metadata.put({ key: "nextQueueSeq", value: queueSeq + 1 });
  tx.objectStore("outbox").add(Schema.decodeUnknownSync(SyncOperation)({ ...operation, queueSeq }));
}
