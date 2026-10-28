import { createHash } from "node:crypto";
import { usageOf } from "./usage.mjs";

// index.mjs connects Magpie accounts to moonup's authenticated model
// catalogue and generation endpoints. One account holds one site's API Key;
// the gateway owns group selection, aliases, protocol conversion, and billing.
// The plugin exposes only models and capabilities reported for that Key, so
// arbitrary aliases and composite prefixes never require client-side guessing.
//
// Magpie selects the account before invoking its loader. Each loader captures
// that account's address and credentials, replaces caller authentication, and
// returns the upstream response without reading its stream. The loader's /v1
// base is shared by the text APIs; Gemini paths are rewritten to /v1beta.
// Metadata queries have a bounded timeout, while generation retains the
// caller's cancellation signal and can stream for as long as the caller allows.

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

// QUERY_TIMEOUT_MS bounds only read-only metadata calls; generation requests
// retain the caller's own cancellation lifetime and have no added deadline.
const QUERY_TIMEOUT_MS = 15_000;

/** MoonupPlugin supplies per-Key models, generation, and usage to Magpie.
 * New accounts select a built-in moonup address before supplying their Key.
 * A configured baseURL skips that selection; saved account addresses take
 * precedence. Magpie owns credential persistence and
 * account failover, and no plugin-specific credential file is created.
 */
export async function MoonupPlugin({ client } = {}, options = {}) {
  const configuredBase = options.baseURL ? normalizeBase(options.baseURL) : "";
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
          fetch: (input, init) => forward(account, input, init),
        };
      },
      /** usage returns funding windows or a user-visible query failure.
       * Query failures retain the sign-in unless the gateway returned 401.
       * Funding errors are reported by usageOf without changing the saved Key.
       */
      async usage(getAuth) {
        try {
          const account = accountOf(await getAuth(), configuredBase);
          const body = await query(account, "/v1/usage");
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
        const body = await query(account, "/v1/models?include=capabilities");
        if (!Array.isArray(body?.data))
          throw new Error("moonup 返回的模型列表格式无效。");
        const models = Object.create(null);
        for (const model of body.data) {
          if (typeof model?.id !== "string" || !model.id) continue;
          if (!Array.isArray(model.protocols)) {
            throw new Error(
              "请升级 moonup 服务端，以支持插件自动识别模型协议。",
            );
          }
          const entry = runtimeModel(model, account.base);
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
  // The digest distinguishes deployments sharing an origin and Keys sharing a
  // visible suffix; the raw credential is never part of the displayed name.
  const name =
    auth.accountId ||
    auth.metadata?.email ||
    `${new URL(base).host} …${key.slice(-4)} · ${digest}`;
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

/** query fetches authenticated catalogue or usage JSON with a bounded timeout.
 * Redirects are refused. Errors expose fixed messages and HTTP status rather
 * than reflecting a server body that could contain a submitted credential.
 */
async function query(account, path) {
  let response;
  try {
    response = await fetch(account.base + path, {
      headers: {
        Authorization: `Bearer ${account.key}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
  } catch {
    // Network errors can contain URLs or redirect details. Use a fixed message
    // that preserves credentials and tells users which configuration to check.
    throw new Error("无法连接 moonup，请检查站点地址、网络和代理。");
  }
  if (!response.ok) {
    // Failed metadata replies are not consumed. Release their body before
    // reporting the HTTP status; cleanup failure must not conceal credential rejection.
    await response.body?.cancel().catch(() => undefined);
    // Metadata requests are read-only, but gateway authentication still rejects
    // invalid credentials with 401; only that status asks Magpie for another sign-in.
    const messages = {
      401: "API key 无效，请重新添加。",
      403: "此 API key 无权访问，请检查密钥和分组权限。",
      429: "查询过于频繁，请稍后重试。",
    };
    const message =
      messages[response.status] ||
      `moonup 查询失败（HTTP ${response.status}）。`;
    throw Object.assign(new Error(message), {
      signIn: response.status === 401 ? "expired" : "kept",
    });
  }
  try {
    return await response.json();
  } catch {
    // A successful non-JSON reply commonly comes from a frontend or proxy;
    // report the address mismatch without exposing the returned page's contents.
    throw new Error("moonup 未返回 JSON，请检查是否填写了正确的 API 地址。");
  }
}

/** runtimeModel converts explicit gateway capabilities to one Magpie model.
 * Unsupported non-text protocols return undefined. Native allowed endpoints
 * take precedence, followed by a fixed protocol order; public IDs remain exact.
 * Missing numeric limits and capability flags remain absent rather than guessed.
 * The gateway reports common capabilities across eligible routes, so the result
 * uses those restrictions even when another route offers larger limits. Exact
 * reasoning choices are exposed as variants without introducing additional models.
 */
function runtimeModel(model, base) {
  const native = Array.isArray(model.native_protocols)
    ? model.native_protocols
    : [];
  const endpoint =
    ENDPOINTS.find(
      ([id]) => model.protocols.includes(id) && native.includes(id),
    ) || ENDPOINTS.find(([id]) => model.protocols.includes(id));
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

/** forward sends one generation request with its selected account credentials.
 * Input must target that account's /v1 text endpoints. Authentication from
 * callers is replaced, Gemini's version prefix is corrected, redirects fail,
 * and the returned Response retains its original body and cancellation lifetime.
 * The loader base takes precedence over model URLs in Magpie, so the rewrite
 * permits one account to serve Gemini alongside Messages, Responses, and Chat.
 * Request bodies and public model IDs are passed through without decoding.
 */
async function forward(account, input, init) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const base = new URL(account.base);
  const prefix = base.pathname.replace(/\/$/, "") + "/v1/";
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) {
    throw new Error("模型请求地址与当前 moonup 账号不一致。");
  }
  const operation = url.pathname.slice(prefix.length);
  const gemini = /^models\/.+:(?:streamGenerateContent|generateContent)$/.test(
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
  return fetch(new Request(url, request), { headers, redirect: "error" });
}
