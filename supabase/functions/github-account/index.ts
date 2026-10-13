import { createGithubAccountDependencies } from "./dependencies.ts";
import {
  GithubAccountError,
  handleGithubAccountAction,
  type GithubAccountActionInput,
} from "./logic.ts";
import { createAdminClient, FunctionError, jsonResponse, requireAuthenticatedUser } from "../_shared/supabase.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Use POST" }, 405, corsHeaders);

  try {
    const { user } = await requireAuthenticatedUser(request);
    const admin = createAdminClient();
    const body = await request.json().catch(() => ({})) as GithubAccountActionInput;
    const result = await handleGithubAccountAction(user.id, body, createGithubAccountDependencies(admin));
    return jsonResponse(result, 200, corsHeaders);
  } catch (error) {
    console.error("github-account failed", error);
    const status = error instanceof GithubAccountError || error instanceof FunctionError ? error.status : 500;
    const message = error instanceof Error ? error.message : "GitHub account operation failed";
    return jsonResponse({ error: message }, status, corsHeaders);
  }
});
