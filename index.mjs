import { createHash } from "node:crypto";
import { createQueries } from "./queries.mjs";
import { usageOf } from "./usage.mjs";

// index.mjs connects Magpie accounts to moonup's authenticated model
// catalogue and generation endpoints. One account holds one site's API Key;
// the gateway owns group selection, aliases, protocol conversion, and billing.
// The plugin exposes model IDs reported for that Key and uses explicit
// protocol permissions when available. Legacy lists use common model families
// to choose a text API, with exact protocol overrides for custom aliases.
//
// Magpie selects the account before invoking its loader. Each loader captures
// that account's address and credentials, replaces caller authentication, and
// returns the upstream response without reading its stream. The loader's /v1
// base is shared by the text APIs; Gemini paths are rewritten to /v1beta.
// Metadata queries share account-isolated short-lived results and have bounded
// responses, while generation retains the caller's cancellation signal and can
// stream for as long as the caller allows.

// PROVIDER and ENDPOINTS define the public provider identity and supported
// text transports; catalogue permissions decide which entries each model uses.
const PROVIDER = "moonup";
const ENDPOINTS = [
  ["anthropic_messages", "@ai-sdk/anthropic", "/v1"],
  ["openai_responses", "@ai-sdk/openai", "/v1"],
  ["openai_chat_completions", "@ai-sdk/openai-compatible", "/v1"],
  ["gemini_generate_content", "@ai-sdk/google", "/v1beta"],
];

// SITE_OPTIONS provides moonup's two built-in HTTPS destinations for new
// accounts; each selected address is persisted with its own API Key metadata.
const SITE_OPTIONS = [
  { label: "moonup.dev", value: "https://moonup.dev" },
  { label: "api.moonup.dev", value: "https://api.moonup.dev" },
];

/** MoonupPlugin supplies per-Key models, generation, and usage to Magpie.
 * New accounts select a built-in moonup address before supplying their Key.
 * A configured baseURL skips that selection; saved account addresses take
 * precedence. Magpie owns credential persistence and
 * account failover, and no plugin-specific credential file is created.
 */
export async function MoonupPlugin({ client } = {}, options = {}) {
  const configuredBase = options.baseURL ? normalizeBase(options.baseURL) : "";
  const modelProtocols = validateModelProtocols(options.modelProtocols);
  const queries = createQueries();
  const sitePrompt = {
    type: "select",
    key: "baseURL",
    message: "选择 moonup 地址 / Choose moonup address",
    options: SITE_OPTIONS.map((site) => ({ ...site })),
  };
  return {
    /** config declares the provider before any account has been added.
     * Existing user configuration takes precedence, including its display name
     * and models; the plugin supplies defaults only for an absent provider.
     */
    config(config) {
      config.provider ??= {};
      config.provider[PROVIDER] ??= {
        name: options.name || "moonup",
        npm: "@ai-sdk/openai-compatible",
        models: {},
      };
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "moonup API key",
          placeholder: "sk-…",
          prompts: configuredBase ? [] : [sitePrompt],
          /** authorize resolves the address accompanying Magpie's separately collected Key.
           * A configured address skips selection; otherwise the first built-in
           * address is the default. Unlisted selections are rejected, and Magpie
           * saves the Key separately through its API method.
           */
          async authorize(inputs) {
            const baseURL = normalizeBase(
              inputs?.baseURL || configuredBase || SITE_OPTIONS[0].value,
            );
            if (
              !configuredBase &&
              !SITE_OPTIONS.some((site) => site.value === baseURL)
            ) {
              throw new Error("请选择 moonup.dev 或 api.moonup.dev。");
            }
            return {
              type: "success",
              metadata: { baseURL },
            };
          },
        },
      ],
      /** loader binds generation to the current account's address and Key.
       * Magpie calls it again after authentication changes. The placeholder API
       * key is replaced inside fetch before the request reaches the gateway.
       */
      async loader(getAuth) {
        const account = accountOf(await getAuth(), configuredBase);
        await nameAccount(client, account);
        return {
          baseURL: account.base + "/v1",
          apiKey: "moonup-plugin",
          fetch: (input, init) => forward(account, input, init, queries),
        };
      },
      /** usage returns funding windows or a user-visible query failure.
       * Query failures retain the sign-in unless the gateway returned 401.
       * Funding errors are reported by usageOf without changing the saved Key.
       */
      async usage(getAuth) {
        try {
          const account = accountOf(await getAuth(), configuredBase);
          const body = await queries.get(account, "/v1/usage");
          return { user: account.name, ...usageOf(body) };
        } catch (error) {
          // Usage failures are displayed by Magpie, while an explicit sign-in
          // state keeps temporary network failures from revoking otherwise valid credentials.
          return {
            error: error.message,
            windows: [],
            signIn: error.signIn || "kept",
          };
        }
      },
    },
    provider: {
      id: PROVIDER,
      /** models discovers only the current Key's supported text models.
       * Query failures propagate so Magpie can retain its previous list. A
       * successfully empty list replaces previous models, including revoked permissions.
       */
      async models(_provider, { auth } = {}) {
        const account = accountOf(auth, configuredBase);
        await nameAccount(client, account);
        const body = await queries.get(
          account,
          "/v1/models?include=capabilities",
        );
        const models = Object.create(null);
        for (const model of body.data) {
          const entry = runtimeModel(model, account.base, modelProtocols);
          if (entry) models[model.id] = entry;
        }
        return models;
      },
    },
  };
}

