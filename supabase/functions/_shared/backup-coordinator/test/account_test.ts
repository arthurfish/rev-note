import { Effect, Layer } from "effect";
import * as GitHub from "../../github/index.ts";
import { GithubApiError } from "../../github/errors.ts";
import * as Supabase from "../../supabase/index.ts";
import { GithubAccountError } from "../errors.ts";
import { handleAccountAction } from "../account.ts";

const userId = "user-123";
const token = "github_pat_test-token-with-enough-length";

Deno.test("status reports encryption configuration and repository metadata", async () => {
  const harness = createHarness(true, {
    repositoryFullName: "Arthur/rev-note",
  });

  const result = await runAction(userId, { action: "status" }, harness);

  assertEquals(result, {
    configured: true,
    connection: { repositoryFullName: "Arthur/rev-note" },
  });
  assert(!JSON.stringify(result).includes(token));
});

Deno.test("status reports missing encryption configuration", async () => {
  const harness = createHarness(false);

  assertEquals(await runAction(userId, { action: "status" }, harness), {
    configured: false,
    connection: null,
  });
});

Deno.test("connect verifies the repository and stores an encrypted token", async () => {
  const harness = createHarness();

  const result = await runAction(userId, {
    action: "connect",
    token,
    repositoryFullName: "arthur/rev-note",
  }, harness);

  assertEquals(harness.calls, [
    `verifyRepository:${token}:arthur/rev-note`,
    `encrypt:${token}:${userId}:Arthur/rev-note`,
    `getConnection:${userId}`,
    `saveConnection:${userId}:encrypted-token:Arthur/rev-note`,
  ]);
  assertEquals(result, {
    connection: { repositoryFullName: "Arthur/rev-note" },
  });
  assert(
    harness.savedAt !== null && !Number.isNaN(Date.parse(harness.savedAt)),
  );
});

Deno.test("connect rejects invalid repository names before calling GitHub", async () => {
  const harness = createHarness();

  await expectAccountError(
    runActionEffect(userId, {
      action: "connect",
      token,
      repositoryFullName: "https://github.com/arthur/rev-note",
    }, harness),
    400,
    "仓库名称请使用 owner/repository 格式",
  );
  assertEquals(harness.calls, []);
});

Deno.test("connect rejects missing, oversized, and unsupported tokens", async () => {
  const harness = createHarness();
  const message =
    "请输入 fine-grained personal access token（前缀应为 github_pat_）";

  for (
    const value of [
      "short",
      "github_pat_",
      `github_pat_${"x".repeat(513)}`,
      `ghp_${"x".repeat(40)}`,
    ]
  ) {
    await expectAccountError(
      runActionEffect(userId, {
        action: "connect",
        token: value,
        repositoryFullName: "Arthur/rev-note",
      }, harness),
      400,
      message,
    );
  }
  assertEquals(harness.calls, []);
});

Deno.test("connect maps GitHub access failures to the account contract", async () => {
  const harness = createHarness();
  const github: GitHub.Interface = {
    ...harness.github,
    getRepository: () =>
      Effect.fail(
        new GithubApiError({
          message: "Resource not accessible by personal access token",
          status: 403,
        }),
      ),
  };

  await expectAccountError(
    runActionEffect(userId, {
      action: "connect",
      token,
      repositoryFullName: "Arthur/rev-note",
    }, { ...harness, github }),
    403,
    "PAT 无法访问该仓库；请确认 token 只授权了此仓库，并具有 Contents: Read and write 权限",
  );
});

Deno.test("connect requires token encryption to be configured", async () => {
  const harness = createHarness(false);

  await expectAccountError(
    runActionEffect(userId, {
      action: "connect",
      token,
      repositoryFullName: "Arthur/rev-note",
    }, harness),
    503,
    "服务端尚未配置 GITHUB_TOKEN_ENCRYPTION_KEY",
  );
  assertEquals(harness.calls, []);
});

