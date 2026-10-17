import { Effect, Fiber, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";
import * as GitHub from "../index.ts";
import { GithubApiError } from "../errors.ts";

const url = "https://api.github.com/repos/Arthur/rev-note";
const token = "github_pat_test-token";
const repository: GitHub.Repository = {
  id: 1,
  name: "rev-note",
  full_name: "Arthur/rev-note",
  private: true,
  default_branch: "main",
};

Deno.test("parses only owner/repository pairs", () => {
  assertEquals(GitHub.parseRepositoryName("Arthur/rev-note"), {
    owner: "Arthur",
    repository: "rev-note",
  });
  for (
    const value of [
      "https://github.com/arthur/rev-note",
      "arthur/rev-note/extra",
      "arthur /rev-note",
      "./rev-note",
      "arthur/..",
    ]
  ) {
    assertEquals(GitHub.parseRepositoryName(value), null);
  }
});

Deno.test("reports token encryption configured only for a usable key", async () => {
  assertEquals(await encryptionConfigured(Option.none()), false);
  assertEquals(
    await encryptionConfigured(Option.some(Redacted.make("not-base64"))),
    false,
  );
  assertEquals(
    await encryptionConfigured(
      Option.some(Redacted.make(encodeBase64(new Uint8Array(32).fill(7)))),
    ),
    true,
  );
});

Deno.test("retries transient reads and schema-decodes the response", async () => {
  const calls: RequestInit[] = [];
  const fakeFetch: typeof fetch = (_input, init) => {
    calls.push(init ?? {});
    return Promise.resolve(
      calls.length === 1
        ? new Response(JSON.stringify({ message: "Service unavailable" }), {
          status: 503,
        })
        : Response.json(repository),
    );
  };

  const result = await runWithFetch(
    fakeFetch,
    (github) => github.getRepository(token, "Arthur/rev-note"),
  );

  assertEquals(result, repository);
  assertEquals(calls.length, 2);
  assertEquals(
    new Headers(calls[0].headers).get("authorization"),
    `Bearer ${token}`,
  );
  assertEquals(
    new Headers(calls[1].headers).get("x-github-api-version"),
    "2022-11-28",
  );
});

Deno.test("honors Retry-After before retrying a rate-limited read", async () => {
  let calls = 0;
  let resolveFirstResponse!: (response: Response) => void;
  let resolveFirstRequestStarted!: () => void;
  const firstResponse = new Promise<Response>((resolve) => {
    resolveFirstResponse = resolve;
  });
  const firstRequestStarted = new Promise<void>((resolve) => {
    resolveFirstRequestStarted = resolve;
  });
  const fakeFetch: typeof fetch = () => {
    calls += 1;
    if (calls === 1) {
      resolveFirstRequestStarted();
      return firstResponse;
    }
    return Promise.resolve(Response.json(repository));
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        githubEffect(
          fakeFetch,
          (github) => github.getRepository(token, "Arthur/rev-note"),
        ),
      );
      yield* Effect.promise(() => firstRequestStarted);
      resolveFirstResponse(
        Response.json({ message: "Secondary rate limit" }, {
          status: 429,
          headers: { "Retry-After": "1" },
        }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("999 millis");
      assertEquals(calls, 1);
      yield* TestClock.adjust("1 millis");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  assertEquals(result, repository);
  assertEquals(calls, 2);
});

Deno.test("does not wait beyond the bounded Retry-After budget", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = () => {
    calls += 1;
    return Promise.resolve(
      Response.json({ message: "Rate limited" }, {
        status: 429,
        headers: { "Retry-After": "60" },
      }),
    );
  };

  const error = await Effect.runPromise(Effect.flip(
    githubEffect(
      fakeFetch,
      (github) => github.getRepository(token, "Arthur/rev-note"),
    ),
  ));

  if (!(error instanceof GithubApiError)) throw error;
  assertEquals(error.status, 429);
  assertEquals(calls, 1);
});

Deno.test("does not retry GitHub writes", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method}:${url}`);
    if (url.endsWith("/git/ref/heads/main")) {
      return Promise.resolve(Response.json({ object: { sha: "parent" } }));
    }
    if (url.endsWith("/git/commits/parent")) {
      return Promise.resolve(Response.json({ tree: { sha: "parent-tree" } }));
    }
    if (url.endsWith("/git/trees")) {
      return Promise.resolve(
        Response.json({ message: "Service unavailable" }, { status: 503 }),
      );
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const error = await Effect.runPromise(Effect.flip(
    githubEffect(fakeFetch, (github) =>
      github.publishBackup({
        token,
        repositoryFullName: "Arthur/rev-note",
        defaultBranch: "main",
        files: [{ path: "notes/note.md", content: "note" }],
        initialFile: { path: "README.md", content: "readme" },
        userId: "u",
        committedAt: "2026-10-16T12:00:00.000Z",
      })),
  ));

  if (!(error instanceof GithubApiError)) throw error;
  assertEquals(error.status, 503);
  assertEquals(calls.length, 3);
});

Deno.test("does not create a commit when the tree is unchanged", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const requestUrl = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method}:${requestUrl}`);
    if (requestUrl.endsWith("/git/ref/heads/main")) {
      return Promise.resolve(Response.json({ object: { sha: "parent" } }));
    }
    if (requestUrl.endsWith("/git/commits/parent")) {
      return Promise.resolve(Response.json({ tree: { sha: "parent-tree" } }));
    }
    if (requestUrl.endsWith("/git/trees")) {
      return Promise.resolve(Response.json({ sha: "parent-tree" }));
    }
    throw new Error(`Unexpected request: ${method} ${requestUrl}`);
  };

  const result = await runWithFetch(
    fakeFetch,
    (github) =>
      github.publishBackup({
        token,
        repositoryFullName: "Arthur/rev-note",
        defaultBranch: "main",
        files: [{ path: "README.md", content: "readme" }],
        initialFile: { path: "README.md", content: "readme" },
        userId: "u",
        committedAt: "2026-10-16T12:00:00.000Z",
      }),
  );

  assertEquals(result, { branch: "main", commitSha: "parent" });
  assertEquals(calls.length, 3);
  assert(
    !calls.some((call) =>
      call.includes(
        "POST:https://api.github.com/repos/Arthur/rev-note/git/commits",
      )
    ),
  );
  assert(!calls.some((call) => call.includes("/git/refs/heads/main")));
});

