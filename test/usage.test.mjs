import assert from "node:assert/strict";
import test from "node:test";
import { usageOf } from "../usage.mjs";

// usage.test.mjs checks how funding and Key limits interact in Magpie cards.
// The fixtures retain unknown measurements, independent subscription limits,
// and separate credential status so the plugin cannot invent usable allowance.

// A subscription-funded Key may also have lifetime and rolling spending limits.
// All constraints remain visible, with the earlier expiration and the configured unit preserved.
test("subscription funding and Key limits appear together", () => {
  const result = usageOf(
    {
      mode: "quota_limited",
      status: "active",
      expires_at: "2030-01-01T00:00:00Z",
      billing: {
        source: "subscription",
        plan_name: "Pro",
        available: true,
        unit: "credits",
      },
      quota: { used: 20, limit: 100 },
      rate_limits: [
        { window: "5h", used: 2, limit: 10, reset_at: "2029-12-02T00:00:00Z" },
      ],
      subscription: {
        status: "active",
        expires_at: "2031-01-01T00:00:00Z",
        daily_usage_usd: 3,
        daily_limit_usd: 20,
        weekly_usage_usd: 10,
        weekly_limit_usd: 100,
        monthly_usage_usd: 25,
        monthly_limit_usd: 300,
      },
    },
    Date.parse("2029-12-01T00:00:00Z"),
  );
  assert.equal(result.plan, "Pro");
  assert.equal(result.windows.length, 5);
  assert.equal(result.windows[0].used, 20);
  assert.equal(result.windows[0].unit, "credits");
  assert.equal(result.windows[1].resetsAt, "2029-12-02T00:00:00Z");
  assert.equal(result.windows[2].resetsAt, undefined);
  assert.equal(result.until, "2030-01-01T00:00:00Z");
  assert.equal(result.error, undefined);
});

// Missing counters must not look like unused limits, while overspending remains above one hundred percent.
// Null measurements are omitted and a real exhausted window remains observable to routing.
test("unknown counters remain unknown and overspending remains measured", () => {
  const result = usageOf({
    mode: "quota_limited",
    billing: { source: "balance", available: false },
    quota: { used: null, limit: 100 },
    rate_limits: [
      { window: "1d", used: "12", limit: 10 },
      { window: "7d", used: false, limit: 100 },
    ],
  });
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].used, 120);
  assert.equal(result.error, undefined);
});

// An unavailable grant can have no counters, and an expired Key can otherwise show a valid wallet.
// Both conditions produce actionable funding errors without asking the user to replace credentials.
test("unavailable subscriptions and expired Keys retain their sign-in", () => {
  for (const body of [
    {
      mode: "unrestricted",
      billing: { source: "subscription", available: false },
      subscription: { available: false },
    },
    { mode: "quota_limited", status: "expired", balance: 20 },
    {
      mode: "quota_limited",
      status: "quota_exhausted",
      quota: { used: 10, limit: 10 },
    },
  ]) {
    const result = usageOf(body);
    assert.equal(typeof result.error, "string");
    assert.equal(result.signIn, "kept");
  }
  assert.throws(() => usageOf({}), /格式无效/);
});

// Backends can introduce spending-window names beyond the plugin's three duration labels.
// Unknown names, including object-property spellings, retain their measured amounts without inventing a reset duration.
test("unrecognized spending windows remain displayable", () => {
  const result = usageOf({
    mode: "quota_limited",
    rate_limits: [
      { window: "constructor", used: 1, limit: 10 },
      { window: "__proto__", used: 2, limit: 10 },
      { window: "custom", used: 3, limit: 10 },
    ],
  });
  assert.deepEqual(
    result.windows.map((window) => window.name),
    ["constructor", "__proto__", "custom"],
  );
  assert.ok(result.windows.every((window) => window.span === undefined));
});

// Wallet providers often name the funding mode without showing its measured amount in Magpie's summary.
// Explicit balances and legacy unrestricted remaining values both produce readable amounts, including an observed zero.
test("wallet summaries show concrete amounts from current and legacy responses", () => {
  const bodies = [
    { mode: "unrestricted", balance: 12.34, planName: "钱包余额" },
    { mode: "unrestricted", remaining: 12.34, planName: "钱包余额" },
    { mode: "unrestricted", billing: { source: "balance", balance: 12.34 } },
  ];
  for (const body of bodies) {
    const usage = usageOf(body);
    assert.equal(usage.plan, "余额 12.34 USD");
    assert.equal(usage.balance, "12.34 USD");
  }
  assert.equal(
    usageOf({ mode: "unrestricted", remaining: 0 }).plan,
    "余额 0.00 USD",
  );
  assert.equal(usageOf({ mode: "unrestricted" }).plan, "余额未返回");
});

// Key-limited responses can use remaining for the Key quota while the wallet amount stays unknown.
// The summary distinguishes that limit from wallet funding and never labels the Key's remainder as account balance.
test("Key quota remaining is not displayed as wallet balance", () => {
  const usage = usageOf({
    mode: "quota_limited",
    remaining: 90,
    quota: { limit: 100, used: 10 },
  });
  assert.equal(usage.plan, "密钥额度");
  assert.equal(usage.balance, undefined);
  assert.equal(usage.windows[0].name, "密钥总额度");
});

// A positive sub-cent balance can still pay for requests even though ordinary two-decimal formatting rounds it to zero.
// The summary retains small measured amounts and uses an explicit threshold label below the display precision.
test("small positive balances remain visible", () => {
  assert.equal(
    usageOf({ mode: "unrestricted", balance: 0.004 }).balance,
    "0.004 USD",
  );
  assert.equal(
    usageOf({ mode: "unrestricted", balance: 0.0000001 }).balance,
    "<0.000001 USD",
  );
});
