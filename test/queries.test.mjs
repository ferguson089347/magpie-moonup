import assert from "node:assert/strict";
import test from "node:test";
import { createQueries } from "../queries.mjs";

// queries.test.mjs checks account isolation and refresh behavior through the
// query module's public methods. Controlled fetch promises and a fixed clock
// exercise concurrent reads, short result lifetimes, failure recovery, and
// invalidation while earlier requests are still completing.

// ACCOUNT and MODEL_PATH identify one synthetic credential and its read-only
// catalogue endpoint; individual tests vary the account or endpoint deliberately.
const ACCOUNT = { base: "https://moonup.dev", key: "sk-fixture" };
const MODEL_PATH = "/v1/models?include=capabilities";

// Several hooks can request one account's models before the first query completes.
// They share one fetch and receive detached results that cannot contaminate another caller's metadata.
test("concurrent reads share one request and return independent values", async (t) => {
  let finish;
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const queries = createQueries();
  const first = queries.get(ACCOUNT, MODEL_PATH);
  const second = queries.get(ACCOUNT, MODEL_PATH);
  assert.equal(calls, 1);
  finish(
    Response.json({ data: [{ id: "model", protocols: ["openai_responses"] }] }),
  );
  const [left, right] = await Promise.all([first, second]);
  left.data[0].id = "changed";
  assert.equal(right.data[0].id, "model");
  assert.equal((await queries.get(ACCOUNT, MODEL_PATH)).data[0].id, "model");
  assert.equal(calls, 1);
});

// Identical model names can belong to different Keys or deployment paths.
// The cache separates those accounts and keeps usage observations independent from model catalogues.
test("cache identity includes site path, complete Key, and endpoint", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls++;
    return Response.json({
      data: [],
      mode: "unrestricted",
      url,
      credential: options.headers.Authorization,
    });
  });
  const queries = createQueries();
  const requests = [
    [ACCOUNT, MODEL_PATH],
    [{ ...ACCOUNT, key: "sk-other" }, MODEL_PATH],
    [{ ...ACCOUNT, base: ACCOUNT.base + "/deployment" }, MODEL_PATH],
    [ACCOUNT, "/v1/usage"],
  ];
  const results = await Promise.all(
    requests.map(([account, path]) => queries.get(account, path)),
  );
  assert.equal(calls, 4);
  assert.notEqual(results[0].credential, results[1].credential);
  assert.notEqual(results[0].url, results[2].url);
  assert.notEqual(results[0].url, results[3].url);
});

// Model and usage cards refresh at different rates while one account remains signed in.
// Usage expires after five seconds and model metadata expires after thirty seconds.
test("successful metadata has separate short lifetimes", async (t) => {
  let now = 10000;
  let calls = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ data: [], mode: "unrestricted", sequence: ++calls }),
  );
  const queries = createQueries();
  await queries.get(ACCOUNT, MODEL_PATH);
  await queries.get(ACCOUNT, "/v1/usage");
  now += 5000;
  await queries.get(ACCOUNT, MODEL_PATH);
  await queries.get(ACCOUNT, "/v1/usage");
  assert.equal(calls, 3);
  now += 25000;
  await queries.get(ACCOUNT, MODEL_PATH);
  assert.equal(calls, 4);
});

// A Key rejected by the backend must stop reusing its earlier successful metadata.
// Invalidating that account leaves another account's observations intact and marks only the returned 401 expired.
test("401 clears every endpoint for the rejected account", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls++;
    if (url.endsWith("/usage"))
      return new Response("do not reflect sk-private", { status: 401 });
    return Response.json({ data: [] });
  });
  const queries = createQueries();
  const other = { ...ACCOUNT, key: "sk-other" };
  await queries.get(ACCOUNT, MODEL_PATH);
  await queries.get(other, MODEL_PATH);
  await assert.rejects(queries.get(ACCOUNT, "/v1/usage"), (error) => {
    assert.equal(error.signIn, "expired");
    assert.ok(!error.message.includes("sk-private"));
    return true;
  });
  await queries.get(other, MODEL_PATH);
  await queries.get(ACCOUNT, MODEL_PATH);
  assert.equal(calls, 4);
});

// A generation rejection can invalidate metadata while its earlier catalogue request is still pending.
// The pending result answers its original caller but cannot refill the cleared cache.
test("invalidated in-flight requests do not repopulate the cache", async (t) => {
  let finish;
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    if (calls === 1)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return Promise.resolve(Response.json({ data: [], sequence: calls }));
  });
  const queries = createQueries();
  const first = queries.get(ACCOUNT, MODEL_PATH);
  queries.clear(ACCOUNT);
  const second = await queries.get(ACCOUNT, MODEL_PATH);
  finish(Response.json({ data: [], sequence: 1 }));
  assert.equal((await first).sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal((await queries.get(ACCOUNT, MODEL_PATH)).sequence, 2);
  assert.equal(calls, 2);
});