Deno.test("initializes empty repositories on their configured default branch", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const requestUrl = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method}:${requestUrl}`);
    if (requestUrl.endsWith("/git/ref/heads/main")) {
      return Promise.resolve(Response.json({ message: "Reference not found" }, {
        status: 404,
      }));
    }
    if (requestUrl.includes("/contents/README.md")) {
      return Promise.resolve(Response.json({
        content: { sha: "readme-blob" },
        commit: { sha: "bootstrap-commit" },
      }));
    }
    if (requestUrl === url && method === "GET") {
      return Promise.resolve(Response.json({ default_branch: "trunk" }));
    }
    if (requestUrl.endsWith("/git/ref/heads/trunk")) {
      return Promise.resolve(Response.json({ object: { sha: "parent" } }));
    }
    if (requestUrl.endsWith("/git/commits/parent")) {
      return Promise.resolve(Response.json({ tree: { sha: "parent-tree" } }));
    }
    if (requestUrl.endsWith("/git/trees")) {
      return Promise.resolve(Response.json({ sha: "parent-tree" }));
    }
    throw new Error(`Unexpected request: ${method} ${requestUrl}`);
  };

  const result = await runWithFetch(
    fakeFetch,
    (github) =>
      github.publishBackup({
        token,
        repositoryFullName: "Arthur/rev-note",
        defaultBranch: "main",
        files: [{ path: "README.md", content: "readme" }],
        initialFile: { path: "README.md", content: "readme" },
        userId: "u",
        committedAt: "2026-10-16T12:00:00.000Z",
      }),
  );

  assertEquals(result, { branch: "trunk", commitSha: "parent" });
  assert(calls.some((call) => call.includes("/git/ref/heads/trunk")));
  assert(
    !calls.some((call) =>
      call.endsWith(
        "POST:https://api.github.com/repos/Arthur/rev-note/git/commits",
      )
    ),
  );
});

Deno.test("recognizes GitHub's empty-repository conflict response", async () => {
  const calls: string[] = [];
  let refReads = 0;
  const fakeFetch: typeof fetch = (input, init) => {
    const requestUrl = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method}:${requestUrl}`);
    if (requestUrl.endsWith("/git/ref/heads/main")) {
      refReads += 1;
      if (refReads > 1) {
        return Promise.resolve(Response.json({ object: { sha: "parent" } }));
      }
      return Promise.resolve(
        Response.json({ message: "Git Repository is empty." }, { status: 409 }),
      );
    }
    if (requestUrl.includes("/contents/README.md")) {
      return Promise.resolve(Response.json({
        content: { sha: "readme-blob" },
        commit: { sha: "bootstrap-commit" },
      }));
    }
    if (requestUrl === url && method === "GET") {
      return Promise.resolve(Response.json({ default_branch: "main" }));
    }
    if (requestUrl.endsWith("/git/commits/parent")) {
      return Promise.resolve(Response.json({ tree: { sha: "parent-tree" } }));
    }
    if (requestUrl.endsWith("/git/trees")) {
      return Promise.resolve(Response.json({ sha: "parent-tree" }));
    }
    throw new Error(`Unexpected request: ${method} ${requestUrl}`);
  };

  const result = await runWithFetch(
    fakeFetch,
    (github) =>
      github.publishBackup({
        token,
        repositoryFullName: "Arthur/rev-note",
        defaultBranch: "main",
        files: [{ path: "README.md", content: "readme" }],
        initialFile: { path: "README.md", content: "readme" },
        userId: "u",
        committedAt: "2026-10-16T12:00:00.000Z",
      }),
  );

  assertEquals(result, { branch: "main", commitSha: "parent" });
  assertEquals(
    calls.filter((call) => call.endsWith("/git/ref/heads/main")).length,
    2,
  );
});

