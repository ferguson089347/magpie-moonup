// usage.mjs maps moonup funding observations to Magpie allowance windows.
// A Key's own quota and spending limits can coexist with subscription funding;
// every applicable limit contributes a separate window instead of hiding the
// funding source behind the quota_limited response mode.
//
// Only server-reported reset times are used because subscription windows roll
// according to the server's calendar and billing rules. Wallet amounts remain
// balances rather than invented percentage windows. Invalid credentials are
// handled by the caller; exhausted funds and expired plans retain their sign-in
// so users can restore access by topping up or renewing the existing account.
// Provider summaries include measured wallet amounts, and legacy unrestricted
// wallet responses can supply remaining when no explicit balance is present.

// SPANS names the server's spending windows and converts their documented
// durations into the seconds expected by Magpie's usage and routing interface.
const DAY_SECONDS = 86400;
const SPANS = {
  "5h": ["密钥 5 小时限额", 5 * 3600],
  "1d": ["密钥 24 小时限额", DAY_SECONDS],
  "7d": ["密钥 7 天限额", 7 * DAY_SECONDS],
};

/** usageOf combines independent Key limits with the resolved funding source.
 * The caller supplies /v1/usage JSON. Zero balances and explicit unavailable
 * funding remain visible; missing or malformed usage values never become zero.
 * Subscription and Key expiration are checked independently of response mode.
 * A quota-limited response may still use a subscription, so its counters are
 * combined with Key windows instead of choosing one family. Reset timestamps
 * are accepted only from the server and are never reconstructed from anchors.
 * Wallet summaries include the measured amount; only unrestricted wallet
 * responses may use remaining, because quota responses assign that field to
 * the Key's own limit. Missing amounts remain distinct from an observed zero.
 */
export function usageOf(body, now = Date.now()) {
  if (
    !body ||
    typeof body !== "object" ||
    !["unrestricted", "quota_limited"].includes(body.mode)
  ) {
    throw new Error("moonup 返回的额度信息格式无效。");
  }
  const billing = body.billing || {};
  const subscription = body.subscription;
  const unit = billing.unit || body.unit || body.quota?.unit || "USD";
  const subscriptionFunded =
    billing.source === "subscription" || (!billing.source && subscription);
  // Legacy unrestricted responses use remaining for wallet funds; quota-limited
  // responses use it for Key allowance, which cannot identify the account balance.
  const legacyWallet =
    body.mode === "unrestricted" && !subscriptionFunded && !body.quota;
  const balance = numberOf(
    body.balance ??
      billing.balance ??
      (legacyWallet ? body.remaining : undefined),
  );
  const balanceText = balance === undefined ? undefined : money(balance, unit);
  let plan;
  if (subscriptionFunded) {
    plan = billing.plan_name || body.planName || "订阅套餐";
  } else if (balanceText !== undefined) {
    plan = `余额 ${balanceText}`;
  } else {
    plan = body.mode === "quota_limited" ? "密钥额度" : "余额未返回";
  }
  const out = {
    plan,
    windows: [],
    signIn: "kept",
  };
  const quota = windowOf(
    "密钥总额度",
    body.quota?.used,
    body.quota?.limit,
    unit,
  );
  if (quota) out.windows.push(quota);
  for (const row of Array.isArray(body.rate_limits) ? body.rate_limits : []) {
    // Unknown server windows retain their label and measured amounts, while
    // only known periods contribute a duration; object prototype properties are not window definitions.
    const [name, span] = (Object.hasOwn(SPANS, row.window)
      ? SPANS[row.window]
      : undefined) || [String(row.window || "Key window"), undefined];
    const window = windowOf(
      name,
      row.used,
      row.limit,
      unit,
      span,
      row.reset_at,
    );
    if (window) out.windows.push(window);
  }
  if (subscriptionFunded) {
    // Billing uses seven-day weeks and thirty-day months. Daily resets depend
    // on the server calendar, so span alone never supplies a reset timestamp.
    for (const [field, label, span] of [
      ["daily", "每日额度", DAY_SECONDS],
      ["weekly", "每周额度", 7 * DAY_SECONDS],
      ["monthly", "每月额度", 30 * DAY_SECONDS],
    ]) {
      const window = windowOf(
        label,
        subscription?.[field + "_usage_usd"],
        subscription?.[field + "_limit_usd"],
        unit,
        span,
        subscription?.[field + "_reset_at"],
      );
      if (window) out.windows.push(window);
    }
    if (
      !subscription ||
      subscription.available === false ||
      (subscription.status && subscription.status !== "active")
    ) {
      out.error = "订阅不可用，请在站点检查套餐状态。";
    }
  } else {
    if (balanceText !== undefined) out.balance = balanceText;
  }
  // Both expirations constrain the same Key. Display the earlier valid end
  // time, so a long-lived plan cannot conceal a Key that expires first.
  const endings = [body.expires_at, subscription?.expires_at]
    .filter(
      (value) =>
        typeof value === "string" && Number.isFinite(Date.parse(value)),
    )
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  if (endings.length) out.until = endings[0];
  if (
    body.status === "expired" ||
    (out.until && Date.parse(out.until) <= now)
  ) {
    out.error = "密钥或订阅已到期，请在站点续期。";
  } else if (body.status === "quota_exhausted") {
    out.error = "API key 总额度已用完，请在站点调整额度。";
  } else if (
    !out.error &&
    (billing.available === false || body.isValid === false) &&
    !out.windows.some((window) => window.used >= 100)
  ) {
    // Magpie replaces windows with error text. Keep measured exhausted windows
    // visible instead of concealing their counters behind a generic funding message.
    out.error = "当前扣费来源不可用，请在站点检查余额或订阅。";
  }
  return out;
}

/** money formats an observed amount for readable balance and quota summaries.
 * Ordinary amounts use two decimal places. Positive sub-cent amounts retain
 * up to six decimals, and still smaller values receive a less-than label
 * so a usable balance never appears to be an observed zero.
 */
function money(value, unit) {
  // Balances below six-decimal precision remain visibly positive.
  if (value > 0 && value < 0.000001) return `<0.000001 ${unit}`;
  // Small positive balances remain visible even below the normal cent display.
  const amount =
    value > 0 && value < 0.01
      ? value.toFixed(6).replace(/0+$/, "")
      : value.toFixed(2);
  return `${amount} ${unit}`;
}

/** numberOf accepts finite JSON numbers and nonempty numeric strings only.
 * Null, booleans, and absent values remain unknown so failed observations
 * cannot be presented as an unused allowance or an observed zero balance.
 */
function numberOf(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim()))
    return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** windowOf formats a measured allowance or omits an unknown, unlimited window.
 * A positive limit and nonnegative measured usage are required. Percentages
 * can exceed one hundred, and reset times are copied only when parseable.
 */
function windowOf(name, used, limit, unit, span, resetsAt) {
  const amount = numberOf(used);
  const maximum = numberOf(limit);
  if (
    amount === undefined ||
    amount < 0 ||
    maximum === undefined ||
    maximum <= 0
  )
    return undefined;
  // Magpie reads percentages for routing and retains amount/limit for exact
  // display; rounding only the text preserves overspending in the routing value.
  const result = {
    name,
    used: (amount / maximum) * 100,
    amount,
    limit: maximum,
    unit,
    display: `${amount.toFixed(2)} / ${maximum.toFixed(2)} ${unit}`,
  };
  if (span) result.span = span;
  if (typeof resetsAt === "string" && Number.isFinite(Date.parse(resetsAt)))
    result.resetsAt = resetsAt;
  return result;
}
