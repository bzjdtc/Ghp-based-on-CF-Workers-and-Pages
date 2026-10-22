import { buildRoute, manifestAccept, type Route } from "./routes";
import { validRegistryToken } from "./registry";

const GITHUB_HOSTS = new Set([
  "github.com", "raw.githubusercontent.com", "gist.githubusercontent.com",
  "codeload.github.com", "release-assets.githubusercontent.com",
  "objects.githubusercontent.com", "github-releases.githubusercontent.com",
]);
const GHCR_HOSTS = new Set(["ghcr.io", "pkg-containers.githubusercontent.com"]);
const GIST_HOSTS = new Set(["gist.githubusercontent.com"]);
const GIT_HOSTS = new Set(["github.com"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const HEADER_TIMEOUT_MS = 15_000;
const MAX_TOKEN_BYTES = 64 * 1024;
const MAX_TOKENS = 128;
const tokens = new Map<string, { value: string; expires: number }>();

export class UpstreamError extends Error {
  constructor(message: string, readonly status = 502, readonly registryDenied = false) { super(message); }
}

// Time out waiting for headers, while leaving large response bodies streaming.
async function fetchHeaders(url: URL, method: string, headers: Headers,
  signal: AbortSignal, body?: Uint8Array<ArrayBuffer>, noStore = false): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
  try {
    return await fetch(url.toString(), {
      method, headers, body, redirect: "manual", cache: noStore ? "no-store" : undefined,
      signal: AbortSignal.any([signal, controller.signal]),
    });
  } catch {
    throw new UpstreamError("Upstream request failed or timed out");
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRedirects(route: Route, request: Request,
  headers: Headers, body?: Uint8Array<ArrayBuffer>): Promise<Response> {
  let url = route.target;
  const allowed = route.git ? GIT_HOSTS : route.kind === "ghcr" ? GHCR_HOSTS
    : route.target.hostname === "gist.githubusercontent.com" ? GIST_HOSTS : GITHUB_HOSTS;
  const forwarded = new Headers(headers);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (url.protocol !== "https:" || url.username || url.password ||
      url.port || !allowed.has(url.hostname)) {
      throw new UpstreamError("Blocked upstream redirect");
    }
    if (route.git) {
      const redirect = buildRoute(url);
      if (redirect?.git !== route.git || redirect.repository.toLowerCase() !== route.repository.toLowerCase()) {
        throw new UpstreamError("Blocked Git upstream redirect");
      }
    }
    const response = await fetchHeaders(url, request.method, forwarded, request.signal, body, !!route.git || route.kind === "ghcr");
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get("Location");
    await response.body?.cancel();
    if (body && response.status !== 307 && response.status !== 308) {
      throw new UpstreamError("Blocked Git POST redirect");
    }
    if (!location || redirects === MAX_REDIRECTS) {
      throw new UpstreamError("Invalid or excessive upstream redirects");
    }
    let next: URL;
    try { next = new URL(location, url); }
    catch { throw new UpstreamError("Invalid upstream redirect"); }
    if (next.origin !== url.origin) forwarded.delete("Authorization");
    url = next;
  }
  throw new UpstreamError("Too many upstream redirects");
}

export async function requestRegistryToken(repository: string, signal: AbortSignal,
  authorization?: string): Promise<{ value: string; expiresIn: number }> {
  const url = new URL("https://ghcr.io/token");
  url.searchParams.set("service", "ghcr.io");
  if (repository) url.searchParams.set("scope", `repository:${repository}:pull`);
  const headers = new Headers({
    "User-Agent": "Personal-GitHub-Proxy/2.0",
  });
  // GitHub PATs are sent only to this fixed token endpoint. They are never
  // forwarded to registry manifests/blobs, redirects, or GitHub file hosts.
  if (authorization) headers.set("Authorization", authorization);
  const response = await fetchHeaders(url, "GET", headers, signal, undefined, true);
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) {
      throw new UpstreamError("GHCR authentication failed or package access denied", 403, true);
    }
    if (response.status === 429) throw new UpstreamError("GHCR rate limit exceeded", 429);
    throw new UpstreamError("GHCR token service is unavailable");
  }
  // Never follow a realm supplied by a client or an upstream challenge.
  const reader = response.body?.getReader();
  if (!reader) throw new UpstreamError("Empty GHCR token response");
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, HEADER_TIMEOUT_MS);
  const bytes = new Uint8Array(MAX_TOKEN_BYTES);
  let size = 0;
  let data: { token?: unknown; access_token?: unknown; expires_in?: unknown };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (timedOut) throw new Error("Token response timed out");
      if (done) break;
      if (size + value.byteLength > MAX_TOKEN_BYTES) { void reader.cancel().catch(() => {}); throw new Error("Oversized token response"); }
      bytes.set(value, size);
      size += value.byteLength;
    }
    data = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
  } catch {
    throw new UpstreamError("Invalid GHCR token response");
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  const token = data?.token ?? data?.access_token;
  if (typeof token !== "string" || !validRegistryToken(token)) {
    throw new UpstreamError("Invalid GHCR token");
  }
  const lifetime = typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
    ? Math.min(300, Math.floor(data.expires_in)) : 60;
  if (lifetime <= 0) throw new UpstreamError("Expired GHCR token");
  return { value: token, expiresIn: lifetime };
}

