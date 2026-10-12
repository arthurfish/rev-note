import { createClient } from "npm:@supabase/supabase-js@2.117.2";

export class FunctionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function getPublishableKey() {
  const namedKeys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (namedKeys) {
    const parsed = JSON.parse(namedKeys) as Record<string, string>;
    if (parsed.default) return parsed.default;
  }
  const singleKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (singleKey) return singleKey;
  return requiredEnv("SUPABASE_ANON_KEY");
}

export function createAdminClient() {
  const namedKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (namedKeys) {
    const parsed = JSON.parse(namedKeys) as Record<string, string>;
    if (parsed.default) return createClient(requiredEnv("SUPABASE_URL"), parsed.default, authOptions);
  }
  const secretKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (secretKey) return createClient(requiredEnv("SUPABASE_URL"), secretKey, authOptions);
  throw new Error("Missing Supabase server secret key");
}

export async function requireAuthenticatedUser(request: Request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization) throw new FunctionError("Authentication required", 401);

  const supabase = createClient(requiredEnv("SUPABASE_URL"), getPublishableKey(), {
    ...authOptions,
    global: { headers: { Authorization: authorization } },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new FunctionError("Authentication required", 401);
  return { supabase, user: data.user };
}

export function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing server secret: ${name}`);
  return value;
}

export function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const authOptions = { auth: { persistSession: false, autoRefreshToken: false } };
