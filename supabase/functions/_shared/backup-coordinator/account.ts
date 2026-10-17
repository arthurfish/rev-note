import { Clock, Effect } from "effect";
import * as GitHub from "../github/index.ts";
import * as Supabase from "../supabase/index.ts";
import { GithubApiError } from "../github/errors.ts";
import { GithubAccountError } from "./errors.ts";
import type { ActionInput } from "./schema.ts";

export const handleAccountAction = Effect.fn(
  "BackupCoordinator.handleAccountAction",
)(function* (userId: string, input: ActionInput) {
  const github = yield* GitHub.Service;
  const supabase = yield* Supabase.Service;

  if (input.action === "status") {
    return {
      configured: yield* github.isTokenEncryptionConfigured(),
      connection: yield* supabase.connections.getInfo(userId),
    };
  }

  if (input.action === "disconnect") {
    yield* supabase.connections.delete(userId);
    yield* supabase.backup.deleteState(userId);
    return { ok: true as const };
  }

  if (input.action !== "connect") {
    return yield* new GithubAccountError({
      message: "Unsupported action",
      status: 400,
    });
  }
  if (!(yield* github.isTokenEncryptionConfigured())) {
    return yield* new GithubAccountError({
      message: "服务端尚未配置 GITHUB_TOKEN_ENCRYPTION_KEY",
      status: 503,
    });
  }

  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (
    !token.startsWith("github_pat_") || token.length < 20 ||
    token.length > 512
  ) {
    return yield* new GithubAccountError({
      message:
        "请输入 fine-grained personal access token（前缀应为 github_pat_）",
      status: 400,
    });
  }

  const repositoryFullName = normalizeRepositoryName(input.repositoryFullName);
  if (!repositoryFullName) {
    return yield* new GithubAccountError({
      message: "仓库名称请使用 owner/repository 格式",
      status: 400,
    });
  }

  const repository = yield* github.getRepository(token, repositoryFullName)
    .pipe(
      Effect.catchTag("GithubApiError", mapGithubApiError),
    );
  const canonicalRepositoryName = normalizeRepositoryName(
    repository.full_name,
  );
  if (!canonicalRepositoryName) {
    return yield* new GithubAccountError({
      message: "GitHub returned an invalid repository name",
      status: 502,
    });
  }

  const encryptedToken = yield* github.encryptToken(
    token,
    userId,
    canonicalRepositoryName,
  );
  const currentConnection = yield* supabase.connections.getInfo(userId);
  if (
    currentConnection &&
    currentConnection.repositoryFullName.toLowerCase() !==
      canonicalRepositoryName.toLowerCase()
  ) {
    yield* supabase.backup.deleteState(userId);
  }

  const now = new Date(yield* Clock.currentTimeMillis);
  yield* supabase.connections.save(
    userId,
    encryptedToken,
    canonicalRepositoryName,
    now.toISOString(),
  );
  return { connection: { repositoryFullName: canonicalRepositoryName } };
});

function normalizeRepositoryName(value: unknown) {
  if (typeof value !== "string") return null;
  const repository = GitHub.parseRepositoryName(value);
  return repository ? `${repository.owner}/${repository.repository}` : null;
}

function mapGithubApiError(
  error: GithubApiError,
): Effect.Effect<never, GithubApiError | GithubAccountError> {
  if (error.status === 401) {
    return Effect.fail(
      new GithubAccountError({
        message: "PAT 无效或已过期，请检查后重试",
        status: 401,
      }),
    );
  }
  if (error.status === 403 || error.status === 404) {
    return Effect.fail(
      new GithubAccountError({
        message:
          "PAT 无法访问该仓库；请确认 token 只授权了此仓库，并具有 Contents: Read and write 权限",
        status: 403,
      }),
    );
  }
  return Effect.fail(error);
}
