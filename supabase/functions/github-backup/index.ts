import { createAdminClient, FunctionError, jsonResponse, requireAuthenticatedUser } from "../_shared/supabase.ts";
import { GithubApiError } from "../_shared/github.ts";
import { GithubBackupError, runGithubBackup } from "./logic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Use POST" }, 405, corsHeaders);

  try {
    const { supabase, user } = await requireAuthenticatedUser(request);
    const result = await runGithubBackup(user.id, supabase, createAdminClient());
    return jsonResponse(result, 200, corsHeaders);
  } catch (error) {
    console.error("github-backup failed", error);
    const status = error instanceof GithubBackupError || error instanceof FunctionError
      ? error.status
      : error instanceof GithubApiError && [401, 403, 404].includes(error.status)
      ? error.status
      : 500;
    const message = error instanceof GithubApiError && error.status === 401
      ? "GitHub PAT 无效或已过期，请重新连接"
      : error instanceof GithubApiError && error.status === 403
      ? "GitHub PAT 无权写入该仓库；请确认 Contents: Read and write 权限及组织审批状态"
      : error instanceof Error ? error.message : "Backup failed";
    return jsonResponse({ error: message }, status, corsHeaders);
  }
});
