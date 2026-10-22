import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions, Response: MockResponse, Log, LogLevel } = wranglerRequire("miniflare");
const { outputFiles } = await build({ entryPoints: ["src/index.ts"], bundle: true, write: false, format: "esm" });
const script = outputFiles[0].text;
export { MockResponse };
export const secret = "test-proxy-secret";
export const digest = "sha256:" + "a".repeat(64);
export const manifestType = "application/vnd.oci.image.manifest.v1+json";

export function basic(username, password) {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

export function privateHeaders(username = "alice", pat = "ghp_test_alice", proxySecret = secret) {
  return { Authorization: basic(username, `${proxySecret}:${pat}`) };
}

export function fixture(options = {}) {
  const requests = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate: "2026-08-23", cf: false,
    log: new Log(LogLevel.ERROR), ...options.server,
    bindings: { PROXY_TOKEN: secret, ALLOW_ANONYMOUS: "true", ANONYMOUS_ROUTES: "gist", ...options.bindings },
    ratelimits: options.ratelimits ?? {
      IP_RATE_LIMITER: { namespace_id: "1", simple: { limit: 10000, period: 60 } },
      TOTAL_RATE_LIMITER: { namespace_id: "2", simple: { limit: 10000, period: 60 } },
    },
    async outboundService(request) {
      const entry = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers) };
      if (request.body) {
        const bytes = await request.arrayBuffer();
        if (options.captureBody) entry.body = Buffer.from(bytes);
      }
      requests.push(entry);
      if (options.upstream) return options.upstream(request, requests);
      return new MockResponse("hello", { headers: {
        "Content-Length": "5", "ETag": '"hello"', "Cache-Control": "public, max-age=3600",
      } });
    },
  }));
  return { mf, requests, fetch(path, init = {}) {
    return mf.dispatchFetch("https://proxy.test" + path, {
      ...init, headers: { Authorization: `Bearer ${secret}`, ...init.headers },
    });
  } };
}
