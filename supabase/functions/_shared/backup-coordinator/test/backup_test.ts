import { Effect, Layer, Option, Redacted } from "effect";
import * as GitHub from "../../github/index.ts";
import { GithubApiError } from "../../github/errors.ts";
import * as Supabase from "../../supabase/index.ts";
import type { Snapshot } from "../../shared-schema.ts";
import { encryptGithubToken } from "../../github/token.ts";
import { GithubBackupError } from "../errors.ts";
import { runBackup } from "../backup.ts";

const userId = "user-123";

Deno.test("coordinates a user-scoped backup and saves its state", async () => {
  const harness = createHarness();

  const result = await runBackupWith(harness);

  assertEquals(result, {
    ok: true,
    repository: "Arthur/rev-note",
    branch: "main",
    commitSha: "new-commit",
    noteCount: 1,
  });
  assertEquals(harness.calls, [
    `getConnection:${userId}`,
    `decrypt:${userId}:Arthur/rev-note`,
    "getRepository:Arthur/rev-note",
    `getBackupData:${userId}`,
    "publishBackup:main",
    "saveBackupState:Arthur/rev-note:main:new-commit:1",
  ]);
  assertEquals(harness.files.map((file) => file.path), [
    "notes/note-1.md",
    "metadata/note-1.json",
    "README.md",
    "manifest.json",
  ]);
  assertEquals(harness.files[0].content, "# Note content\n");
  assert(harness.files[1].content.includes('"pinned": true'));
  assert(harness.files[3].content.includes('"noteIds": [\n    "note-1"'));
});

Deno.test("requires a saved connection before reading backup data", async () => {
  const harness = createHarness({ connection: null });

  await expectBackupError(
    runBackupEffect(harness),
    409,
    "请先连接 GitHub PAT 并设置备份仓库",
  );
  assertEquals(harness.calls, [`getConnection:${userId}`]);
});

Deno.test("maps GitHub PAT authorization failures to backup errors", async () => {
  const harness = createHarness();
  const github: GitHub.Interface = {
    ...harness.github,
    getRepository: () =>
      Effect.fail(new GithubApiError({ message: "Forbidden", status: 403 })),
  };

  await expectBackupError(
    runBackupEffect({ ...harness, github }),
    403,
    "GitHub PAT 无权写入该仓库；请确认 Contents: Read and write 权限及组织审批状态",
  );
});

Deno.test("maps an expired GitHub PAT to the reconnect contract", async () => {
  const harness = createHarness();
  const github: GitHub.Interface = {
    ...harness.github,
    getRepository: () =>
      Effect.fail(
        new GithubApiError({ message: "Bad credentials", status: 401 }),
      ),
  };

  await expectBackupError(
    runBackupEffect({ ...harness, github }),
    401,
    "GitHub PAT 无效或已过期，请重新连接",
  );
});

Deno.test("re-encrypts the saved PAT when GitHub returns a canonical repository name", async () => {
  const harness = createHarness({
    connection: {
      tokenCiphertext: "encrypted-token",
      repositoryFullName: "arthur/rev-note",
    },
  });

  await runBackupWith(harness);

  assert(harness.calls.includes(
    `encrypt:github_pat_test-token:${userId}:Arthur/rev-note`,
  ));
  assert(harness.calls.includes(
    `saveConnection:${userId}:encrypted-token:Arthur/rev-note`,
  ));
});

Deno.test("keeps a saved PAT usable when GitHub renames its repository", async () => {
  const encryptionKey = encodeBase64(new Uint8Array(32).fill(7));
  const oldRepositoryName = "Arthur/old-rev-note";
  const renamedRepositoryName = "Arthur/rev-note";
  const originalCiphertext = await Effect.runPromise(
    encryptGithubToken(
      "github_pat_test-token",
      encryptionKey,
      userId,
      oldRepositoryName,
    ),
  );
  let connection: Supabase.EncryptedConnection = {
    tokenCiphertext: originalCiphertext,
    repositoryFullName: oldRepositoryName,
  };

  const fakeFetch: typeof fetch = (input, init) => {
    const requestUrl = String(input);
    const method = init?.method ?? "GET";
    if (
      requestUrl.endsWith("/repos/Arthur/old-rev-note") ||
      requestUrl.endsWith("/repos/Arthur/rev-note")
    ) {
      return Promise.resolve(Response.json({
        id: 123,
        name: "rev-note",
        full_name: renamedRepositoryName,
        private: true,
        default_branch: "main",
      }));
    }
    if (requestUrl.endsWith("/git/ref/heads/main")) {
      return Promise.resolve(Response.json({ object: { sha: "parent" } }));
    }
    if (requestUrl.endsWith("/git/commits/parent")) {
      return Promise.resolve(Response.json({ tree: { sha: "tree" } }));
    }
    if (requestUrl.endsWith("/git/trees") && method === "POST") {
      return Promise.resolve(Response.json({ sha: "tree" }));
    }
    throw new Error(`Unexpected request: ${method} ${requestUrl}`);
  };

  const supabase: Supabase.Interface = {
    connections: {
      getInfo: () => Effect.succeed(null),
      getEncrypted: () => Effect.sync(() => connection),
      save: (_id, tokenCiphertext, repositoryFullName) =>
        Effect.sync(() => {
          connection = { tokenCiphertext, repositoryFullName };
        }),
      delete: () => Effect.void,
    },
    backup: {
      readData: () =>
        Effect.succeed({ notes: [], preferences: [], revisions: [] }),
      saveState: () => Effect.void,
      deleteState: () => Effect.void,
    },
  };
  const services = Layer.mergeAll(
    GitHub.layer(fakeFetch, {
      encryptionKey: Option.some(Redacted.make(encryptionKey)),
    }),
    Layer.succeed(Supabase.Service, supabase),
  );

  await Effect.runPromise(runBackup(userId).pipe(Effect.provide(services)));
  const result = await Effect.runPromise(
    runBackup(userId).pipe(Effect.provide(services)),
  );

  assertEquals(result.repository, renamedRepositoryName);
  assertEquals(connection.repositoryFullName, renamedRepositoryName);
  assert(connection.tokenCiphertext !== originalCiphertext);
});

