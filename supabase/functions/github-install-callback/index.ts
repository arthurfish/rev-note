import { createOpaqueState, hashState } from "../_shared/github-state.ts";
import { createAdminClient, requiredEnv } from "../_shared/supabase.ts";

Deno.serve(async (request) => {
  if (request.method !== "GET") return new Response("Use GET", { status: 405 });

  try {
    const url = new URL(request.url);
    const installationId = url.searchParams.get("installation_id") ?? "";
    const setupAction = url.searchParams.get("setup_action");
    const state = url.searchParams.get("state") ?? "";
    if (!/^\d+$/.test(installationId) || !state || !["install", "update"].includes(setupAction ?? "")) {
      return redirectToApp("error");
    }

    const admin = createAdminClient();
    const { data: pending, error: consumeError } = await admin.from("github_install_states")
      .delete()
      .eq("state_hash", await hashState(state))
      .is("installation_id", null)
      .gt("expires_at", new Date().toISOString())
      .select("user_id")
      .maybeSingle();
    if (consumeError) throw consumeError;
    if (!pending) return redirectToApp("error");

    // The setup URL's installation_id is user-controlled. The OAuth callback will
    // verify it against installations accessible to the GitHub account that signed in.
    const oauthState = createOpaqueState();
    const { error } = await admin.from("github_install_states").insert({
      state_hash: await hashState(oauthState),
      user_id: pending.user_id,
      installation_id: installationId,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    if (error) throw error;

    const callbackUrl = `${requiredEnv("SUPABASE_URL").replace(/\/$/, "")}/functions/v1/github-oauth-callback`;
    const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
    authorizationUrl.searchParams.set("client_id", requiredEnv("GITHUB_APP_CLIENT_ID"));
    authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizationUrl.searchParams.set("state", oauthState);
    return Response.redirect(authorizationUrl, 302);
  } catch (error) {
    console.error("github-install-callback failed", error);
    return redirectToApp("error");
  }
});

function redirectToApp(result: "error") {
  const destination = new URL(requiredEnv("APP_BASE_URL"));
  destination.searchParams.set("github", result);
  return Response.redirect(destination, 302);
}