async function registryToken(repository: string, signal: AbortSignal, authorization?: string): Promise<string> {
  const { value, expiresIn } = await requestRegistryToken(repository, signal, authorization);
  // Only anonymous tokens enter the shared in-memory cache. Credentialed
  // requests obtain their own token each time, including after permission changes.
  if (!authorization) {
    if (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value!);
    tokens.set(repository, { value, expires: Date.now() + Math.max(0, expiresIn - 30) * 1000 });
  }
  return value;
}

export async function fetchUpstream(route: Route, request: Request,
  ghcrAuthorization?: string, body?: Uint8Array<ArrayBuffer>, clientToken?: string): Promise<Response> {
  const headers = new Headers({ "User-Agent": "Personal-GitHub-Proxy/2.0" });
  if (route.git) {
    headers.set("Accept", route.git === "refs" ? "application/x-git-upload-pack-advertisement"
      : "application/x-git-upload-pack-result");
    const protocol = request.headers.get("Git-Protocol");
    if (protocol) headers.set("Git-Protocol", protocol);
    if (body) {
      headers.set("Content-Type", "application/x-git-upload-pack-request");
      const encoding = request.headers.get("Content-Encoding");
      if (encoding) headers.set("Content-Encoding", encoding);
    }
    const response = await fetchRedirects(route, request, headers, body);
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new UpstreamError("GitHub repository is private or unavailable", 403);
    }
    return response;
  }
  for (const name of ["Range", "If-Range", "If-None-Match", "If-Modified-Since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (route.manifest) {
    headers.set("Accept", manifestAccept(request)!);
  }
  if (route.kind === "ghcr" && (ghcrAuthorization || clientToken)) {
    const token = clientToken ?? await registryToken(route.repository, request.signal, ghcrAuthorization);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetchRedirects(route, request, headers);
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new UpstreamError("GHCR authentication failed or package access denied", 403, true);
    }
    return response;
  }
  // Proxy credentials are never forwarded; anonymous tokens stay anonymous.
  const cachedToken = tokens.get(route.repository);
  if (route.kind === "ghcr" && cachedToken && cachedToken.expires > Date.now()) {
    headers.set("Authorization", `Bearer ${cachedToken.value}`);
  }
  let response = await fetchRedirects(route, request, headers);
  if (route.kind === "ghcr" && response.status === 401) {
    await response.body?.cancel();
    tokens.delete(route.repository);
    const token = await registryToken(route.repository, request.signal);
    headers.set("Authorization", `Bearer ${token}`);
    response = await fetchRedirects(route, request, headers);
  }
  if (route.kind === "ghcr" && (response.status === 401 || response.status === 403)) {
    await response.body?.cancel();
    throw new UpstreamError("GHCR package is private or unavailable", 403, true);
  }
  return response;
}
