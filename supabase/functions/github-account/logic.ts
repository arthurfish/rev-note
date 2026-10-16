import { GithubApiError } from "../_shared/github.ts";

export interface GithubAccountConnection {
  repositoryFullName: string;
}

export interface GithubRepository {
  full_name: string;
  private: boolean;
  default_branch: string | null;
}

export interface GithubAccountActionInput {
  action?: string;
  token?: unknown;
  repositoryFullName?: unknown;
}

export interface GithubAccountDependencies {
  isTokenEncryptionConfigured(): boolean;
  now(): Date;
  getConnection(userId: string): Promise<GithubAccountConnection | null>;
  getGithubRepository(token: string, repositoryFullName: string): Promise<GithubRepository>;
  encryptToken(token: string, userId: string, repositoryFullName: string): Promise<string>;
  saveConnection(userId: string, encryptedToken: string, repositoryFullName: string, updatedAt: string): Promise<void>;
  deleteConnection(userId: string): Promise<void>;
  deleteBackupState(userId: string): Promise<void>;
}

export interface GithubAccountClientConnection {
  repositoryFullName: string;
}

export class GithubAccountError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export async function handleGithubAccountAction(
  userId: string,
  input: GithubAccountActionInput,
  dependencies: GithubAccountDependencies,
) {
  if (input.action === "status") {
    return {
      configured: dependencies.isTokenEncryptionConfigured(),
      connection: toClientConnection(await dependencies.getConnection(userId)),
    };
  }

  if (input.action === "disconnect") {
    await dependencies.deleteConnection(userId);
    await dependencies.deleteBackupState(userId);
    return { ok: true };
  }

  if (input.action !== "connect") throw new GithubAccountError("Unsupported action");
  if (!dependencies.isTokenEncryptionConfigured()) {
    throw new GithubAccountError("服务端尚未配置 GITHUB_TOKEN_ENCRYPTION_KEY", 503);
  }

  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!token.startsWith("github_pat_") || token.length < 20 || token.length > 512) {
    throw new GithubAccountError("请输入 fine-grained personal access token（前缀应为 github_pat_）");
  }

  const repositoryFullName = normalizeRepositoryName(input.repositoryFullName);
  let repository: GithubRepository;
  try {
    repository = await dependencies.getGithubRepository(token, repositoryFullName);
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 401) {
      throw new GithubAccountError("PAT 无效或已过期，请检查后重试", 401);
    }
    if (error instanceof GithubApiError && (error.status === 403 || error.status === 404)) {
      throw new GithubAccountError("PAT 无法访问该仓库；请确认 token 只授权了此仓库，并具有 Contents: Read and write 权限", 403);
    }
    throw error;
  }

  const canonicalRepositoryName = normalizeRepositoryName(repository.full_name);
  const encryptedToken = await dependencies.encryptToken(token, userId, canonicalRepositoryName);
  const currentConnection = await dependencies.getConnection(userId);
  if (currentConnection && currentConnection.repositoryFullName.toLowerCase() !== canonicalRepositoryName.toLowerCase()) {
    await dependencies.deleteBackupState(userId);
  }

  await dependencies.saveConnection(
    userId,
    encryptedToken,
    canonicalRepositoryName,
    dependencies.now().toISOString(),
  );
  return { connection: { repositoryFullName: canonicalRepositoryName } };
}

function normalizeRepositoryName(value: unknown) {
  const fullName = typeof value === "string" ? value.trim() : "";
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")) {
    throw new GithubAccountError("仓库名称请使用 owner/repository 格式");
  }
  return `${parts[0]}/${parts[1]}`;
}

function toClientConnection(connection: GithubAccountConnection | null): GithubAccountClientConnection | null {
  if (!connection) return null;
  return { repositoryFullName: connection.repositoryFullName };
}
