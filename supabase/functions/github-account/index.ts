import { Effect, Schema } from "effect";
import * as Coordinator from "../_shared/backup-coordinator/index.ts";
import * as Supabase from "../_shared/supabase/index.ts";
import { corsHeaders, jsonResponse, runHttpEffect } from "../_shared/http.ts";
import { FunctionError } from "../_shared/http-errors.ts";

export function handleRequest(request: Request) {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Use POST" }, 405, corsHeaders);
  }

  const program = Effect.gen(function* () {
    const { supabase, user } = yield* Supabase.requireAuthenticatedUser(
      request,
    );
    const admin = yield* Supabase.createAdminClient();
    const rawBody = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () =>
        new FunctionError({
          message: "Request body must be valid JSON",
          status: 400,
        }),
    });
    const input = yield* Schema.decodeUnknownEffect(
      Coordinator.ActionInput,
    )(rawBody).pipe(
      Effect.mapError(() =>
        new FunctionError({ message: "Invalid request body", status: 400 })
      ),
    );
    return yield* Coordinator.Account.handleAccountAction(user.id, input).pipe(
      Effect.provide(Coordinator.layer(supabase, admin)),
    );
  });

  return runHttpEffect(program, "github-account", corsHeaders, request.signal);
}

Deno.serve(handleRequest);
