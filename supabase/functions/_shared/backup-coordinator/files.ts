import type { File, Snapshot } from "../shared-schema.ts";

export interface FileSet {
  readonly files: ReadonlyArray<File>;
  readonly readme: File;
  readonly noteCount: number;
}

export function buildFiles(snapshot: Snapshot): FileSet {
  const revisionById = new Map(
    snapshot.revisions.map((revision) => [revision.id, revision]),
  );
  const preferenceByNote = new Map(
    snapshot.preferences.map((preference) => [preference.noteId, preference]),
  );
  const files: File[] = [];
  const backedUpNoteIds: string[] = [];

  for (const note of snapshot.notes) {
    const revision = note.currentRevisionId
      ? revisionById.get(note.currentRevisionId)
      : undefined;
    if (!revision) continue;

    const preference = preferenceByNote.get(note.id);
    const metadata = {
      noteId: note.id,
      createdAt: note.createdAt,
      status: note.status,
      revision: {
        id: revision.id,
        parentRevisionId: revision.parentRevisionId,
        capturedAt: revision.capturedAt,
        timezone: revision.timezone,
        city: revision.city,
        device: { type: revision.deviceType, os: revision.os },
        author: { type: revision.authorType, name: revision.authorName },
      },
      preference: preference
        ? { color: preference.color, pinned: preference.pinned }
        : null,
    };

    files.push({
      path: `notes/${note.id}.md`,
      content: `${revision.content}\n`,
    });
    files.push({
      path: `metadata/${note.id}.json`,
      content: `${JSON.stringify(metadata, null, 2)}\n`,
    });
    backedUpNoteIds.push(note.id);
  }

  const readme: File = {
    path: "README.md",
    content:
      "# RevNote backup\n\nThis repository contains the current revision of each note, including notes in the trash.\n\n- Notes are readable Markdown files under `notes/`.\n- Capture context, lifecycle status, and note preferences are in `metadata/`.\n",
  };
  files.push(readme);
  files.push({
    path: "manifest.json",
    content: `${
      JSON.stringify(
        {
          format: "rev-note-github-backup",
          version: 1,
          noteCount: backedUpNoteIds.length,
          noteIds: backedUpNoteIds,
        },
        null,
        2,
      )
    }\n`,
  });

  return { files, readme, noteCount: backedUpNoteIds.length };
}
