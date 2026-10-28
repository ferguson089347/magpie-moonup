import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { MoonupPlugin } from "../index.mjs";

// plugin.test.mjs exercises the exported Magpie hooks against a local HTTP
// gateway. Requests cross the actual fetch boundary so protocol URLs, account
// credentials, streaming responses, and cancellation are checked together.

/** gateway starts a local fixture and registers cleanup with the owning test.
 * The caller receives its base address and observed requests. Query replies
 * vary by Key, while generation echoes its body as a streamed SSE response.
 */
async function gateway(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ url: request.url, headers: request.headers, body });
    if (request.headers.authorization === "Bearer sk-invalid") {
      response.writeHead(401);
      response.end("sk-invalid must never appear in plugin errors");
      return;
    }
    if (request.headers.authorization === "Bearer sk-redirect") {
      response.writeHead(302, { Location: "/redirected" });
      response.end();
      return;
    }
    if (request.url.startsWith("/site/v1/models?")) {
      const protocols =
        request.headers.authorization === "Bearer sk-second"
          ? ["openai_chat_completions"]
          : ["anthropic_messages"];
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            {
              id: "work/custom-alias",
              display_name: "Work model",
              protocols: ["openai_responses", ...protocols],
              native_protocols: protocols,
              attributes: {
                reasoning: true,
                tool_call: true,
                temperature: false,
                context: 120000,
                output_limit: 8000,
                input_modalities: ["text", "image"],
                reasoning_options: [
                  { type: "effort", values: [null, "low", "high"] },
                ],
              },
            },
            { id: "__proto__", protocols: ["openai_chat_completions"] },
            { id: "images-only", protocols: ["openai_images"] },
            { id: "native-gemini", protocols: ["gemini_generate_content"] },
            { id: "response-alias", protocols: ["openai_responses"] },
          ],
        }),
      );
      return;
    }
    if (request.url === "/site/v1/usage") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          mode: "unrestricted",
          balance: 0,
          isValid: false,
          billing: {
            source: "balance",
            balance: 0,
            available: false,
            unit: "USD",
          },
        }),
      );
      return;
    }
    response.setHeader("Content-Type", "text/event-stream");
    response.write("data: " + body + "\n\n");
    if (request.url.endsWith("?slow=1")) return;
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    // Close active keep-alive sockets before waiting for the listener so test
    // teardown does not wait for the HTTP client's idle connection timeout.
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { base: `http://127.0.0.1:${server.address().port}/site`, requests };
}

// A preconfigured site removes the only metadata question from sign-in.
// Saved account metadata retains the normalized deployment path for subsequent loads.
test("configured sites require only the API key", async () => {
  const hooks = await MoonupPlugin(
    {},
    { baseURL: "https://example.com/site/v1/" },
  );
  const method = hooks.auth.methods[0];
  assert.deepEqual(method.prompts, []);
  assert.deepEqual(await method.authorize({}), {
    type: "success",
    metadata: { baseURL: "https://example.com/site" },
  });
  const config = { provider: { moonup: { name: "My site" } } };
  hooks.config(config);
  assert.equal(config.provider.moonup.name, "My site");
});

// New accounts select either moonup endpoint before entering their API Key.
// Authorization preserves each selected destination, and provider discovery displays moonup's own identity.
test("sign-in offers both moonup addresses and saves the selection", async () => {
  const hooks = await MoonupPlugin();
  const method = hooks.auth.methods[0];
  const prompt = method.prompts[0];
  assert.equal(prompt.type, "select");
  assert.deepEqual(prompt.options, [
    { label: "moonup.dev", value: "https://moonup.dev" },
    { label: "api.moonup.dev", value: "https://api.moonup.dev" },
  ]);
  for (const option of prompt.options) {
    assert.deepEqual(await method.authorize({ baseURL: option.value }), {
      type: "success",
      metadata: { baseURL: option.value },
    });
  }
  assert.deepEqual(await method.authorize({}), {
    type: "success",
    metadata: { baseURL: "https://moonup.dev" },
  });
  await assert.rejects(
    method.authorize({ baseURL: "https://example.com" }),
    /请选择/,
  );
  const config = {};
  hooks.config(config);
  assert.equal(config.provider.moonup.name, "moonup");
  assert.equal(hooks.auth.provider, "moonup");
  assert.equal(method.label, "moonup API key");
});