function createHarness(options: {
  readonly connection?: Supabase.EncryptedConnection | null;
} = {}) {
  const calls: string[] = [];
  const files: GitHub.BackupFile[] = [];
  const connection = options.connection === undefined
    ? {
      tokenCiphertext: "encrypted-token",
      repositoryFullName: "Arthur/rev-note",
    }
    : options.connection;
  const repository: GitHub.Repository = {
    id: 123,
    name: "rev-note",
    full_name: "Arthur/rev-note",
    private: true,
    default_branch: "main",
  };
  const snapshot: Snapshot = {
    notes: [{
      id: "note-1",
      currentRevisionId: "revision-1",
      createdAt: "2026-10-15T10:00:00.000Z",
      status: "active",
    }],
    preferences: [{ noteId: "note-1", color: "blue", pinned: true }],
    revisions: [{
      id: "revision-1",
      noteId: "note-1",
      parentRevisionId: null,
      content: "# Note content",
      capturedAt: "2026-10-15T10:00:00.000Z",
      timezone: "UTC",
      city: null,
      deviceType: "laptop",
      os: "linux",
      authorType: "human",
      authorName: null,
    }],
  };

  const github: GitHub.Interface = {
    isTokenEncryptionConfigured: () => Effect.succeed(true),
    encryptToken: (value, id, repositoryFullName) =>
      Effect.sync(() => {
        calls.push(`encrypt:${value}:${id}:${repositoryFullName}`);
        return "encrypted-token";
      }),
    decryptToken: (_encrypted, id, repositoryFullName) =>
      Effect.sync(() => {
        calls.push(`decrypt:${id}:${repositoryFullName}`);
        return "github_pat_test-token";
      }),
    getRepository: (_token, repositoryFullName) =>
      Effect.sync(() => {
        calls.push(`getRepository:${repositoryFullName}`);
        return repository;
      }),
    publishBackup: (input) =>
      Effect.sync(() => {
        calls.push(`publishBackup:${input.defaultBranch}`);
        files.push(...input.files);
        return { branch: input.defaultBranch, commitSha: "new-commit" };
      }),
  };
  const supabase: Supabase.Interface = {
    connections: {
      getInfo: () => Effect.die("Backup flow must read encrypted connection"),
      getEncrypted: (id) =>
        Effect.sync(() => {
          calls.push(`getConnection:${id}`);
          return connection;
        }),
      save: (id, encryptedToken, repositoryFullName) =>
        Effect.sync(() => {
          calls.push(
            `saveConnection:${id}:${encryptedToken}:${repositoryFullName}`,
          );
        }),
      delete: () => Effect.die("Backup flow must not delete a connection"),
    },
    backup: {
      readData: (id) =>
        Effect.sync(() => {
          calls.push(`getBackupData:${id}`);
          return snapshot;
        }),
      saveState: (
        _id,
        repositoryFullName,
        branch,
        commitSha,
        _lastBackupAt,
        noteCount,
      ) =>
        Effect.sync(() => {
          calls.push(
            `saveBackupState:${repositoryFullName}:${branch}:${commitSha}:${noteCount}`,
          );
        }),
      deleteState: () => Effect.die("Backup flow must not delete backup state"),
    },
  };

  return { calls, files, github, supabase };
}

function runBackupWith(harness: ReturnType<typeof createHarness>) {
  return Effect.runPromise(runBackupEffect(harness));
}

function runBackupEffect(harness: ReturnType<typeof createHarness>) {
  const services = Layer.mergeAll(
    Layer.succeed(GitHub.Service, harness.github),
    Layer.succeed(Supabase.Service, harness.supabase),
  );
  return runBackup(userId).pipe(Effect.provide(services));
}

async function expectBackupError<E>(
  effect: Effect.Effect<unknown, E>,
  status: number,
  message: string,
) {
  const error = await Effect.runPromise(Effect.flip(effect));
  if (!(error instanceof GithubBackupError)) throw error;
  assertEquals(error.status, status);
  assertEquals(error.message, message);
}

function assert(condition: boolean) {
  if (!condition) throw new Error("Assertion failed");
}

function encodeBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
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
