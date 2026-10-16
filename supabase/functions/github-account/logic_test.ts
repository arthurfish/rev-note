import {
  GithubAccountError,
  handleGithubAccountAction,
  type GithubAccountConnection,
  type GithubAccountDependencies,
  type GithubRepository,
} from "./logic.ts";
import { GithubApiError } from "../_shared/github.ts";

const userId = "user-123";
const fixedNow = new Date("2026-10-13T12:00:00.000Z");
const token = "github_pat_test-token-with-enough-length";

Deno.test("status reports encryption configuration and only exposes repository metadata", async () => {
  const { dependencies, connection } = createHarness(true, { repositoryFullName: "Arthur/rev-note" });

  const result = await handleGithubAccountAction(userId, { action: "status" }, dependencies);

  assertEquals(result, {
    configured: true,
    connection: { repositoryFullName: "Arthur/rev-note" },
  });
  assert(!JSON.stringify(result).includes(token));
  assertEquals(connection.value?.repositoryFullName, "Arthur/rev-note");
});

Deno.test("status reports when the token encryption key is not configured", async () => {
  const { dependencies } = createHarness(false);

  assertEquals(await handleGithubAccountAction(userId, { action: "status" }, dependencies), {
    configured: false,
    connection: null,
  });
});

Deno.test("connect verifies the selected repository and stores only the encrypted token", async () => {
  const { dependencies, calls, connection } = createHarness();

  const result = await handleGithubAccountAction(userId, {
    action: "connect",
    token,
    repositoryFullName: "arthur/rev-note",
  }, dependencies);

  assertEquals(calls, [
    `verifyRepository:${token}:arthur/rev-note`,
    `encrypt:${token}:${userId}:Arthur/rev-note`,
    `getConnection:${userId}`,
    `saveConnection:${userId}:encrypted-token:Arthur/rev-note:${fixedNow.toISOString()}`,
  ]);
  assertEquals(result, { connection: { repositoryFullName: "Arthur/rev-note" } });
  assertEquals(connection.value, { repositoryFullName: "Arthur/rev-note" });
});

Deno.test("connect rejects invalid repository names before calling GitHub", async () => {
  const { dependencies, calls } = createHarness();

  await expectAccountError(
    () => handleGithubAccountAction(userId, { action: "connect", token, repositoryFullName: "https://github.com/arthur/rev-note" }, dependencies),
    400,
    "仓库名称请使用 owner/repository 格式",
  );
  assertEquals(calls, []);
});

Deno.test("connect rejects missing and oversized tokens", async () => {
  const { dependencies, calls } = createHarness();

  await expectAccountError(
    () => handleGithubAccountAction(userId, { action: "connect", token: "short", repositoryFullName: "Arthur/rev-note" }, dependencies),
    400,
    "请输入 fine-grained personal access token（前缀应为 github_pat_）",
  );
  await expectAccountError(
    () => handleGithubAccountAction(userId, { action: "connect", token: "github_pat_", repositoryFullName: "Arthur/rev-note" }, dependencies),
    400,
    "请输入 fine-grained personal access token（前缀应为 github_pat_）",
  );
  await expectAccountError(
    () => handleGithubAccountAction(userId, { action: "connect", token: `github_pat_${"x".repeat(513)}`, repositoryFullName: "Arthur/rev-note" }, dependencies),
    400,
    "请输入 fine-grained personal access token（前缀应为 github_pat_）",
  );
  await expectAccountError(
    () => handleGithubAccountAction(userId, { action: "connect", token: `ghp_${"x".repeat(40)}`, repositoryFullName: "Arthur/rev-note" }, dependencies),
    400,
    "请输入 fine-grained personal access token（前缀应为 github_pat_）",
  );
  assertEquals(calls, []);
});

Deno.test("connect rejects a repository the token cannot access", async () => {
  const { dependencies } = createHarness();
  dependencies.getGithubRepository = async () => {
    throw new GithubApiError("Resource not accessible by personal access token", 403);
  };

  await expectAccountError(
    () => handleGithubAccountAction(userId, { action: "connect", token, repositoryFullName: "Arthur/rev-note" }, dependencies),
    403,
    "PAT 无法访问该仓库；请确认 token 只授权了此仓库，并具有 Contents: Read and write 权限",
  );
});

Deno.test("connect requires encryption to be configured", async () => {
  const { dependencies, calls } = createHarness(false);

  await expectAccountError(
    () => handleGithubAccountAction(userId, { action: "connect", token, repositoryFullName: "Arthur/rev-note" }, dependencies),
    503,
    "服务端尚未配置 GITHUB_TOKEN_ENCRYPTION_KEY",
  );
  assertEquals(calls, []);
});

Deno.test("changing the repository clears backup state before saving the new connection", async () => {
  const { dependencies, calls } = createHarness(true, { repositoryFullName: "Arthur/old-notes" });

  await handleGithubAccountAction(userId, { action: "connect", token, repositoryFullName: "Arthur/rev-note" }, dependencies);

  assertEquals(calls, [
    `verifyRepository:${token}:Arthur/rev-note`,
    `encrypt:${token}:${userId}:Arthur/rev-note`,
    `getConnection:${userId}`,
    `deleteBackupState:${userId}`,
    `saveConnection:${userId}:encrypted-token:Arthur/rev-note:${fixedNow.toISOString()}`,
  ]);
});

Deno.test("disconnect deletes the encrypted connection and backup state", async () => {
  const { dependencies, calls } = createHarness(true, { repositoryFullName: "Arthur/rev-note" });

  const result = await handleGithubAccountAction(userId, { action: "disconnect" }, dependencies);

  assertEquals(result, { ok: true });
  assertEquals(calls, [`deleteConnection:${userId}`, `deleteBackupState:${userId}`]);
});

function createHarness(configured = true, initialConnection: GithubAccountConnection | null = null) {
  const calls: string[] = [];
  const connection: { value: GithubAccountConnection | null } = { value: initialConnection };
  const repository: GithubRepository = {
    full_name: "Arthur/rev-note",
    private: true,
    default_branch: "main",
  };
  const dependencies: GithubAccountDependencies = {
    isTokenEncryptionConfigured: () => configured,
    now: () => fixedNow,
    getConnection: async (id) => {
      calls.push(`getConnection:${id}`);
      return connection.value;
    },
    getGithubRepository: async (value, repositoryName) => {
      calls.push(`verifyRepository:${value}:${repositoryName}`);
      return repository;
    },
    encryptToken: async (value, id, repositoryFullName) => {
      calls.push(`encrypt:${value}:${id}:${repositoryFullName}`);
      return "encrypted-token";
    },
    saveConnection: async (id, encryptedToken, repositoryFullName, updatedAt) => {
      calls.push(`saveConnection:${id}:${encryptedToken}:${repositoryFullName}:${updatedAt}`);
      connection.value = { repositoryFullName };
    },
    deleteConnection: async (id) => {
      calls.push(`deleteConnection:${id}`);
      connection.value = null;
    },
    deleteBackupState: async (id) => {
      calls.push(`deleteBackupState:${id}`);
    },
  };

  return { dependencies, calls, connection };
}

async function expectAccountError(operation: () => Promise<unknown>, status: number, message: string) {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof GithubAccountError)) throw error;
    assertEquals(error.status, status);
    assertEquals(error.message, message);
    return;
  }
  throw new Error(`Expected GithubAccountError (${status}): ${message}`);
}

function assert(condition: boolean) {
  if (!condition) throw new Error("Assertion failed");
}

function assertEquals(actual: unknown, expected: unknown) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}
