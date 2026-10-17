import { Effect } from "effect";
import * as Coordinator from "../index.ts";
import * as Supabase from "../../supabase/index.ts";

const admin = await Effect.runPromise(Supabase.createAdminClient());
const status = await Effect.runPromise(
  Coordinator.Account.handleAccountAction(
    "527d24f7-c784-4260-8c79-5cf0f3851b14",
    {
      action: "status",
    },
  ).pipe(
    Effect.provide(Coordinator.layer(admin, admin)),
  ),
);
await Effect.runPromise(Effect.logInfo("GitHub PAT status", status));