/** normalizeBase validates an address and removes a trailing API version.
 * Deployment paths remain intact. Embedded credentials, queries, fragments,
 * and non-HTTP schemes are rejected before any authenticated request is made.
 */
function normalizeBase(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    // Invalid addresses cannot identify a credential destination; hide their
    // original text because users sometimes paste a complete authenticated URL here.
    throw new Error("请输入完整站点地址，例如 https://moonup.dev。");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("站点地址仅支持 HTTP(S)，不能包含账号、查询参数或片段。");
  }
  return url.href.replace(/\/+$/, "").replace(/\/v1(?:beta)?$/, "");
}

/** accountOf resolves one saved Key and its stable display identity.
 * Saved addresses override plugin defaults. A short digest includes both the
 * deployment address and full Key to distinguish otherwise matching suffixes.
 * Existing account IDs take precedence because Magpie associates model settings
 * with those IDs. The digest is a display discriminator rather than a credential
 * or authorization identifier, and its truncation is not a uniqueness guarantee.
 * Credentials shorter than eight characters contribute no visible suffix because
 * displaying four characters could otherwise reveal most or all of the supplied value.
 */
function accountOf(auth, configuredBase) {
  if (
    auth?.type !== "api" ||
    typeof auth.key !== "string" ||
    !auth.key.trim()
  ) {
    throw Object.assign(new Error("请先添加 moonup API key。"), {
      signIn: "expired",
    });
  }
  const base = normalizeBase(auth.metadata?.baseURL || configuredBase);
  const key = auth.key.trim();
  // Eight hexadecimal characters keep the display discriminator compact.
  const digest = createHash("sha256")
    .update(base + "\0" + key)
    .digest("hex")
    .slice(0, 8);
  // Short malformed credentials can contain fewer characters than a suffix;
  // show only their digest so an invalid pasted value is not copied into account labels.
  const suffix = key.length >= 8 ? ` …${key.slice(-4)}` : "";
  const name =
    auth.accountId ||
    auth.metadata?.email ||
    `${new URL(base).host}${suffix} · ${digest}`;
  return { auth, base, key, name };
}

/** nameAccount persists a stable label in Magpie's current account scope.
 * Existing account identities remain unchanged. Storage failures propagate so
 * the host can report an unsuccessful account update instead of silently losing it.
 */
async function nameAccount(client, account) {
  if (account.auth.accountId || !client?.auth?.set) return;
  await client.auth.set({
    path: { id: PROVIDER },
    body: { ...account.auth, accountId: account.name },
  });
}

/** runtimeModel converts gateway metadata or a legacy model to one Magpie model.
 * Supplied non-text-only protocols return undefined. Native allowed endpoints
 * take precedence, followed by a fixed protocol order; legacy endpoint selection
 * uses protocolsOf and public IDs remain exact.
 * Missing numeric limits and capability flags remain absent rather than guessed.
 * The gateway reports common capabilities across eligible routes, so the result
 * uses those restrictions even when another route offers larger limits. Exact
 * reasoning choices are exposed as variants without introducing additional models.
 */
function runtimeModel(model, base, overrides) {
  const protocols = protocolsOf(model, overrides);
  const native = Array.isArray(model.native_protocols)
    ? model.native_protocols
    : [];
  const endpoint =
    ENDPOINTS.find(([id]) => protocols.includes(id) && native.includes(id)) ||
    ENDPOINTS.find(([id]) => protocols.includes(id));
  if (!endpoint) return undefined;
  const [, npm, suffix] = endpoint;
  const attrs = model.attributes || {};
  const capabilities = {};
  for (const [source, target] of [
    ["reasoning", "reasoning"],
    ["tool_call", "toolcall"],
    ["temperature", "temperature"],
    ["attachment", "attachment"],
  ]) {
    if (typeof attrs[source] === "boolean")
      capabilities[target] = attrs[source];
    if (attrs.conditions?.[source]) {
      // Magpie's boolean capability cannot express gateway request conditions;
      // suppress conditional sampling or tools rather than advertising unconditional support.
      capabilities[target] = false;
    }
  }
  for (const [source, target] of [
    ["input_modalities", "input"],
    ["output_modalities", "output"],
  ]) {
    if (Array.isArray(attrs[source])) {
      capabilities[target] = Object.fromEntries(
        ["text", "image", "audio", "video", "pdf"].map((kind) => [
          kind,
          attrs[source].includes(kind),
        ]),
      );
    }
  }
  if (attrs.interleaved !== undefined)
    capabilities.interleaved = attrs.interleaved;
  const variants = Object.create(null);
  for (const option of Array.isArray(attrs.reasoning_options)
    ? attrs.reasoning_options
    : []) {
    if (
      attrs.reasoning !== true ||
      option.type !== "effort" ||
      !Array.isArray(option.values)
    )
      continue;
    for (const value of option.values) {
      if (typeof value === "string" && value) variants[value] = {};
    }
  }
  const limit = {};
  for (const [source, target] of [
    ["context", "context"],
    ["input_limit", "input"],
    ["output_limit", "output"],
  ]) {
    if (Number.isFinite(attrs[source]) && attrs[source] > 0)
      limit[target] = attrs[source];
  }
  return {
    id: model.id,
    providerID: PROVIDER,
    name: model.display_name || model.id,
    api: { id: model.id, url: base + suffix, npm },
    capabilities,
    limit,
    variants,
    status: "active",
    headers: {},
    options: {},
  };
}

