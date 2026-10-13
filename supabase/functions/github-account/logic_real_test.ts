import { createAdminClient } from "../_shared/supabase.ts";
import { createGithubAccountDependencies } from "./dependencies.ts";
import {handleGithubAccountAction} from "./logic.ts";

const admin = createAdminClient();
const dependencies = createGithubAccountDependencies(admin);

handleGithubAccountAction("527d24f7-c784-4260-8c79-5cf0f3851b14", { action: "repositories" }, dependencies);