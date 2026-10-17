import { Clock, Effect } from "effect";
import * as GitHub from "../github/index.ts";
import * as Supabase from "../supabase/index.ts";
import { GithubApiError } from "../github/errors.ts";
import { GithubBackupError } from "./errors.ts";
import { buildFiles } from "./files.ts";

export interface Result {
  readonly ok: true;
  readonly repository: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly noteCount: number;
}

const backupProgram = Effect.fn("BackupCoordinator.runBackup")(
  function* (userId: string) {
    const github = yield* GitHub.Service;
    const supabase = yield* Supabase.Service;

    const connection = yield* supabase.connections.getEncrypted(userId);
    if (!connection?.tokenCiphertext || !connection.repositoryFullName) {
      return yield* new GithubBackupError({
        message: "请先连接 GitHub PAT 并设置备份仓库",
        status: 409,
      });
    }

    const token = yield* github.decryptToken(
      connection.tokenCiphertext,
      userId,
      connection.repositoryFullName,
    );
    const repository = yield* github.getRepository(
      token,
      connection.repositoryFullName,
    );
    const parsedRepository = GitHub.parseRepositoryName(repository.full_name);
    if (!parsedRepository) {
      return yield* new GithubBackupError({
        message: "GitHub returned an invalid repository name",
        status: 502,
      });
    }
    const canonicalRepositoryName =
      `${parsedRepository.owner}/${parsedRepository.repository}`;

    const backup = buildFiles(yield* supabase.backup.readData(userId));
    const committedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const published = yield* github.publishBackup({
      token,
      repositoryFullName: canonicalRepositoryName,
      defaultBranch: repository.default_branch || "main",
      files: backup.files,
      initialFile: backup.readme,
      userId,
      committedAt,
    });

    const lastBackupAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* supabase.backup.saveState(
      userId,
      repository.full_name,
      published.branch,
      published.commitSha,
      lastBackupAt,
      backup.noteCount,
    );

    if (connection.repositoryFullName !== canonicalRepositoryName) {
      const encryptedToken = yield* github.encryptToken(
        token,
        userId,
        canonicalRepositoryName,
      );
      yield* supabase.connections.save(
        userId,
        encryptedToken,
        canonicalRepositoryName,
        lastBackupAt,
      );
    }

    return {
      ok: true as const,
      repository: repository.full_name,
      branch: published.branch,
      commitSha: published.commitSha,
      noteCount: backup.noteCount,
    } satisfies Result;
  },
);

export function runBackup(userId: string) {
  return backupProgram(userId).pipe(
    Effect.catchTag("GithubApiError", mapGithubBackupApiError),
  );
}

function mapGithubBackupApiError(
  error: GithubApiError,
): Effect.Effect<never, GithubApiError | GithubBackupError> {
  if (error.status === 401) {
    return Effect.fail(
      new GithubBackupError({
        message: "GitHub PAT 无效或已过期，请重新连接",
        status: 401,
      }),
    );
  }
  if (error.status === 403) {
    return Effect.fail(
      new GithubBackupError({
        message:
          "GitHub PAT 无权写入该仓库；请确认 Contents: Read and write 权限及组织审批状态",
        status: 403,
      }),
    );
  }
  return Effect.fail(error);
}