/** protocolsOf chooses text protocol candidates for one authenticated model.
 * Supplied server permissions take precedence, including an explicitly empty
 * list. Only legacy entries lacking the field consult exact model overrides
 * and then recognizable family names. Composite prefixes are removed solely
 * for that family check; the transmitted model ID remains unchanged. Unknown
 * names use Chat Completions, so nonstandard aliases or restricted groups may
 * need an override until the server provides protocol metadata.
 */
function protocolsOf(model, overrides) {
  if (Object.hasOwn(model, "protocols")) return model.protocols;
  if (Object.hasOwn(overrides, model.id)) return [overrides[model.id]];
  // Standard Sub2API catalogues omit protocol permissions. Use their common
  // model-family convention only for missing metadata, preserving explicit server restrictions above.
  const family = model.id.slice(model.id.lastIndexOf("/") + 1).toLowerCase();
  if (/^claude(?:[-_.]|$)/.test(family)) return ["anthropic_messages"];
  if (/^(?:gpt[-_.]|chatgpt[-_.]|codex[-_.]|o\d)/.test(family))
    return ["openai_responses"];
  if (/^gemini(?:[-_.]|$)/.test(family)) return ["gemini_generate_content"];
  return ["openai_chat_completions"];
}

/** validateModelProtocols checks optional exact overrides for legacy model IDs.
 * Values use the four documented text protocol identifiers. Unknown identifiers
 * and non-object configurations fail during plugin loading so misspelled settings
 * cannot silently send a legacy alias through an unintended endpoint.
 */
function validateModelProtocols(value) {
  if (value == null) return Object.create(null);
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([model, protocol]) =>
        !model || !ENDPOINTS.some(([id]) => id === protocol),
    )
  ) {
    throw new Error(
      "modelProtocols 需要使用完整模型 ID 和支持的文本协议名称。",
    );
  }
  return { ...value };
}

/** forward sends one generation request with its selected account credentials.
 * Input must target that account's /v1 text endpoints. Authentication from
 * callers is replaced, Gemini's version prefix is corrected, redirects fail,
 * and the returned Response retains its original body and cancellation lifetime.
 * The loader base takes precedence over model URLs in Magpie, so the rewrite
 * permits one account to serve Gemini alongside Messages, Responses, and Chat.
 * Request bodies and public model IDs are passed through without decoding.
 * A returned 401 clears this account's cached model and usage observations.
 */
async function forward(account, input, init, queries) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const base = new URL(account.base);
  const prefix = base.pathname.replace(/\/$/, "") + "/v1/";
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) {
    throw new Error("模型请求地址与当前 moonup 账号不一致。");
  }
  const operation = url.pathname.slice(prefix.length);
  const gemini =
    /^models\/.+:(?:streamGenerateContent|generateContent|countTokens)$/.test(
      operation,
    );
  if (
    !gemini &&
    ![
      "messages",
      "messages/count_tokens",
      "responses",
      "chat/completions",
    ].includes(operation)
  ) {
    throw new Error("moonup 插件不支持此请求接口。");
  }
  if (gemini) {
    // Magpie's loader base overrides per-model URLs. Restore Gemini's version
    // here so mixed-protocol accounts can share one loader without changing model IDs.
    url.pathname = prefix.replace(/v1\/$/, "v1beta/") + operation;
  }
  url.searchParams.delete("key");
  const headers = new Headers(request.headers);
  for (const name of ["authorization", "x-api-key", "x-goog-api-key"])
    headers.delete(name);
  headers.set("Authorization", `Bearer ${account.key}`);
  if (operation.startsWith("messages")) {
    headers.set("x-api-key", account.key);
    if (!headers.has("anthropic-version"))
      headers.set("anthropic-version", "2023-06-01");
  }
  if (gemini) headers.set("x-goog-api-key", account.key);
  const response = await fetch(new Request(url, request), {
    headers,
    redirect: "error",
  });
  // A rejected credential must not retain successful catalogue or quota
  // observations from before the backend revoked or replaced that account's Key.
  if (response.status === 401) queries.clear(account);
  return response;
}
