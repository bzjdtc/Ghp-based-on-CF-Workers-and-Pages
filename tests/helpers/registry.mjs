import { fixture, basic, MockResponse } from "./runtime.mjs";
import { createHash } from "node:crypto";

const manifestType = "application/vnd.docker.distribution.manifest.v2+json";
const imageConfig = JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [] } });
const configDigest = "sha256:" + createHash("sha256").update(imageConfig).digest("hex");

export function registryFixture(options = {}) {
  const grants = options.grants ?? new Map();
  const f = fixture({ ...options, bindings: { ANONYMOUS_ROUTES: "ghcr", ...options.bindings },
    upstream: options.upstream ?? (request => {
      const url = new URL(request.url);
      const authorization = request.headers.get("Authorization");
      if (url.pathname === "/token") {
        const scope = url.searchParams.get("scope");
        const repository = scope ? scope.slice("repository:".length, -":pull".length) : "";
        const identity = authorization === basic("alice", "ghp_test_alice") ? "alice" : "anonymous";
        if (authorization && identity !== "alice" || repository.includes("private") && identity !== "alice") {
          return MockResponse.json({ error: "denied" }, { status: 401 });
        }
        const token = `${identity}-${Buffer.from(repository).toString("base64url") || "ping"}`;
        grants.set(token, { repository, identity });
        return MockResponse.json({ token, expires_in: 120 });
      }
      if (url.hostname === "pkg-containers.githubusercontent.com") {
        if (authorization) throw new Error("Credentials reached the CDN");
        return new MockResponse("blob");
      }
      const grant = grants.get(authorization?.replace(/^Bearer /, ""));
      const repository = url.pathname === "/v2/" ? "" : url.pathname.split("/").slice(2, -2).join("/");
      if (!grant || grant.repository !== repository || repository.includes("private") && grant.identity !== "alice") {
        return new MockResponse(null, { status: 401 });
      }
      if (url.pathname === "/v2/") return MockResponse.json({});
      if (decodeURIComponent(url.pathname).endsWith("/blobs/" + configDigest)) return new MockResponse(imageConfig);
      if (url.pathname.includes("/blobs/")) return new MockResponse(null, { status: 307, headers: {
        Location: "https://pkg-containers.githubusercontent.com/ghcr1/blob?sig=upstream-signature",
      } });
      const body = JSON.stringify({ schemaVersion: 2, mediaType: manifestType,
        config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: configDigest, size: Buffer.byteLength(imageConfig) }, layers: [] });
      return new MockResponse(request.method === "HEAD" ? null : body, { headers: {
        "Content-Type": manifestType, "Content-Length": String(Buffer.byteLength(body)),
        "Docker-Content-Digest": "sha256:" + createHash("sha256").update(body).digest("hex"), "Cache-Control": "public, max-age=3600",
      } });
    }),
  });
  return { ...f, grants, clientFetch(path, init = {}) {
    return f.fetch(path, { ...init, headers: { Authorization: "", ...init.headers } });
  } };
}

export async function getSession(f, repository = "", authorization = "") {
  const query = new URLSearchParams({ service: "ghcr.io", client_id: "docker", offline_token: "true" });
  if (repository) query.set("scope", `repository:${repository}:pull`);
  return f.clientFetch("/__registry/token?" + query, { headers: { Authorization: authorization } });
}
