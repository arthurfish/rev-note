import { Config, ConfigProvider, Effect, Option, Schema } from "effect";
// deno-lint-ignore no-import-prefix
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { FunctionError } from "../http-errors.ts";
import { SupabaseError } from "./errors.ts";
import { NamedKeys } from "./schema.ts";

export const requireAuthenticatedUser = Effect.fn(
  "Supabase.requireAuthenticatedUser",
)(function* (request: Request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization) {
    return yield* new FunctionError({
      message: "Authentication required",
      status: 401,
    });
  }

  const configProvider = yield* environmentConfigProvider();
  const url = yield* requiredConfig(configProvider, "SUPABASE_URL");
  const publishableKey = yield* getPublishableKey(configProvider);
  const supabase = yield* makeClient(url, publishableKey, {
    ...authOptions,
    global: {
      headers: { Authorization: authorization },
      fetch: fetchWithRequestSignal(request.signal),
    },
  });
  const result = yield* Effect.tryPromise({
    try: () => supabase.auth.getUser(),
    catch: () =>
      new FunctionError({
        message: "Supabase authentication service is unavailable",
        status: 503,
      }),
  });
  if (result.error) {
    const status = errorStatus(result.error);
    if (status === 401) {
      return yield* new FunctionError({
        message: "Authentication required",
        status: 401,
      });
    }
    return yield* new FunctionError({
      message: "Could not verify authentication",
      status: 503,
    });
  }
  if (!result.data.user) {
    return yield* new FunctionError({
      message: "Authentication required",
      status: 401,
    });
  }
  return { supabase, user: result.data.user };
});

function getPublishableKey(configProvider: ConfigProvider.ConfigProvider) {
  return Effect.gen(function* () {
    const namedKeys = yield* optionalConfig(
      configProvider,
      "SUPABASE_PUBLISHABLE_KEYS",
    );
    const namedKey = yield* namedDefaultKey(namedKeys);
    if (namedKey) return namedKey;

    const publishableKey = yield* optionalConfig(
      configProvider,
      "SUPABASE_PUBLISHABLE_KEY",
    );
    if (Option.isSome(publishableKey)) return publishableKey.value;
    return yield* requiredConfig(configProvider, "SUPABASE_ANON_KEY");
  });
}

function errorStatus(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const status = Reflect.get(error, "status");
  return typeof status === "number" ? status : undefined;
}

function namedDefaultKey(
  value: Option.Option<string>,
) {
  if (Option.isNone(value)) return Effect.succeed(undefined);

  return Effect.try({
    try: () => parseJson(value.value),
    catch: () =>
      new FunctionError({
        message: "Supabase configuration is invalid",
        status: 500,
      }),
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknownEffect(NamedKeys)(parsed).pipe(
        Effect.mapError(() =>
          new FunctionError({
            message: "Supabase configuration is invalid",
            status: 500,
          })
        ),
        Effect.map((keys) =>
          keys.default && keys.default.length > 0 ? keys.default : undefined
        ),
      )
    ),
  );
}

export const createAdminClient = Effect.fn("Supabase.createAdminClient")(
  function* () {
    const configProvider = yield* environmentConfigProvider();
    const namedKeys = yield* optionalConfig(
      configProvider,
      "SUPABASE_SECRET_KEYS",
    );
    const namedKey = yield* namedDefaultKey(namedKeys);
    const secretKey = yield* optionalConfig(
      configProvider,
      "SUPABASE_SECRET_KEY",
    );
    const serviceRoleKey = yield* optionalConfig(
      configProvider,
      "SUPABASE_SERVICE_ROLE_KEY",
    );
    const apiKey = namedKey ??
      (Option.isSome(secretKey) ? secretKey.value : undefined) ??
      (Option.isSome(serviceRoleKey) ? serviceRoleKey.value : undefined);
    if (!apiKey) {
      return yield* new FunctionError({
        message: "Supabase server configuration is invalid",
        status: 500,
      });
    }

    const url = yield* requiredConfig(configProvider, "SUPABASE_URL");
    return yield* makeClient(url, apiKey, authOptions);
  },
);

function environmentConfigProvider() {
  return Effect.try({
    try: () => ConfigProvider.fromEnv({ env: Deno.env.toObject() }),
    catch: () =>
      new FunctionError({
        message: "Supabase configuration is invalid",
        status: 500,
      }),
  });
}

function optionalConfig(
  provider: ConfigProvider.ConfigProvider,
  name: string,
) {
  return Config.option(Config.String(name)).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
    Effect.mapError(() =>
      new FunctionError({
        message: "Supabase configuration is invalid",
        status: 500,
      })
    ),
  );
}

function requiredConfig(
  provider: ConfigProvider.ConfigProvider,
  name: string,
) {
  return Config.String(name).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
    Effect.mapError(() =>
      new FunctionError({
        message: "Supabase configuration is invalid",
        status: 500,
      })
    ),
  );
}

function makeClient(
  url: string,
  key: string,
  options: Parameters<typeof createClient>[2],
) {
  return Effect.try({
    try: () => createClient(url, key, options),
    catch: () =>
      new FunctionError({
        message: "Supabase configuration is invalid",
        status: 500,
      }),
  });
}

export type SupabaseClient = Effect.Success<ReturnType<typeof makeClient>>;

export const executeSupabaseQuery = Effect.fn("Supabase.executeQuery")(
  function* <A>(
    operation: string,
    query: (signal: AbortSignal) => PromiseLike<
      { readonly data: A; readonly error: unknown | null }
    >,
  ) {
    const { data, error } = yield* Effect.tryPromise({
      try: (signal) => Promise.resolve(query(signal)),
      catch: (cause) => toSupabaseError(operation, cause),
    });
    if (error !== null) {
      return yield* Effect.fail(toSupabaseError(operation, error));
    }
    return data;
  },
);

function fetchWithRequestSignal(requestSignal: AbortSignal): typeof fetch {
  return (input, init) => {
    const signal = init?.signal
      ? AbortSignal.any([requestSignal, init.signal])
      : requestSignal;
    return fetch(input, { ...init, signal });
  };
}

export function toSupabaseError(operation: string, cause: unknown) {
  const causeMessage = typeof cause === "object" && cause !== null
    ? Reflect.get(cause, "message")
    : undefined;
  const message = typeof causeMessage === "string"
    ? causeMessage
    : "Supabase request failed";
  return new SupabaseError({ operation, message });
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

const authOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
};
