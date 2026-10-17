import type { Snapshot } from "../../shared-schema.ts";
import { buildFiles } from "../files.ts";

Deno.test("projects current revisions into repository-root backup files", () => {
  const result = buildFiles({
    notes: [
      {
        id: "note-1",
        currentRevisionId: "revision-1",
        createdAt: "2026-10-15T10:00:00.000Z",
        status: "active",
      },
      {
        id: "note-2",
        currentRevisionId: "revision-2",
        createdAt: "2026-10-15T11:00:00.000Z",
        status: "deleted",
      },
      {
        id: "note-3",
        currentRevisionId: "missing-revision",
        createdAt: "2026-10-15T12:00:00.000Z",
        status: "active",
      },
      {
        id: "note-4",
        currentRevisionId: null,
        createdAt: "2026-10-15T13:00:00.000Z",
        status: "active",
      },
    ],
    preferences: [{ noteId: "note-1", color: "blue", pinned: true }],
    revisions: [
      {
        id: "revision-1",
        noteId: "note-1",
        parentRevisionId: null,
        content: "# Current note",
        capturedAt: "2026-10-15T10:00:00.000Z",
        timezone: "UTC",
        city: null,
        deviceType: "laptop",
        os: "linux",
        authorType: "human",
        authorName: null,
      },
      {
        id: "revision-2",
        noteId: "note-2",
        parentRevisionId: null,
        content: "Deleted note content",
        capturedAt: "2026-10-15T11:00:00.000Z",
        timezone: "UTC",
        city: "Paris",
        deviceType: "phone",
        os: "ios",
        authorType: "llm",
        authorName: "Example model",
      },
    ],
  });

  assertEquals(result.noteCount, 2);
  assertEquals(result.files.map((file) => file.path), [
    "notes/note-1.md",
    "metadata/note-1.json",
    "notes/note-2.md",
    "metadata/note-2.json",
    "README.md",
    "manifest.json",
  ]);
  assertEquals(result.files[0].content, "# Current note\n");
  assert(result.files[1].content.includes('"pinned": true'));
  assert(result.files[1].content.includes('"os": "linux"'));
  assert(result.files[3].content.includes('"status": "deleted"'));
  assert(result.files.every((file) => !file.path.startsWith("/")));
  assert(
    result.files[5].content.includes(
      '"noteIds": [\n    "note-1",\n    "note-2"',
    ),
  );
});

Deno.test("writes an empty repository-root backup and manifest", () => {
  const empty: Snapshot = { notes: [], preferences: [], revisions: [] };
  const result = buildFiles(empty);

  assertEquals(result.noteCount, 0);
  assertEquals(result.files.length, 2);
  assertEquals(result.files[0].path, "README.md");
  assert(result.files[1].content.includes('"noteCount": 0'));
  assert(result.files[1].content.includes('"noteIds": []'));
});

function assert(condition: boolean) {
  if (!condition) throw new Error("Assertion failed");
}

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}
