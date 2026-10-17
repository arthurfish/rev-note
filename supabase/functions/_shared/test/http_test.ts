import { Effect } from "effect";
import { GithubApiError } from "../github/errors.ts";
import { FunctionError } from "../http-errors.ts";
import { corsHeaders, runHttpEffect, toHttpError } from "../http.ts";
import { SupabaseError } from "../supabase/errors.ts";

Deno.test("uses Supabase's current CORS header allow-list", () => {
  const allowedHeaders = corsHeaders["Access-Control-Allow-Headers"];

  for (
    const header of ["x-retry-count", "traceparent", "tracestate", "baggage"]
  ) {
    assert(allowedHeaders.includes(header));
  }
});

Deno.test("preserves public errors and hides infrastructure details", () => {
  assertEquals(
    toHttpError(
      new FunctionError({ message: "Invalid request body", status: 400 }),
    ),
    { status: 400, message: "Invalid request body" },
  );
  assertEquals(
    toHttpError(
      new SupabaseError({
        operation: "read notes",
        message: "private database detail",
      }),
    ),
    { status: 500, message: "Internal server error" },
  );
  assertEquals(
    toHttpError(new Error("secret configuration value")),
    { status: 500, message: "Internal server error" },
  );
  assertEquals(
    toHttpError(
      new GithubApiError({ message: "private upstream detail", status: 404 }),
    ),
    { status: 404, message: "找不到 GitHub 仓库或分支" },
  );
  assertEquals(
    toHttpError({
      _tag: "FunctionError",
      status: 200,
      message: "invalid status",
    }),
    { status: 500, message: "Internal server error" },
  );
});

Deno.test("maps Effect interruption to a client-disconnected response", async () => {
  const controller = new AbortController();
  const pendingResponse = runHttpEffect(
    Effect.never,
    "test",
    corsHeaders,
    controller.signal,
  );

  controller.abort();

  const response = await pendingResponse;
  assertEquals(response.status, 499);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("returns domain errors as JSON with CORS headers", async () => {
  const response = await runHttpEffect(
    Effect.fail(
      new GithubApiError({
        message: "untrusted upstream response",
        status: 502,
      }),
    ),
    "test",
  );

  assertEquals(response.status, 502);
  assertEquals(response.headers.get("Content-Type"), "application/json");
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(await response.json(), { error: "GitHub API request failed" });
});

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
