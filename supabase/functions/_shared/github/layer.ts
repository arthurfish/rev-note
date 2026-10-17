import {
  Clock,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import {
  decryptGithubToken,
  encryptGithubToken,
  isGithubTokenEncryptionKeyValid,
  loadGithubTokenEncryptionKey,
} from "./token.ts";
import { GithubApiError, TokenEncryptionError } from "./errors.ts";
import { type BackupFile, type Interface, Service } from "./service.ts";
import { ApiSchemas, parseRepositoryName, Repository } from "./schema.ts";

const apiOrigin = "https://api.github.com";
const transientStatuses = new Set([429, 500, 502, 503, 504]);
const maxRetryAfterMs = 5_000;
const readRetrySchedule = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 2 }),
  Schedule.setInputType<GithubApiError>(),
  Schedule.while(({ input }) =>
    input.retryAfterMs === undefined || input.retryAfterMs <= maxRetryAfterMs
  ),
  Schedule.passthrough,
  Schedule.modifyDelay(({ input, duration }) =>
    Effect.succeed(
      Duration.max(
        duration,
        Duration.millis(input.retryAfterMs ?? 0),
      ),
    )
  ),
);

export function layer(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  options: {
    readonly encryptionKey?: Option.Option<Redacted.Redacted<string>>;
  } = {},
) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const encryptionKey = options.encryptionKey === undefined
        ? yield* loadGithubTokenEncryptionKey()
        : options.encryptionKey;
      const encryptionKeyIsUsable = Option.isSome(encryptionKey)
        ? yield* isGithubTokenEncryptionKeyValid(
          Redacted.value(encryptionKey.value),
        )
        : false;

      const request = <S extends Schema.ConstraintDecoder<unknown>>(
        url: string,
        token: string,
        schema: S,
        options: {
          readonly method?: "GET" | "POST" | "PUT" | "PATCH";
          readonly body?: unknown;
        } = {},
      ): Effect.Effect<S["Type"], GithubApiError, S["DecodingServices"]> => {
        const method = options.method ?? "GET";
        const init: RequestInit = {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        };

        const fetchResponse = Effect.tryPromise({
          try: (signal) => fetchImpl(url, { ...init, signal }),
          catch: () =>
            new GithubApiError({
              message: "GitHub API request failed",
              status: 502,
            }),
        });

        const responseEffect = method === "GET"
          ? fetchResponse.pipe(
            Effect.flatMap((response) => {
              if (!transientStatuses.has(response.status)) {
                return Effect.succeed(response);
              }
              return Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) =>
                  Effect.fail(
                    new GithubApiError({
                      message: `GitHub API failed (${response.status})`,
                      status: response.status,
                      retryAfterMs: parseRetryAfter(
                        response.headers.get("retry-after"),
                        now,
                      ),
                    }),
                  )
                ),
              );
            }),
            Effect.retry(readRetrySchedule),
          )
          : fetchResponse;

        return Effect.gen(function* () {
          const response = yield* responseEffect;
          if (response.status < 200 || response.status >= 300) {
            const text = yield* Effect.tryPromise({
              try: () => response.text(),
              catch: () =>
                new GithubApiError({
                  message: `GitHub API failed (${response.status})`,
                  status: response.status,
                }),
            });
            const message = parseGithubErrorMessage(text) ??
              `GitHub API failed (${response.status})`;
            return yield* new GithubApiError({
              message,
              status: response.status,
            });
          }

          const body = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: () =>
              new GithubApiError({
                message: "GitHub returned an invalid response",
                status: 502,
              }),
          });
          return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
            Effect.mapError(() =>
              new GithubApiError({
                message: "GitHub returned an invalid response",
                status: 502,
              })
            ),
          );
        });
      };

      const getRepository: Interface["getRepository"] = Effect.fn(
        "GitHub.getRepository",
      )(function* (token, repositoryFullName) {
        const parsed = parseRepositoryName(repositoryFullName);
        if (!parsed) {
          return yield* new GithubApiError({
            message: "Repository must use the owner/repository format",
            status: 400,
          });
        }
        return yield* request(
          repositoryUrl(parsed),
          token,
          Repository,
        );
      });

      const publishBackup: Interface["publishBackup"] = Effect.fn(
        "GitHub.publishBackup",
      )(function* (input) {
        const parsed = parseRepositoryName(input.repositoryFullName);
        if (!parsed) {
          return yield* new GithubApiError({
            message: "Repository must use the owner/repository format",
            status: 400,
          });
        }

        const base = repositoryUrl(parsed);
        const resolved = yield* resolveBranch(
          request,
          input.token,
          base,
          input.defaultBranch || "main",
          input.initialFile,
        );
        const tree = yield* request(
          `${base}/git/trees`,
          input.token,
          ApiSchemas.sha,
          {
            method: "POST",
            body: {
              base_tree: resolved.parent.treeSha,
              tree: input.files.map((file) => ({
                path: file.path,
                mode: "100644",
                type: "blob",
                content: file.content,
              })),
            },
          },
        );

        if (tree.sha === resolved.parent.treeSha) {
          return {
            branch: resolved.branch,
            commitSha: resolved.parent.commitSha,
          };
        }

        const commit = yield* request(
          `${base}/git/commits`,
          input.token,
          ApiSchemas.sha,
          {
            method: "POST",
            body: {
              message: `RevNote backup · ${input.committedAt}`,
              tree: tree.sha,
              parents: [resolved.parent.commitSha],
              author: {
                name: "RevNote Backup",
                email: `${input.userId}@users.noreply.github.com`,
              },
            },
          },
        );

        yield* request(
          `${base}/git/refs/heads/${encodeURIComponent(resolved.branch)}`,
          input.token,
          ApiSchemas.reference,
          {
            method: "PATCH",
            body: { sha: commit.sha, force: false },
          },
        );
        return { branch: resolved.branch, commitSha: commit.sha };
      });

      const encryptToken: Interface["encryptToken"] = Effect.fn(
        "GitHub.encryptToken",
      )(function* (token, userId, repositoryFullName) {
        if (Option.isNone(encryptionKey)) {
          return yield* new TokenEncryptionError({
            message: "GITHUB_TOKEN_ENCRYPTION_KEY is not configured",
          });
        }
        return yield* encryptGithubToken(
          token,
          Redacted.value(encryptionKey.value),
          userId,
          repositoryFullName,
        );
      });

      const decryptToken: Interface["decryptToken"] = Effect.fn(
        "GitHub.decryptToken",
      )(function* (encryptedToken, userId, repositoryFullName) {
        if (Option.isNone(encryptionKey)) {
          return yield* new TokenEncryptionError({
            message: "Missing server secret: GITHUB_TOKEN_ENCRYPTION_KEY",
          });
        }
        return yield* decryptGithubToken(
          encryptedToken,
          Redacted.value(encryptionKey.value),
          userId,
          repositoryFullName,
        );
      });

      return Service.of(
        {
          isTokenEncryptionConfigured: Effect.fn(
            "GitHub.isTokenEncryptionConfigured",
          )(() => Effect.succeed(encryptionKeyIsUsable)),
          encryptToken,
          decryptToken,
          getRepository,
          publishBackup,
        } satisfies Interface,
      );
    }),
  );
}