// Temporary backend failures and malformed replies can recover on the next refresh.
// Failed queries remain uncached and a later valid response succeeds without a new sign-in.
test("failed queries are immediately retryable", async (t) => {
  const replies = [
    () => new Response("busy", { status: 503 }),
    () => new Response("<html>private-page</html>"),
    () => Response.json({ data: [] }),
  ];
  t.mock.method(globalThis, "fetch", async () => replies.shift()());
  const queries = createQueries();
  await assert.rejects(queries.get(ACCOUNT, MODEL_PATH), { signIn: "kept" });
  await assert.rejects(queries.get(ACCOUNT, MODEL_PATH), /有效 JSON/);
  assert.deepEqual(await queries.get(ACCOUNT, MODEL_PATH), { data: [] });
});

// Both an oversized declared length and oversized streamed JSON can exhaust a metadata reader.
// The query rejects each case and cancels its response instead of retaining an unbounded model catalogue.
test("metadata size limits cover declared and streamed bytes", async (t) => {
  const responses = [
    new Response("{}", {
      headers: { "content-length": String(5 * 1024 * 1024) },
    }),
    new Response('"' + "x".repeat(4 * 1024 * 1024) + '"'),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  const queries = createQueries();
  await assert.rejects(queries.get(ACCOUNT, MODEL_PATH), /响应过大/);
  await assert.rejects(queries.get(ACCOUNT, MODEL_PATH), /响应过大/);
});

// A query can exhaust its deadline after receiving response headers but before finishing JSON.
// The reader reports an actionable timeout and removes the failed entry so a later refresh can recover.
test("body deadline failures use the query timeout message", async (t) => {
  t.mock.method(AbortSignal, "timeout", () =>
    AbortSignal.abort(new DOMException("private-detail", "TimeoutError")),
  );
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
  const queries = createQueries();
  await assert.rejects(queries.get(ACCOUNT, MODEL_PATH), (error) => {
    assert.match(error.message, /查询超时/);
    assert.ok(!error.message.includes("private-detail"));
    return true;
  });
});

// A successful HTTP response can contain a broken catalogue while the backend recovers immediately afterward.
// Malformed entries reject the complete refresh and remain uncached, so the next valid list is available immediately.
test("malformed model payloads do not become cached empty or partial catalogues", async (t) => {
  const invalid = [
    null,
    {},
    { data: [null] },
    { data: [{ id: "bad" }] },
    { data: [{ id: "bad", protocols: [null] }] },
    { data: [{ id: "bad", protocols: [], native_protocols: [null] }] },
    {
      data: [
        { id: "bad", protocols: [], attributes: { reasoning_options: [null] } },
      ],
    },
    { data: [{ id: "bad", protocols: [], display_name: {} }] },
    {
      data: [
        { id: "duplicate", protocols: [] },
        { id: "duplicate", protocols: [] },
      ],
    },
  ];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    const body =
      calls % 2 === 0
        ? invalid[Math.floor(calls / 2)]
        : { data: [{ id: "recovered", protocols: ["openai_responses"] }] };
    calls++;
    return Response.json(body);
  });
  const queries = createQueries();
  for (let index = 0; index < invalid.length; index++) {
    queries.clear(ACCOUNT);
    await assert.rejects(queries.get(ACCOUNT, MODEL_PATH), /格式无效|升级/);
    assert.equal(
      (await queries.get(ACCOUNT, MODEL_PATH)).data[0].id,
      "recovered",
    );
  }
  assert.equal(calls, invalid.length * 2);
});

// Usage metadata may be syntactically valid JSON while its mode or window rows are malformed.
// Those replies cannot persist for the usage cache lifetime, and a repaired response succeeds on the next refresh.
test("malformed usage metadata can recover on the next refresh", async (t) => {
  const invalid = [
    {},
    { mode: "unrestricted", billing: [] },
    { mode: "quota_limited", rate_limits: [null] },
    { mode: "quota_limited", rate_limits: [{ window: {} }] },
  ];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    const body =
      calls % 2 === 0
        ? invalid[Math.floor(calls / 2)]
        : { mode: "unrestricted", balance: 10 };
    calls++;
    return Response.json(body);
  });
  const queries = createQueries();
  for (let index = 0; index < invalid.length; index++) {
    queries.clear(ACCOUNT);
    await assert.rejects(queries.get(ACCOUNT, "/v1/usage"), /格式无效/);
    assert.equal((await queries.get(ACCOUNT, "/v1/usage")).balance, 10);
  }
});
