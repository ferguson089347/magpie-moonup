import { createHash } from "node:crypto";

// queries.mjs reads moonup model and usage metadata with account-isolated
// request sharing. Magpie can ask several hooks for the same account while
// refreshing its provider cards. Matching requests share one in-flight fetch,
// and recently completed results remain available for a short, fixed lifetime.
// Only read-only metadata enters this cache; generation requests retain their
// own transport, cancellation, status, and streaming response.
//
// Cache identity combines a digest of the complete deployment address and
// credential with the endpoint. Each entry owns its pending result and expiration,
// and callers receive detached JSON values. Failed requests remove their
// entries, while authentication rejection clears the account's observations.
// A pending request cleared by another failure cannot repopulate its entry
// after completion. Model and usage shapes are checked before publication so
// malformed successful HTTP replies cannot hide a recovery behind the cache.
// Fixed entry and response-size limits bound retained state.

// These limits bound query lifetime, JSON size, and cached account observations.
// Model lists last thirty seconds; usage lasts five seconds for frequently refreshed cards.
const TIMEOUT_MS = 15000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 128;
const MODEL_TTL_MS = 30000;
const USAGE_TTL_MS = 5000;

/** createQueries provides account-isolated metadata reads and explicit invalidation.
 * Successful model and usage results have separate short lifetimes. Concurrent
 * reads share a request, failures are immediately retryable, and returned values
 * are cloned so hook consumers cannot mutate another caller's observation.
 * The account scope includes both the full base URL and credential; a 401 or
 * explicit clear invalidates every endpoint for that account. Cleared pending
 * entries may finish for existing callers but cannot become cached again.
 */
export function createQueries() {
  const entries = new Map();

  /** clear invalidates cached and pending metadata for the supplied account.
   * Existing fetches are allowed to finish for their original callers. Their
   * detached entries cannot publish success back into the active cache map.
   */
  function clear(account) {
    const scope = scopeOf(account);
    for (const [id, entry] of entries) {
      if (entry.scope === scope) entries.delete(id);
    }
  }

  return {
    clear,
    /** get reads one account's model or usage JSON with bounded result reuse.
     * The path must be one of the two plugin metadata endpoints. A new request
     * replaces an expired entry, and the least recently inserted entry is
     * removed when the cache reaches its count limit. HTTP failures retain
     * their sign-in classification. HTTP and payload-validation failures stay
     * uncached, including malformed entries inside an otherwise valid model
     * list. Shared pending results stay detached from entries invalidated by
     * credential rejection.
     */
    async get(account, path) {
      if (!["/v1/models?include=capabilities", "/v1/usage"].includes(path)) {
        throw new Error("不支持此 moonup 元数据接口。");
      }
      const scope = scopeOf(account);
      const id = scope + ":" + path;
      const cached = entries.get(id);
      if (cached && (cached.pending || cached.expires > Date.now())) {
        return structuredClone(await cached.promise);
      }
      const entry = { scope, pending: true, expires: 0 };
      entry.promise = readJSON(account, path)
        .then((value) => {
          validateMetadata(value, path);
          // Entries are stored before fetch settles. An invalidated request can
          // still answer existing callers, but its result never recreates the removed cache entry.
          entry.pending = false;
          entry.expires =
            Date.now() + (path === "/v1/usage" ? USAGE_TTL_MS : MODEL_TTL_MS);
          return value;
        })
        .catch((error) => {
          // Credential rejection affects all metadata for one account. Other
          // failures remove only their own still-current entry so a replacement request survives.
          if (error.signIn === "expired") clear(account);
          else if (entries.get(id) === entry) entries.delete(id);
          throw error;
        });
      entries.delete(id);
      entries.set(id, entry);
      while (entries.size > MAX_ENTRIES)
        entries.delete(entries.keys().next().value);
      return structuredClone(await entry.promise);
    },
  };
}

/** validateMetadata rejects malformed model and usage observations before caching.
 * An empty model array is valid, while a malformed entry rejects the whole
 * response so a partial catalogue cannot replace the host's previous list.
 * Missing model protocols retain the server-upgrade explanation. Usage mode,
 * funding objects, and spending-window rows follow the public response shape;
 * absent optional amounts remain unknown for the usage presentation layer.
 */
