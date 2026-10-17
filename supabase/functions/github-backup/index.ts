import { Effect } from "effect";
import * as Coordinator from "../_shared/backup-coordinator/index.ts";
import * as Supabase from "../_shared/supabase/index.ts";
import { corsHeaders, jsonResponse, runHttpEffect } from "../_shared/http.ts";

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
    return yield* Coordinator.Backup.runBackup(user.id).pipe(
      Effect.provide(Coordinator.layer(supabase, admin)),
    );
  });

  return runHttpEffect(program, "github-backup", corsHeaders, request.signal);
}

Deno.serve(handleRequest);
