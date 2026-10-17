import { Cause, Effect, Exit, Result } from "effect";
// deno-lint-ignore no-import-prefix
import { corsHeaders as supabaseCorsHeaders } from "npm:@supabase/supabase-js@2.117.2/cors";

export const corsHeaders = supabaseCorsHeaders;

export function jsonResponse(
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  });
}

export async function runHttpEffect<A, E>(
  program: Effect.Effect<A, E>,
  functionName: string,
  headers: HeadersInit = corsHeaders,
  signal?: AbortSignal,
) {
  const exit = await Effect.runPromiseExit(program, { signal });
  if (Exit.isSuccess(exit)) return jsonResponse(exit.value, 200, headers);

  if (Cause.hasInterruptsOnly(exit.cause)) {
    return new Response(null, { status: 499, headers });
  }

  const failure = Cause.findError(exit.cause);
  const mapped = Result.isSuccess(failure)
    ? toHttpError(failure.success)
    : { status: 500, message: "Internal server error" };

  if (mapped.status >= 500 || Cause.hasDies(exit.cause)) {
    await Effect.runPromise(Effect.logError("Edge Function request failed", {
      functionName,
      errorTag: Result.isSuccess(failure)
        ? errorTag(failure.success)
        : "UnknownError",
      status: mapped.status,
    }));
  }

  return jsonResponse({ error: mapped.message }, mapped.status, headers);
}

export function toHttpError(
  error: unknown,
): { status: number; message: string } {
  const tag = property(error, "_tag");
  if (
    tag === "FunctionError" || tag === "GithubAccountError" ||
    tag === "GithubBackupError"
  ) {
    const status = property(error, "status");
    const message = property(error, "message");
    if (!isHttpErrorStatus(status) || typeof message !== "string") {
      return internalServerError;
    }
    return { status, message };
  }

  if (tag === "GithubApiError") {
    const status = property(error, "status");
    if (status === 401) {
      return { status: 401, message: "GitHub PAT 无效或已过期，请重新连接" };
    }
    if (status === 403) {
      return { status: 403, message: "GitHub PAT 无法访问所请求的资源" };
    }
    if (status === 404) {
      return { status: 404, message: "找不到 GitHub 仓库或分支" };
    }
    return { status: 502, message: "GitHub API request failed" };
  }

  if (tag === "SchemaError") {
    return { status: 502, message: "GitHub API request failed" };
  }

  return internalServerError;
}

const internalServerError: {
  readonly status: number;
  readonly message: string;
} = {
  status: 500,
  message: "Internal server error",
};

function isHttpErrorStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 &&
    value <= 599;
}

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

function errorTag(error: unknown) {
  const tag = property(error, "_tag");
  return typeof tag === "string" ? tag : "UnknownError";
}
