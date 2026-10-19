import { buildRoute, repositoryAllowed, manifestAccept, type Route } from "./routes";
import { fetchUpstream, UpstreamError } from "./upstream";
import { authorize, type Access } from "./auth";

interface Env {
  PROXY_TOKEN?: string;
  ALLOW_ANONYMOUS?: string;
  ANONYMOUS_ROUTES?: string;
  ALLOWED_GITHUB_REPOSITORIES?: string;
  ALLOWED_GHCR_REPOSITORIES?: string;
  IP_RATE_LIMITER: RateLimit;
  TOTAL_RATE_LIMITER: RateLimit;
}

const MAX_CACHE_BYTES = 1024 * 1024;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Range, Authorization, X-GHCR-Authorization, Content-Type, Accept, If-None-Match, If-Modified-Since",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified, Docker-Content-Digest, Docker-Distribution-Api-Version, WWW-Authenticate, Retry-After",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      // Avoid logging attacker-triggered upstream failures or signed URLs/secrets.
      return jsonResponse({ error: error instanceof UpstreamError
        ? error.message : "Internal proxy error" }, error instanceof UpstreamError ? error.status : 500);
    }
  },
};

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET, HEAD, OPTIONS" });
  }
  if (url.pathname === "/" || url.pathname === "/health") {
    return new Response(request.method === "HEAD" ? null : "GitHub / GHCR Proxy OK\n", {
      headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (url.href.length > 8192) return jsonResponse({ error: "URL too long" }, 414);
  if (!env.IP_RATE_LIMITER || !env.TOTAL_RATE_LIMITER) {
    return jsonResponse({ error: "Proxy rate limit bindings are not configured" }, 503);
  }
  const { success } = await env.IP_RATE_LIMITER.limit({
    key: request.headers.get("CF-Connecting-IP") ?? "unknown",
  });
  if (!success) return rateLimited();

  const route = buildRoute(url);
  // Only validated route types can opt out of proxy authentication. Both the
  // switch and an exact list entry are required; missing settings fail closed.
  const anonymous = !!route && env.ALLOW_ANONYMOUS === "true" &&
    (env.ANONYMOUS_ROUTES ?? "").split(",").some(type => type.trim() === route.type);
  if (!anonymous && !env.PROXY_TOKEN) {
    return jsonResponse({ error: "Configure PROXY_TOKEN before using the proxy" }, 503);
  }
  const access: Access = await authorize(request, env.PROXY_TOKEN, route?.kind === "ghcr", anonymous);
  if (!access.authorized) {
    return jsonResponse({ error: "Unauthorized" }, 401, {
      "WWW-Authenticate": 'Basic realm="GitHub / GHCR Proxy", charset="UTF-8"',
      "Docker-Distribution-Api-Version": "registry/2.0",
    });
  }

  if (access.error) return jsonResponse({ error: access.error }, 400);
  if (!route) return jsonResponse({ error: "Unsupported GitHub / GHCR download URL" }, 404);
  const allowlist = route.kind === "ghcr"
    ? env.ALLOWED_GHCR_REPOSITORIES : env.ALLOWED_GITHUB_REPOSITORIES;
  if (!repositoryAllowed(route, allowlist)) {
    return jsonResponse({ error: "Repository is not allowed" }, 403);
  }
  if (route.manifest && !manifestAccept(request)) {
    return jsonResponse({ error: "Unsupported manifest media type" }, 406);
  }
  const total = await env.TOTAL_RATE_LIMITER.limit({ key: "all-downloads" });
  if (!total.success) return rateLimited();
  if (route.ping && !access.ghcrAuthorization) {
    return new Response(request.method === "HEAD" ? null : "{}", {
      headers: { ...CORS_HEADERS, "Docker-Distribution-Api-Version": "registry/2.0",
        "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const range = request.headers.get("Range");
  // Multipart ranges multiply work at the origin. Keep resumable downloads.
  if (range !== null && !/^bytes=(?:\d{1,20}-\d{0,20}|-\d{1,20})$/.test(range)) {
    return jsonResponse({ error: "Only one byte range is supported" }, 416);
  }
  // Credentialed GHCR reads must always reach GHCR for authorization. They
  // cannot read public cache entries or write private bytes into that cache.
  if (access.ghcrAuthorization) {
    return clientResponse(await fetchUpstream(route, request, access.ghcrAuthorization), request, route);
  }
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const key = cacheKey(url.origin, route, request);
  // The Cache API handles conditional GET and byte ranges, but not If-Range.
  const lookup = new Request(key, { headers: cacheRequestHeaders(request) });
  const cached = request.headers.has("If-Range") ? undefined : await cache.match(lookup);
  if (cached) return clientResponse(cached, request, route);

  const response = await fetchUpstream(route, request);
  if (request.method === "GET" && !range && response.status === 200 && cacheable(response)) {
    // Read at most a bounded prefix. Large/unknown-size downloads never get
    // cloned or consumed by background work after the client disconnects.
    const { body, complete } = await boundedBody(response);
    const result = new Response(body, response);
    if (complete) {
      const storedHeaders = new Headers(response.headers);
      storedHeaders.delete("Set-Cookie");
      storedHeaders.delete("Vary"); // Accept is explicitly part of the cache key.
      storedHeaders.set("Cache-Control", `public, max-age=${route.ttl}`);
      ctx.waitUntil(cache.put(key, new Response(body, { headers: storedHeaders })).catch(() => {}));
    }
    return clientResponse(result, request, route);
  }
  return clientResponse(response, request, route);
}

function cacheKey(origin: string, route: Route, request: Request): Request {
  const key = new URL("/__proxy_cache_v2/" + route.target.hostname + route.target.pathname, origin);
  if (route.manifest) key.searchParams.set("accept", manifestAccept(request)!);
  return new Request(key, { method: "GET" });
}

function cacheRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of ["Range", "If-None-Match", "If-Modified-Since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function cacheable(response: Response): boolean {
  const length = response.headers.get("Content-Length");
  return length !== null && /^\d+$/.test(length) && Number(length) <= MAX_CACHE_BYTES &&
    !response.headers.has("Content-Encoding") && !response.headers.has("Set-Cookie") &&
    !/\b(?:private|no-store|no-cache)\b/i.test(response.headers.get("Cache-Control") ?? "") &&
    !(response.headers.get("Vary") ?? "").split(",").some(name =>
      name.trim() !== "" && name.trim().toLowerCase() !== "accept");
}

async function boundedBody(response: Response): Promise<{
  body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> | null; complete: boolean;
}> {
  if (!response.body) return { body: null, complete: true };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        reader.releaseLock();
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
        return { body, complete: true };
      }
      chunks.push(value);
      size += value.byteLength;
      if (size > MAX_CACHE_BYTES || chunks.length > 1024) {
        return { complete: false, body: new ReadableStream({
          start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) { reader.releaseLock(); controller.close(); }
              else controller.enqueue(next.value);
            } catch (error) { controller.error(error); }
          },
          cancel(reason) { return reader.cancel(reason); },
        }) };
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    throw error;
  }
}

function clientResponse(response: Response, request: Request, route: Route): Response {
  const result = new Response(request.method === "HEAD" ? null : response.body, response);
  result.headers.delete("Set-Cookie");
  result.headers.delete("WWW-Authenticate");
  // Protected downloads must never become public URLs in a downstream cache.
  result.headers.set("Cache-Control", "private, no-store");
  result.headers.set("X-Content-Type-Options", "nosniff");
  if (route.kind === "ghcr") result.headers.set("Docker-Distribution-Api-Version", "registry/2.0");
  if (result.status === 206) result.headers.set("Accept-Ranges", "bytes");
  for (const [key, value] of Object.entries(CORS_HEADERS)) result.headers.set(key, value);
  return result;
}

function rateLimited(): Response {
  return jsonResponse({ error: "Rate limit exceeded" }, 429, { "Retry-After": "60" });
}

function jsonResponse(data: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: {
    ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store", ...headers,
  } });
}
