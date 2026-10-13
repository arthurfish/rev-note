import {
  GithubAccountError,
  handleGithubAccountAction,
  type GithubAccountConnection,
  type GithubAccountDependencies,
  type GithubRepository,
} from "./logic.ts";

const userId = "user-123";
const fixedNow = new Date("2026-10-13T12:00:00.000Z");

Deno.test("status reports configuration and exposes only client connection fields", async () => {
  const { dependencies } = createHarness();

  const result = await handleGithubAccountAction(userId, { action: "status" }, dependencies);

  assertEquals(result, {
    configured: true,
    connection: {
      installationAccountLogin: "Arthur",
      repositoryId: null,
      repositoryFullName: null,
    },
  });
});

Deno.test("start prunes expired states and stores a hashed state with a ten-minute expiry", async () => {
  const { dependencies, calls } = createHarness();

  const result = await handleGithubAccountAction(userId, { action: "start" }, dependencies);

  assertEquals(calls, [
    "deleteExpired:2026-10-13T12:00:00.000Z",
    "insertState:sha256:opaque-state:user-123:2026-10-13T12:10:00.000Z",
  ]);
  assertEquals(result, {
    installUrl: "https://github.com/apps/revnote-app/installations/new?state=opaque-state",
  });
});

Deno.test("start is rejected when the GitHub App is not configured", async () => {
  const { dependencies, calls } = createHarness(false);

  await expectAccountError(
    () => handleGithubAccountAction(userId, { action: "start" }, dependencies),
    503,
    "GitHub App 尚未完成服务端配置",
  );
  assertEquals(calls, []);
});

Deno.test("repositories only returns repositories belonging to the installation account", async () => {
  const { dependencies } = createHarness();

  const result = await handleGithubAccountAction(userId, { action: "repositories" }, dependencies);

  assertEquals(result, {
    repositories: [
      { id: "123", fullName: "Arthur/rev-note", private: true, defaultBranch: "main" },
      { id: "789", fullName: "ARTHUR/archive", private: false, defaultBranch: null },
    ],
    selectedRepositoryId: null,
  });
});

Deno.test("repository selection rejects non-numeric repository IDs before calling GitHub", async () => {
  const { dependencies, calls } = createHarness();

  await expectAccountError(
    () => handleGithubAccountAction(userId, { action: "select-repository", repositoryId: "../123" }, dependencies),
    400,
    "请选择一个有效仓库",
  );
  assertEquals(calls, ["getConnection:user-123"]);
});

Deno.test("repository selection rejects repositories outside the installation scope", async () => {
  const { dependencies } = createHarness();

  await expectAccountError(
    () => handleGithubAccountAction(userId, { action: "select-repository", repositoryId: "999" }, dependencies),
    403,
    "该仓库不在 GitHub App 的授权范围内，请重新加载列表",
  );
});

Deno.test("repository selection rejects repositories owned by another account", async () => {
  const { dependencies } = createHarness();

  await expectAccountError(
    () => handleGithubAccountAction(userId, { action: "select-repository", repositoryId: "456" }, dependencies),
    403,
    "请选择安装 GitHub App 的个人账号所拥有的仓库",
  );
});

Deno.test("repository selection persists the validated repository and returns the updated connection", async () => {
  const { dependencies, calls } = createHarness();

  const result = await handleGithubAccountAction(userId, { action: "select-repository", repositoryId: "123" }, dependencies);

  assertEquals(calls, [
    "getConnection:user-123",
    "createToken:installation-42",
    "listRepositories:installation-token",
    "updateRepository:user-123:123:Arthur/rev-note:2026-10-13T12:00:00.000Z",
    "getConnection:user-123",
  ]);
  assertEquals(result, {
    connection: {
      installationAccountLogin: "Arthur",
      repositoryId: "123",
      repositoryFullName: "Arthur/rev-note",
    },
  });
});

Deno.test("disconnect deletes the connection and its backup state", async () => {
  const { dependencies, calls } = createHarness();

  const result = await handleGithubAccountAction(userId, { action: "disconnect" }, dependencies);

  assertEquals(result, { ok: true });
  assertEquals(calls, ["getConnection:user-123", "deleteConnection:user-123", "deleteBackupState:user-123"]);
});

Deno.test("actions requiring a connection return conflict when the user is not connected", async () => {
  const { dependencies, connection, calls } = createHarness();
  connection.value = null;

  await expectAccountError(
    () => handleGithubAccountAction(userId, { action: "repositories" }, dependencies),
    409,
    "请先连接 GitHub App",
  );
  assertEquals(calls, ["getConnection:user-123"]);
});

function createHarness(configured = true) {
  const calls: string[] = [];
  const connection: { value: GithubAccountConnection | null } = {
    value: {
      installationId: "installation-42",
      installationAccountLogin: "Arthur",
      repositoryId: null,
      repositoryFullName: null,
    },
  };
  const repositories: GithubRepository[] = [
    { id: 123, full_name: "Arthur/rev-note", private: true, default_branch: "main" },
    { id: 456, full_name: "someone/fork", private: false, default_branch: "main" },
    { id: "789", full_name: "ARTHUR/archive", private: false, default_branch: null },
  ];

  const dependencies: GithubAccountDependencies = {
    isGithubAppConfigured: () => configured,
    getGithubAppSlug: () => "revnote-app",
    createOpaqueState: () => "opaque-state",
    hashState: async (state) => `sha256:${state}`,
    now: () => fixedNow,
    deleteExpiredInstallStates: async (expiresBefore) => {
      calls.push(`deleteExpired:${expiresBefore}`);
    },
    insertInstallState: async (stateHash, id, expiresAt) => {
      calls.push(`insertState:${stateHash}:${id}:${expiresAt}`);
    },
    getConnection: async (id) => {
      calls.push(`getConnection:${id}`);
      return connection.value;
    },
    createInstallationToken: async (installationId) => {
      calls.push(`createToken:${installationId}`);
      return "installation-token";
    },
    listInstallationRepositories: async (token) => {
      calls.push(`listRepositories:${token}`);
      return repositories;
    },
    updateSelectedRepository: async (id, repositoryId, repositoryFullName, updatedAt) => {
      calls.push(`updateRepository:${id}:${repositoryId}:${repositoryFullName}:${updatedAt}`);
      if (!connection.value) throw new Error("Connection disappeared during test");
      connection.value = { ...connection.value, repositoryId, repositoryFullName };
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

function assertEquals(actual: unknown, expected: unknown) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}