// Invalid override addresses can contain accidentally pasted credentials or hostile schemes.
// Configuration rejects them locally and never repeats their secret text in an error.
test("site overrides validate destinations without reflecting input", async () => {
  for (const value of [
    "bad-secret",
    "file:///secret",
    "https://user:secret@example.com",
    "https://example.com?key=secret",
    "https://example.com#secret",
  ]) {
    await assert.rejects(MoonupPlugin({}, { baseURL: value }), (error) => {
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
  const hooks = await MoonupPlugin(
    {},
    { baseURL: "http://localhost:8080/prefix/v1beta" },
  );
  assert.deepEqual((await hooks.auth.methods[0].authorize({})).metadata, {
    baseURL: "http://localhost:8080/prefix",
  });
});

// Two Keys at one site can serve the same alias through different protocols.
// Model discovery follows account permissions and preserves explicit capabilities and exact IDs.
test("models follow per-account capabilities without name guessing", async (t) => {
  const fixture = await gateway(t);
  const hooks = await MoonupPlugin();
  const first = {
    type: "api",
    key: "sk-first",
    metadata: { baseURL: fixture.base },
  };
  const second = { ...first, key: "sk-second" };
  const [left, right] = await Promise.all([
    hooks.provider.models({}, { auth: first }),
    hooks.provider.models({}, { auth: second }),
  ]);
  assert.equal(left["work/custom-alias"].api.npm, "@ai-sdk/anthropic");
  assert.equal(left["work/custom-alias"].providerID, "moonup");
  assert.equal(right["work/custom-alias"].api.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(Object.keys(left["work/custom-alias"].variants), [
    "low",
    "high",
  ]);
  assert.equal(left["work/custom-alias"].capabilities.temperature, false);
  assert.deepEqual(left["work/custom-alias"].limit, {
    context: 120000,
    output: 8000,
  });
  assert.ok(Object.hasOwn(left, "__proto__"));
  assert.ok(!Object.hasOwn(left, "images-only"));
  assert.equal(left["native-gemini"].api.url, fixture.base + "/v1beta");
  assert.equal(left["response-alias"].api.npm, "@ai-sdk/openai");
  assert.equal(left["response-alias"].cost, undefined);
});

// Every generation request receives the selected account's Key even when callers supply another credential.
// The four text protocols preserve request bytes and return readable SSE output.
test("generation isolates Keys and forwards all four text protocols", async (t) => {
  const fixture = await gateway(t);
  const hooks = await MoonupPlugin();
  const loaders = await Promise.all(
    ["sk-first", "sk-second"].map((key) =>
      hooks.auth.loader(async () => ({
        type: "api",
        key,
        metadata: { baseURL: fixture.base },
      })),
    ),
  );
  for (const [index, operation] of [
    "messages",
    "responses",
    "chat/completions",
    "models/work%2Fcustom-alias:streamGenerateContent?alt=sse&key=caller",
  ].entries()) {
    const loader = loaders[index % 2];
    const body = JSON.stringify({
      model: "work/custom-alias",
      stream: true,
      messages: [],
    });
    const response = await loader.fetch(loader.baseURL + "/" + operation, {
      method: "POST",
      headers: {
        Authorization: "Bearer caller",
        "x-api-key": "caller",
        "x-goog-api-key": "caller",
        "Content-Type": "application/json",
        "session-id": "kept",
      },
      body,
    });
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    assert.ok((await response.text()).includes("data: " + body));
    const observed = fixture.requests.at(-1);
    assert.equal(observed.body, body);
    assert.equal(
      observed.headers.authorization,
      index % 2 ? "Bearer sk-second" : "Bearer sk-first",
    );
    assert.equal(observed.headers["session-id"], "kept");
    if (index === 0) assert.equal(observed.headers["x-api-key"], "sk-first");
    if (index === 3) {
      assert.equal(
        observed.url,
        "/site/v1beta/models/work%2Fcustom-alias:streamGenerateContent?alt=sse",
      );
      assert.equal(observed.headers["x-goog-api-key"], "sk-second");
    }
  }
  await assert.rejects(
    loaders[0].fetch("https://example.com/v1/messages"),
    /账号不一致/,
  );
  await assert.rejects(loaders[0].fetch(fixture.base + "/v1/admin"), /不支持/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loaders[0].fetch(loaders[0].baseURL + "/responses", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
});

// Gemini token counting shares the account loader with generation requests.
// Its version path and account authentication must match native Gemini while the counting body remains unchanged.
test("Gemini token counting reaches its native endpoint", async (t) => {
  const fixture = await gateway(t);
  const hooks = await MoonupPlugin();
  const loader = await hooks.auth.loader(async () => ({
    type: "api",
    key: "sk-first",
    metadata: { baseURL: fixture.base },
  }));
  const body = JSON.stringify({ contents: [{ parts: [{ text: "hello" }] }] });
  const response = await loader.fetch(
    loader.baseURL + "/models/custom:countTokens",
    {
      method: "POST",
      body,
    },
  );
  await response.text();
  const request = fixture.requests.at(-1);
  assert.equal(request.url, "/site/v1beta/models/custom:countTokens");
  assert.equal(request.headers["x-goog-api-key"], "sk-first");
  assert.equal(request.body, body);
});

// The same account can load its catalogue successfully before generation rejects its credential.
// That returned 401 must invalidate the metadata cache so the next refresh asks the backend again.
test("generation credential rejection invalidates cached models", async (t) => {
  let modelQueries = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/models?")) {
      modelQueries++;
      return Response.json({ data: [] });
    }
    return new Response("unauthorized", { status: 401 });
  });
  const hooks = await MoonupPlugin();
  const auth = {
    type: "api",
    key: "sk-first",
    metadata: { baseURL: "https://moonup.dev" },
  };
  await hooks.provider.models({}, { auth });
  await hooks.provider.models({}, { auth });
  assert.equal(modelQueries, 1);
  const loader = await hooks.auth.loader(async () => auth);
  const response = await loader.fetch(loader.baseURL + "/responses", {
    method: "POST",
    body: "{}",
  });
  assert.equal(response.status, 401);
  await hooks.provider.models({}, { auth });
  assert.equal(modelQueries, 2);
});

// An upstream can keep its response open after sending the first SSE chunk.
// Fetch returns that chunk immediately, and cancellation interrupts the still-open stream.
test(
  "streaming does not wait for completion and remains cancellable",
  { timeout: 3000 },
  async (t) => {
    const fixture = await gateway(t);
    const hooks = await MoonupPlugin();
    const loader = await hooks.auth.loader(async () => ({
      type: "api",
      key: "sk-first",
      metadata: { baseURL: fixture.base },
    }));
    const controller = new AbortController();
    const response = await loader.fetch(loader.baseURL + "/responses?slow=1", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    assert.match(new TextDecoder().decode(chunk.value), /data: \{\}/);
    controller.abort();
    await assert.rejects(reader.read(), { name: "AbortError" });
  },
);

// A gateway can redirect both metadata and generation requests to another route.
// The plugin refuses both redirects, and no request carrying its Key reaches the new destination.
test("authenticated queries and generation refuse redirects", async (t) => {
  const fixture = await gateway(t);
  const hooks = await MoonupPlugin();
  const auth = {
    type: "api",
    key: "sk-redirect",
    metadata: { baseURL: fixture.base },
  };
  const result = await hooks.auth.usage(async () => auth);
  assert.equal(result.signIn, "kept");
  assert.match(result.error, /无法连接/);
  const loader = await hooks.auth.loader(async () => auth);
  await assert.rejects(
    loader.fetch(loader.baseURL + "/responses", { method: "POST", body: "{}" }),
  );
  assert.equal(fixture.requests.length, 2);
  assert.ok(fixture.requests.every((request) => request.url !== "/redirected"));
});

// Two credentials can share their visible suffix while referring to independent accounts.
// Stable account names include a digest, and saving one preserves its full metadata.
test("account labels distinguish matching Key suffixes", async () => {
  const saved = [];
  const hooks = await MoonupPlugin({
    client: { auth: { set: async (value) => saved.push(value) } },
  });
  for (const key of ["sk-one-same", "sk-two-same"]) {
    await hooks.auth.loader(async () => ({
      type: "api",
      key,
      metadata: { baseURL: "https://example.com/site", custom: "preserved" },
    }));
  }
  assert.notEqual(saved[0].body.accountId, saved[1].body.accountId);
  assert.equal(saved[0].body.metadata.custom, "preserved");
  assert.equal(saved[0].path.id, "moonup");
});

// An accidentally pasted short credential can fit entirely inside the usual four-character account hint.
// Its saved label uses the nonsecret site and digest, while the original credential remains in authentication storage.
test("short invalid credentials are not displayed in account labels", async () => {
  const saved = [];
  const hooks = await MoonupPlugin({
    client: { auth: { set: async (value) => saved.push(value) } },
  });
  await hooks.auth.loader(async () => ({
    type: "api",
    key: "abcd",
    metadata: { baseURL: "https://moonup.dev" },
  }));
  assert.ok(!saved[0].body.accountId.includes("abcd"));
  assert.equal(saved[0].body.key, "abcd");
});

// A refreshed model list with a malformed item must not replace previously usable entries with an empty result.
// The public hook rejects that response and fetches the immediately repaired catalogue on its next call.
test("invalid model responses fail refresh and allow immediate recovery", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      ++calls === 1
        ? { data: [null] }
        : { data: [{ id: "recovered", protocols: ["openai_responses"] }] },
    ),
  );
  const hooks = await MoonupPlugin();
  const auth = {
    type: "api",
    key: "sk-fixture",
    metadata: { baseURL: "https://moonup.dev" },
  };
  await assert.rejects(hooks.provider.models({}, { auth }), /条目格式无效/);
  assert.deepEqual(Object.keys(await hooks.provider.models({}, { auth })), [
    "recovered",
  ]);
  assert.equal(calls, 2);
});

// Deployed Sub2API-compatible gateways can return standard model lists without protocol metadata.
// Common model families remain usable through their corresponding text endpoints, including composite-prefixed IDs and unknown compatible models.
test("legacy model lists load without requiring a server upgrade", async (t) => {
  const ids = [
    "claude-sonnet-4-6",
    "gpt-6.1-sol",
    "work/gemini-3-pro",
    "deepseek-chat",
    "work/gpt-5.4",
  ];
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      object: "list",
      data: ids.map((id) => ({ id, object: "model", owned_by: "moonup" })),
    }),
  );
  const hooks = await MoonupPlugin();
  const auth = {
    type: "api",
    key: "sk-fixture",
    metadata: { baseURL: "https://moonup.dev" },
  };
  const models = await hooks.provider.models({}, { auth });
  assert.deepEqual(Object.keys(models), ids);
  assert.deepEqual(
    ids.map((id) => models[id].api.npm),
    [
      "@ai-sdk/anthropic",
      "@ai-sdk/openai",
      "@ai-sdk/google",
      "@ai-sdk/openai-compatible",
      "@ai-sdk/openai",
    ],
  );
  assert.equal(models["work/gpt-5.4"].api.id, "work/gpt-5.4");
  assert.equal(
    models["work/gemini-3-pro"].api.url,
    "https://moonup.dev/v1beta",
  );
  assert.deepEqual(models["gpt-6.1-sol"].capabilities, {});
});

