import { Layer } from "effect";
import * as GitHub from "../github/index.ts";
import * as Supabase from "../supabase/index.ts";

/** Build the application environment for one authenticated request. */
export function layer(
  userClient: Supabase.SupabaseClient,
  adminClient: Supabase.SupabaseClient,
) {
  return Layer.mergeAll(
    GitHub.layer(),
    Supabase.layer(userClient, adminClient),
  );
}