function repositoryUrl(repository: { owner: string; repository: string }) {
  return `${apiOrigin}/repos/${encodeURIComponent(repository.owner)}/${
    encodeURIComponent(repository.repository)
  }`;
}

function resolveBranch(
  request: <S extends Schema.ConstraintDecoder<unknown>>(
    url: string,
    token: string,
    schema: S,
    options?: {
      readonly method?: "GET" | "POST" | "PUT" | "PATCH";
      readonly body?: unknown;
    },
  ) => Effect.Effect<S["Type"], GithubApiError, S["DecodingServices"]>,
  token: string,
  base: string,
  initialBranch: string,
  initialFile: BackupFile,
) {
  return Effect.gen(function* () {
    let branch = initialBranch;
    let parent = yield* getBranch(request, token, base, branch);
    if (!parent) {
      yield* initializeEmptyRepository(request, token, base, initialFile);
      const repository = yield* request(
        base,
        token,
        ApiSchemas.defaultBranch,
      );
      branch = repository.default_branch ?? initialBranch;
      parent = yield* getBranch(request, token, base, branch);
      if (!parent) {
        return yield* new GithubApiError({
          message: "GitHub repository remained empty after initialization",
          status: 502,
        });
      }
    }
    return { branch, parent };
  });
}

function getBranch(
  request: <S extends Schema.ConstraintDecoder<unknown>>(
    url: string,
    token: string,
    schema: S,
    options?: {
      readonly method?: "GET" | "POST" | "PUT" | "PATCH";
      readonly body?: unknown;
    },
  ) => Effect.Effect<S["Type"], GithubApiError, S["DecodingServices"]>,
  token: string,
  base: string,
  branchName: string,
) {
  return Effect.gen(function* () {
    const ref = yield* request(
      `${base}/git/ref/heads/${encodeURIComponent(branchName)}`,
      token,
      ApiSchemas.reference,
    ).pipe(
      Effect.catchTag(
        "GithubApiError",
        (error) =>
          isMissingRefError(error) ? Effect.succeed(null) : Effect.fail(error),
      ),
    );
    if (!ref) return null;
    const commit = yield* request(
      `${base}/git/commits/${ref.object.sha}`,
      token,
      ApiSchemas.commit,
    );
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
  });
}

function initializeEmptyRepository(
  request: <S extends Schema.ConstraintDecoder<unknown>>(
    url: string,
    token: string,
    schema: S,
    options?: {
      readonly method?: "GET" | "POST" | "PUT" | "PATCH";
      readonly body?: unknown;
    },
  ) => Effect.Effect<S["Type"], GithubApiError, S["DecodingServices"]>,
  token: string,
  base: string,
  file: BackupFile,
) {
  const path = file.path.split("/").map(encodeURIComponent).join("/");
  return Effect.asVoid(request(
    `${base}/contents/${path}`,
    token,
    ApiSchemas.contents,
    {
      method: "PUT",
      body: {
        message: "Initialize RevNote backup",
        content: encodeBase64(file.content),
      },
    },
  ));
}

function isMissingRefError(error: GithubApiError) {
  return error.status === 404 ||
    (error.status === 409 && /repository is empty/i.test(error.message));
}

function parseGithubErrorMessage(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const message = Reflect.get(parsed, "message");
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

function parseRetryAfter(value: string | null, now: number) {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - now);
}

function encodeBase64(value: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
