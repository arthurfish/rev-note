import { createInstallationToken, listInstallationRepositories } from "../_shared/github.ts";
import type { GithubRepository } from "../_shared/github.ts";
import { createOpaqueState, hashState } from "../_shared/github-state.ts";
import { createAdminClient, FunctionError, jsonResponse, requireAuthenticatedUser, requiredEnv } from "../_shared/supabase.ts";

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
    const body = await request.json().catch(() => ({})) as { action?: string; repositoryId?: string };

    if (body.action === "status") {
      const configured = githubAppIsConfigured();
      const connection = await getConnection(admin, user.id);
      return jsonResponse({ configured, connection }, 200, corsHeaders);
    }

    if (!githubAppIsConfigured()) throw new FunctionError("GitHub App 尚未完成服务端配置", 503);

    if (body.action === "start") {
      const state = createOpaqueState();
      const now = new Date();
      const { error: cleanupError } = await admin.from("github_install_states").delete().lt("expires_at", now.toISOString());
      if (cleanupError) throw cleanupError;
      const { error } = await admin.from("github_install_states").insert({
        state_hash: await hashState(state),
        user_id: user.id,
        expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      });
      if (error) throw error;

      const slug = requiredEnv("GITHUB_APP_SLUG");
      const installUrl = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
      installUrl.searchParams.set("state", state);
      return jsonResponse({ installUrl: installUrl.toString() }, 200, corsHeaders);
    }

    const connection = await getConnection(admin, user.id);
    if (!connection) throw new FunctionError("请先连接 GitHub App", 409);

    if (body.action === "repositories") {
      const token = await createInstallationToken(connection.installation_id);
      const repositories = await listInstallationRepositories(token);
      return jsonResponse({
        repositories: repositories
          .filter((repository) => repository.full_name.split("/")[0]?.toLowerCase() === connection.installation_account_login.toLowerCase())
          .map(toClientRepository),
        selectedRepositoryId: connection.repository_id,
      }, 200, corsHeaders);
    }

    if (body.action === "select-repository") {
      const repositoryId = typeof body.repositoryId === "string" ? body.repositoryId : "";
      if (!/^\d+$/.test(repositoryId)) throw new FunctionError("请选择一个有效仓库");
      const token = await createInstallationToken(connection.installation_id);
      const repositories = await listInstallationRepositories(token);
      const repository = repositories.find((item) => String(item.id) === repositoryId);
      if (!repository) throw new FunctionError("该仓库不在 GitHub App 的授权范围内，请重新加载列表", 403);
      const repositoryOwner = repository.full_name.split("/")[0];
      if (repositoryOwner?.toLowerCase() !== connection.installation_account_login.toLowerCase()) {
        throw new FunctionError("请选择安装 GitHub App 的个人账号所拥有的仓库", 403);
      }

      const { error } = await admin.from("github_connections").update({
        repository_id: repositoryId,
        repository_full_name: repository.full_name,
        updated_at: new Date().toISOString(),
      }).eq("user_id", user.id);
      if (error) throw error;
      return jsonResponse({ connection: await getConnection(admin, user.id) }, 200, corsHeaders);
    }

    if (body.action === "disconnect") {
      const { error } = await admin.from("github_connections").delete().eq("user_id", user.id);
      if (error) throw error;
      const { error: backupStateError } = await admin.from("github_backup_state").delete().eq("user_id", user.id);
      if (backupStateError) throw backupStateError;
      return jsonResponse({ ok: true }, 200, corsHeaders);
    }

    throw new FunctionError("Unsupported action");
  } catch (error) {
    console.error("github-account failed", error);
    const status = error instanceof FunctionError ? error.status : 500;
    const message = error instanceof Error ? error.message : "GitHub account operation failed";
    return jsonResponse({ error: message }, status, corsHeaders);
  }
});

function githubAppIsConfigured() {
  return Boolean(
    Deno.env.get("GITHUB_APP_ID") &&
    Deno.env.get("GITHUB_APP_SLUG") &&
    Deno.env.get("GITHUB_APP_PRIVATE_KEY") &&
    Deno.env.get("GITHUB_APP_CLIENT_ID") &&
    Deno.env.get("GITHUB_APP_CLIENT_SECRET") &&
    Deno.env.get("APP_BASE_URL"),
  );
}

async function getConnection(admin: ReturnType<typeof createAdminClient>, userId: string) {
  const { data, error } = await admin.from("github_connections")
    .select("installation_id, installation_account_login, repository_id, repository_full_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ? {
    installationAccountLogin: data.installation_account_login as string,
    repositoryId: data.repository_id as string | null,
    repositoryFullName: data.repository_full_name as string | null,
  } : null;
}

function toClientRepository(repository: GithubRepository) {
  return {
    id: String(repository.id),
    fullName: repository.full_name,
    private: repository.private,
    defaultBranch: repository.default_branch,
  };
}