Deno.test("changing repository clears backup state before saving the connection", async () => {
  const harness = createHarness(true, {
    repositoryFullName: "Arthur/old-notes",
  });

  await runAction(userId, {
    action: "connect",
    token,
    repositoryFullName: "Arthur/rev-note",
  }, harness);

  assertEquals(harness.calls, [
    `verifyRepository:${token}:Arthur/rev-note`,
    `encrypt:${token}:${userId}:Arthur/rev-note`,
    `getConnection:${userId}`,
    `deleteBackupState:${userId}`,
    `saveConnection:${userId}:encrypted-token:Arthur/rev-note`,
  ]);
});

Deno.test("disconnect removes the encrypted connection and backup state", async () => {
  const harness = createHarness(true, {
    repositoryFullName: "Arthur/rev-note",
  });

  const result = await runAction(
    userId,
    { action: "disconnect" },
    harness,
  );

  assertEquals(result, { ok: true });
  assertEquals(harness.calls, [
    `deleteConnection:${userId}`,
    `deleteBackupState:${userId}`,
  ]);
});

function createHarness(
  configured = true,
  initialConnection: Supabase.ConnectionInfo | null = null,
) {
  const calls: string[] = [];
  let connection = initialConnection;
  let savedAt: string | null = null;
  const repository: GitHub.Repository = {
    id: 123,
    name: "rev-note",
    full_name: "Arthur/rev-note",
    private: true,
    default_branch: "main",
  };

  const github: GitHub.Interface = {
    isTokenEncryptionConfigured: () => Effect.succeed(configured),
    getRepository: (value, repositoryName) =>
      Effect.sync(() => {
        calls.push(`verifyRepository:${value}:${repositoryName}`);
        return repository;
      }),
    encryptToken: (value, id, repositoryFullName) =>
      Effect.sync(() => {
        calls.push(`encrypt:${value}:${id}:${repositoryFullName}`);
        return "encrypted-token";
      }),
    decryptToken: () => Effect.die("Account flow must not decrypt tokens"),
    publishBackup: () => Effect.die("Account flow must not publish backups"),
  };
  const supabase: Supabase.Interface = {
    connections: {
      getInfo: (id) =>
        Effect.sync(() => {
          calls.push(`getConnection:${id}`);
          return connection;
        }),
      getEncrypted: () => Effect.die("Account flow must not read ciphertext"),
      save: (id, encryptedToken, repositoryFullName, updatedAt) =>
        Effect.sync(() => {
          calls.push(
            `saveConnection:${id}:${encryptedToken}:${repositoryFullName}`,
          );
          savedAt = updatedAt;
          connection = { repositoryFullName };
        }),
      delete: (id) =>
        Effect.sync(() => {
          calls.push(`deleteConnection:${id}`);
          connection = null;
        }),
    },
    backup: {
      readData: () => Effect.die("Account flow must not read backup data"),
      saveState: () => Effect.die("Account flow must not save backup state"),
      deleteState: (id) =>
        Effect.sync(() => {
          calls.push(`deleteBackupState:${id}`);
        }),
    },
  };

  return {
    calls,
    github,
    supabase,
    get savedAt() {
      return savedAt;
    },
  };
}

function runAction(
  userId: string,
  input: Parameters<typeof handleAccountAction>[1],
  harness: ReturnType<typeof createHarness>,
) {
  return Effect.runPromise(runActionEffect(userId, input, harness));
}

function runActionEffect(
  userId: string,
  input: Parameters<typeof handleAccountAction>[1],
  harness: ReturnType<typeof createHarness>,
) {
  const services = Layer.mergeAll(
    Layer.succeed(GitHub.Service, harness.github),
    Layer.succeed(Supabase.Service, harness.supabase),
  );
  return handleAccountAction(userId, input).pipe(Effect.provide(services));
}

async function expectAccountError<E>(
  effect: Effect.Effect<unknown, E>,
  status: number,
  message: string,
) {
  const error = await Effect.runPromise(Effect.flip(effect));
  if (!(error instanceof GithubAccountError)) throw error;
  assertEquals(error.status, status);
  assertEquals(error.message, message);
}

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