// A legacy alias may not resemble its vendor's usual model family.
// Exact overrides select its text endpoint, while explicit server permissions and empty protocol lists remain authoritative.
test("legacy protocol overrides preserve explicit server restrictions", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      data: [
        { id: "custom-alias" },
        { id: "gpt-chat-only", protocols: ["openai_chat_completions"] },
        { id: "claude-disabled", protocols: [] },
      ],
    }),
  );
  const hooks = await MoonupPlugin(
    {},
    {
      modelProtocols: {
        "custom-alias": "anthropic_messages",
        "gpt-chat-only": "openai_responses",
        "claude-disabled": "anthropic_messages",
      },
    },
  );
  const auth = {
    type: "api",
    key: "sk-fixture",
    metadata: { baseURL: "https://moonup.dev" },
  };
  const models = await hooks.provider.models({}, { auth });
  assert.equal(models["custom-alias"].api.npm, "@ai-sdk/anthropic");
  assert.equal(models["gpt-chat-only"].api.npm, "@ai-sdk/openai-compatible");
  assert.ok(!Object.hasOwn(models, "claude-disabled"));
  await assert.rejects(
    MoonupPlugin({}, { modelProtocols: { alias: "typo" } }),
    /modelProtocols/,
  );
  await assert.rejects(
    MoonupPlugin({}, { modelProtocols: [] }),
    /modelProtocols/,
  );
});

// A zero wallet balance is a measured value rather than missing information.
// Authentication failures request sign-in, while exhausted funds keep the existing credential.
test("usage shows zero balance and separates funding from authentication failure", async (t) => {
  const fixture = await gateway(t);
  const hooks = await MoonupPlugin();
  const auth = {
    type: "api",
    key: "sk-first",
    metadata: { baseURL: fixture.base },
  };
  const usage = await hooks.auth.usage(async () => auth);
  assert.equal(usage.plan, "moonup");
  assert.equal(usage.balance, "0.00 USD");
  assert.equal(usage.signIn, "kept");
  assert.match(usage.error, /余额或订阅/);
  const invalid = { ...auth, key: "sk-invalid" };
  const failed = await hooks.auth.usage(async () => invalid);
  assert.equal(failed.signIn, "expired");
  assert.ok(!failed.error.includes("sk-invalid"));
  await assert.rejects(hooks.provider.models({}, { auth: invalid }), {
    signIn: "expired",
  });
});
