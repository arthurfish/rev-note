import { githubRequest, listUserInstallations } from "../_shared/github.ts";
import { hashState } from "../_shared/github-state.ts";
import { createAdminClient, requiredEnv } from "../_shared/supabase.ts";

Deno.serve(async (request) => {
  if (request.method !== "GET") return new Response("Use GET", { status: 405 });

  try {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    if (!state) return redirectToApp("error");

    const admin = createAdminClient();
    const { data: pending, error: consumeError } = await admin.from("github_install_states")
      .delete()
      .eq("state_hash", await hashState(state))
      .not("installation_id", "is", null)
      .gt("expires_at", new Date().toISOString())
      .select("user_id, installation_id")
      .maybeSingle();
    if (consumeError) throw consumeError;
    if (!pending) return redirectToApp("error");
    if (url.searchParams.has("error") || !url.searchParams.get("code")) return redirectToApp("error");

    const accessToken = await exchangeAuthorizationCode(url.searchParams.get("code")!);
    try {
      const installations = await listUserInstallations(accessToken);
      const installation = installations.find((item) => String(item.id) === String(pending.installation_id));
      const accountLogin = installation?.account?.login;
      if (!installation || !accountLogin) return redirectToApp("error");

      const githubUser = await githubRequest<{ login: string }>("https://api.github.com/user", accessToken);
      if (accountLogin.toLowerCase() !== githubUser.login.toLowerCase()) return redirectToApp("error");

      const { error } = await admin.from("github_connections").upsert({
        user_id: pending.user_id,
        installation_id: String(pending.installation_id),
        installation_account_login: accountLogin,
        repository_id: null,
        repository_full_name: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error) throw error;
      return redirectToApp("connected");
    } finally {
      try {
        await revokeAuthorizationToken(accessToken);
      } catch (error) {
        console.error("Could not revoke temporary GitHub user token", error);
      }
    }
  } catch (error) {
    console.error("github-oauth-callback failed", error);
    return redirectToApp("error");
  }
});

async function exchangeAuthorizationCode(code: string) {
  const callbackUrl = `${requiredEnv("SUPABASE_URL").replace(/\/$/, "")}/functions/v1/github-oauth-callback`;
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: requiredEnv("GITHUB_APP_CLIENT_ID"),
      client_secret: requiredEnv("GITHUB_APP_CLIENT_SECRET"),
      code,
      redirect_uri: callbackUrl,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.access_token !== "string") {
    throw new Error("GitHub user authorization failed");
  }
  return body.access_token as string;
}

async function revokeAuthorizationToken(accessToken: string) {
  const clientId = requiredEnv("GITHUB_APP_CLIENT_ID");
  const clientSecret = requiredEnv("GITHUB_APP_CLIENT_SECRET");
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, {
    method: "DELETE",
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  if (!response.ok) console.error("Could not revoke temporary GitHub user token", response.status);
}

async function redirectToApp(result: "connected" | "error") {
  const destination = new URL(requiredEnv("APP_BASE_URL"));
  destination.searchParams.set("github", result);
  return Response.redirect(destination, 302);
}