function validateMetadata(value, path) {
  const object =
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (path === "/v1/models?include=capabilities") {
    if (!object || !Array.isArray(value.data)) {
      throw new Error("moonup 返回的模型列表格式无效，请稍后刷新重试。");
    }
    const ids = new Set();
    for (const model of value.data) {
      if (
        !model ||
        typeof model !== "object" ||
        Array.isArray(model) ||
        typeof model.id !== "string" ||
        !model.id.trim() ||
        ids.has(model.id)
      ) {
        throw new Error("moonup 返回的模型条目格式无效，请稍后刷新重试。");
      }
      if (!Array.isArray(model.protocols)) {
        throw new Error("请升级 moonup 服务端，以支持插件自动识别模型协议。");
      }
      if (
        model.protocols.some(
          (protocol) => typeof protocol !== "string" || !protocol,
        )
      ) {
        throw new Error("moonup 返回的模型协议格式无效，请稍后刷新重试。");
      }
      if (
        model.native_protocols != null &&
        (!Array.isArray(model.native_protocols) ||
          model.native_protocols.some(
            (protocol) => typeof protocol !== "string" || !protocol,
          ))
      ) {
        throw new Error("moonup 返回的模型协议格式无效，请稍后刷新重试。");
      }
      const attributes = model.attributes;
      if (
        (model.display_name != null &&
          typeof model.display_name !== "string") ||
        (attributes != null &&
          (typeof attributes !== "object" || Array.isArray(attributes))) ||
        (attributes?.reasoning_options != null &&
          (!Array.isArray(attributes.reasoning_options) ||
            attributes.reasoning_options.some(
              (option) =>
                !option || typeof option !== "object" || Array.isArray(option),
            )))
      ) {
        throw new Error("moonup 返回的模型能力格式无效，请稍后刷新重试。");
      }
      ids.add(model.id);
    }
    return;
  }
  if (!object || !["unrestricted", "quota_limited"].includes(value.mode)) {
    throw new Error("moonup 返回的额度信息格式无效，请稍后刷新重试。");
  }
  for (const name of ["billing", "subscription", "quota"]) {
    const field = value[name];
    if (field != null && (typeof field !== "object" || Array.isArray(field))) {
      throw new Error("moonup 返回的额度信息格式无效，请稍后刷新重试。");
    }
  }
  if (
    value.rate_limits != null &&
    (!Array.isArray(value.rate_limits) ||
      value.rate_limits.some(
        (row) =>
          !row ||
          typeof row !== "object" ||
          Array.isArray(row) ||
          typeof row.window !== "string" ||
          !row.window,
      ))
  ) {
    throw new Error("moonup 返回的额度窗口格式无效，请稍后刷新重试。");
  }
}

/** scopeOf derives a cache identity from one deployment and complete credential.
 * Digests keep raw Keys out of map keys. The identity is private process state
 * and is neither displayed nor persisted as an account identifier.
 */
function scopeOf(account) {
  return createHash("sha256")
    .update(account.base + "\0" + account.key)
    .digest("hex");
}

/** readJSON fetches and decodes one metadata response under a single deadline.
 * Redirects are refused, declared and observed sizes are bounded, and errors
 * use fixed text rather than reflecting the response body. Only a returned
 * HTTP 401 marks the saved credential expired; timeout and other failures keep it.
 */
async function readJSON(account, path) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let response;
  try {
    response = await fetch(account.base + path, {
      headers: {
        Authorization: `Bearer ${account.key}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal,
    });
  } catch {
    // Network exceptions can contain redirect URLs or proxy details. Fixed
    // messages distinguish the query deadline without reflecting those potentially private values.
    throw new Error(
      signal.aborted
        ? "moonup 查询超时，请稍后重试。"
        : "无法连接 moonup，请检查站点地址、网络和代理。",
    );
  }
  if (!response.ok) {
    // Rejected metadata bodies are not used by hook consumers. Release them
    // before reporting the fixed status message so repeated refreshes do not retain connections.
    await response.body?.cancel().catch(() => undefined);
    const messages = {
      401: "API key 无效，请重新添加。",
      403: "此 API key 无权访问，请检查密钥和分组权限。",
      429: "查询过于频繁，请稍后重试。",
    };
    throw Object.assign(
      new Error(
        messages[response.status] ||
          `moonup 查询失败（HTTP ${response.status}）。`,
      ),
      {
        signIn: response.status === 401 ? "expired" : "kept",
      },
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("moonup 返回了空的查询响应。");
  try {
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
      throw new Error("moonup 查询响应过大，请联系管理员检查模型目录。");
    }
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_BYTES)
        throw new Error("moonup 查询响应过大，请联系管理员检查模型目录。");
      text += decoder.decode(result.value, { stream: true });
    }
    try {
      return JSON.parse(text + decoder.decode());
    } catch {
      // Frontend HTML or truncated JSON cannot supply metadata. Keep its
      // content private while explaining which saved configuration the user should check.
      throw new Error(
        "moonup 未返回有效 JSON，请检查是否填写了正确的 API 地址。",
      );
    }
  } catch (error) {
    // Body reads share the fetch deadline. Convert its cancellation into the
    // same actionable timeout message used before response headers arrive.
    if (signal.aborted) throw new Error("moonup 查询超时，请稍后重试。");
    throw error;
  } finally {
    // A complete read releases its lock; a size, timeout, or decode failure
    // also cancels the unread remainder so the connection can finish its cleanup.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
