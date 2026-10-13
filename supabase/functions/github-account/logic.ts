export interface GithubAccountConnection {
  installationId: string;
  installationAccountLogin: string;
  repositoryId: string | null;
  repositoryFullName: string | null;
}

export interface GithubRepository {
  id: number | string;
  full_name: string;
  private: boolean;
  default_branch: string | null;
}

export interface GithubAccountActionInput {
  action?: string;
  repositoryId?: unknown;
}

export interface GithubAccountClientConnection {
  installationAccountLogin: string;
  repositoryId: string | null;
  repositoryFullName: string | null;
}

export interface GithubAccountDependencies {
  isGithubAppConfigured(): boolean;
  getGithubAppSlug(): string;
  createOpaqueState(): string;
  hashState(state: string): Promise<string>;
  now(): Date;
  deleteExpiredInstallStates(expiresBefore: string): Promise<void>;
  insertInstallState(stateHash: string, userId: string, expiresAt: string): Promise<void>;
  getConnection(userId: string): Promise<GithubAccountConnection | null>;
  createInstallationToken(installationId: string): Promise<string>;
  listInstallationRepositories(token: string): Promise<GithubRepository[]>;
  updateSelectedRepository(userId: string, repositoryId: string, repositoryFullName: string, updatedAt: string): Promise<void>;
  deleteConnection(userId: string): Promise<void>;
  deleteBackupState(userId: string): Promise<void>;
}

export class GithubAccountError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const installStateLifetimeMs = 10 * 60 * 1000;

export async function handleGithubAccountAction(
  userId: string,
  input: GithubAccountActionInput,
  dependencies: GithubAccountDependencies,
) {
  if (input.action === "status") {
    const connection = await dependencies.getConnection(userId);
    return {
      configured: dependencies.isGithubAppConfigured(),
      connection: toClientConnection(connection),
    };
  }

  if (!dependencies.isGithubAppConfigured()) {
    throw new GithubAccountError("GitHub App 尚未完成服务端配置", 503);
  }

  if (input.action === "start") {
    const state = dependencies.createOpaqueState();
    const now = dependencies.now();
    await dependencies.deleteExpiredInstallStates(now.toISOString());
    await dependencies.insertInstallState(
      await dependencies.hashState(state),
      userId,
      new Date(now.getTime() + installStateLifetimeMs).toISOString(),
    );

    const installUrl = new URL(`https://github.com/apps/${encodeURIComponent(dependencies.getGithubAppSlug())}/installations/new`);
    installUrl.searchParams.set("state", state);
    return { installUrl: installUrl.toString() };
  }

  const connection = await dependencies.getConnection(userId);
  if (!connection) throw new GithubAccountError("请先连接 GitHub App", 409);

  if (input.action === "repositories") {
    const token = await dependencies.createInstallationToken(connection.installationId);
    const repositories = await dependencies.listInstallationRepositories(token);
    return {
      repositories: repositories
        .filter((repository) => repository.full_name.split("/")[0]?.toLowerCase() === connection.installationAccountLogin.toLowerCase())
        .map(toClientRepository),
      selectedRepositoryId: connection.repositoryId,
    };
  }

  if (input.action === "select-repository") {
    const repositoryId = typeof input.repositoryId === "string" ? input.repositoryId : "";
    if (!/^\d+$/.test(repositoryId)) throw new GithubAccountError("请选择一个有效仓库");

    const token = await dependencies.createInstallationToken(connection.installationId);
    const repositories = await dependencies.listInstallationRepositories(token);
    const repository = repositories.find((item) => String(item.id) === repositoryId);
    if (!repository) {
      throw new GithubAccountError("该仓库不在 GitHub App 的授权范围内，请重新加载列表", 403);
    }

    const repositoryOwner = repository.full_name.split("/")[0];
    if (repositoryOwner?.toLowerCase() !== connection.installationAccountLogin.toLowerCase()) {
      throw new GithubAccountError("请选择安装 GitHub App 的个人账号所拥有的仓库", 403);
    }

    await dependencies.updateSelectedRepository(
      userId,
      repositoryId,
      repository.full_name,
      dependencies.now().toISOString(),
    );
    return { connection: toClientConnection(await dependencies.getConnection(userId)) };
  }

  if (input.action === "disconnect") {
    await dependencies.deleteConnection(userId);
    await dependencies.deleteBackupState(userId);
    return { ok: true };
  }

  throw new GithubAccountError("Unsupported action");
}

function toClientConnection(connection: GithubAccountConnection | null): GithubAccountClientConnection | null {
  if (!connection) return null;
  return {
    installationAccountLogin: connection.installationAccountLogin,
    repositoryId: connection.repositoryId,
    repositoryFullName: connection.repositoryFullName,
  };
}

function toClientRepository(repository: GithubRepository) {
  return {
    id: String(repository.id),
    fullName: repository.full_name,
    private: repository.private,
    defaultBranch: repository.default_branch,
  };
}