Deno.test("does not treat unrelated GitHub reference conflicts as empty repositories", async () => {
  const fakeFetch: typeof fetch = () =>
    Promise.resolve(
      Response.json({ message: "Reference update failed" }, { status: 409 }),
    );

  const error = await Effect.runPromise(Effect.flip(
    githubEffect(fakeFetch, (github) =>
      github.publishBackup({
        token,
        repositoryFullName: "Arthur/rev-note",
        defaultBranch: "main",
        files: [],
        initialFile: { path: "README.md", content: "readme" },
        userId: "u",
        committedAt: "2026-10-16T12:00:00.000Z",
      })),
  ));
  if (!(error instanceof GithubApiError)) throw error;
  assertEquals(error.status, 409);
});

Deno.test("uses a generic error message for an unstructured GitHub response", async () => {
  const fakeFetch: typeof fetch = () =>
    Promise.resolve(new Response("upstream unavailable", { status: 502 }));

  const error = await Effect.runPromise(Effect.flip(
    githubEffect(
      fakeFetch,
      (github) => github.getRepository(token, "Arthur/rev-note"),
    ),
  ));

  if (!(error instanceof GithubApiError)) throw error;
  assertEquals(error.message, "GitHub API failed (502)");
});

Deno.test("stops retrying a transient read after two retries", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = () => {
    calls += 1;
    return Promise.resolve(
      Response.json({ message: "Service unavailable" }, { status: 503 }),
    );
  };

  const error = await Effect.runPromise(Effect.flip(
    githubEffect(
      fakeFetch,
      (github) => github.getRepository(token, "Arthur/rev-note"),
    ),
  ));
  if (!(error instanceof GithubApiError)) throw error;
  assertEquals(error.status, 503);
  assertEquals(calls, 3);
});

Deno.test("rejects malformed repository names before issuing a request", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = () => {
    calls += 1;
    return Promise.resolve(Response.json(repository));
  };

  const error = await Effect.runPromise(Effect.flip(
    githubEffect(
      fakeFetch,
      (github) =>
        github.getRepository(token, "https://github.com/Arthur/rev-note"),
    ),
  ));
  if (!(error instanceof GithubApiError)) throw error;
  assertEquals(error.status, 400);
  assertEquals(calls, 0);
});

function runWithFetch<A, E>(
  fetchImpl: typeof globalThis.fetch,
  use: (github: GitHub.Interface) => Effect.Effect<A, E>,
) {
  return Effect.runPromise(githubEffect(fetchImpl, use));
}

function encryptionConfigured(
  encryptionKey: Option.Option<Redacted.Redacted<string>>,
) {
  const unusedFetch: typeof fetch = () => {
    throw new Error("The encryption status check must not call GitHub");
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* GitHub.Service;
      return yield* github.isTokenEncryptionConfigured();
    }).pipe(
      Effect.provide(GitHub.layer(unusedFetch, { encryptionKey })),
    ),
  );
}

function githubEffect<A, E>(
  fetchImpl: typeof globalThis.fetch,
  use: (github: GitHub.Interface) => Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    const github = yield* GitHub.Service;
    return yield* use(github);
  }).pipe(
    Effect.provide(
      GitHub.layer(fetchImpl, { encryptionKey: Option.none() }),
    ),
  );
}

function assert(condition: boolean): asserts condition {
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

function encodeBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
