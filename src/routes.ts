export type ProxyType = "gist" | "raw" | "releases" | "archive" | "ghcr";

export interface Route {
  kind: "github" | "ghcr";
  type: ProxyType;
  target: URL;
  repository: string;
  manifest: boolean;
  ping: boolean;
  ttl: number;
}

const NAME = /^[a-zA-Z0-9._-]+$/;
const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TAG = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;

const MEDIA_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.artifact.manifest.v1+json",
];

// Keep negotiation and the cache key in sync, with only finitely many variants.
// Arbitrary Accept parameters must not work like random cache-busting queries.
export function manifestAccept(request: Request): string | null {
  const accept = request.headers.get("Accept");
  if (!accept) return MEDIA_TYPES.join(", ");
  if (accept.length > 4096) return null;
  const accepted = new Set(accept.toLowerCase().split(",").filter(value =>
    !/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/.test(value)).map(value => value.split(";")[0].trim()));
  const types = MEDIA_TYPES.filter(type => accepted.has(type) ||
    accepted.has("*/*") || accepted.has("application/*") || accepted.has("application/json"));
  return types.length ? types.join(", ") : null;
}

// Decode components separately so encoded slashes/dot segments cannot change routes.
function pathParts(pathname: string): string[] | null {
  try {
    const parts = pathname.slice(1).split("/").map(decodeURIComponent);
    if (parts.some(part => !part || part === "." || part === ".." ||
      /[\\/\u0000-\u001f\u007f]/.test(part) || /%(?:2e|2f|5c)/i.test(part))) return null;
    return parts;
  } catch {
    return null;
  }
}

function target(host: string, parts: string[]): URL {
  const url = new URL(`https://${host}`);
  url.pathname = "/" + parts.map(encodeURIComponent).join("/");
  return url;
}

function gistRoute(parts: string[]): Route | null {
  if (parts.length < 3 || !NAME.test(parts[0]) ||
    !/^[a-zA-Z0-9_-]+$/.test(parts[1]) || parts[2] !== "raw") return null;
  return { kind: "github", type: "gist", target: target("gist.githubusercontent.com", parts),
    repository: parts.slice(0, 2).join("/"), manifest: false, ping: false, ttl: 3600 };
}

export function buildRoute(url: URL): Route | null {
  // Support a full Gist Raw URL after the proxy origin, but only this exact
  // HTTPS host. Do not turn embedded URLs into a general-purpose URL proxy.
  const fullGist = url.pathname.match(/^\/https:\/\/gist\.githubusercontent\.com(\/.*)$/i);
  if (fullGist) {
    const parts = pathParts(fullGist[1]);
    if (!parts) return null;
    // Prefer the real upstream path, including the valid username "gist".
    // Also accept the legacy form with an extra /gist/ before username/id/raw.
    return gistRoute(parts) ?? (parts[0] === "gist" ? gistRoute(parts.slice(1)) : null);
  }
  // Docker/OCI clients use /v2; /ghcr.io/v2 is a convenient HTTP alias.
  const pathname = url.pathname.replace(/^\/ghcr\.io(?=\/v2(?:\/|$))/, "");
  if (pathname === "/v2" || pathname === "/v2/") {
    return { kind: "ghcr", type: "ghcr", target: new URL("https://ghcr.io/v2/"),
      repository: "", manifest: false, ping: true, ttl: 0 };
  }
  const parts = pathParts(pathname);
  if (!parts) return null;
  if (parts[0] === "v2") {
    const operation = parts.at(-2);
    const reference = parts.at(-1)!;
    const repository = parts.slice(1, -2);
    if (repository.length < 2 || repository.join("/").length > 255 ||
      !repository.every(part => COMPONENT.test(part))) return null;
    const manifest = operation === "manifests";
    if (!(manifest ? DIGEST.test(reference) || TAG.test(reference) :
      operation === "blobs" && DIGEST.test(reference))) return null;
    return { kind: "ghcr", type: "ghcr", target: target("ghcr.io", parts),
      repository: repository.join("/"), manifest, ping: false,
      ttl: manifest && !DIGEST.test(reference) ? 60 : 3600 };
  }

  let host = "github.com";
  let upstream = parts;
  let repository: string;
  let type: ProxyType = "archive";
  if (parts[0] === "gist") {
    return gistRoute(parts.slice(1));
  } else if (parts[0] === "raw") {
    if (parts.length < 5) return null;
    host = "raw.githubusercontent.com";
    upstream = parts.slice(1);
    repository = upstream.slice(0, 2).join("/");
    type = "raw";
  } else {
    if (parts.length < 4) return null;
    repository = parts.slice(0, 2).join("/");
    if (parts[2] === "raw" && parts.length >= 5) {
      type = "raw";
      host = "raw.githubusercontent.com";
      upstream = [...parts.slice(0, 2), ...parts.slice(3)];
    } else if (parts[2] === "releases" && parts[3] === "download" && parts.length >= 6) {
      // Release downloads require both a tag and an asset name.
      type = "releases";
    } else if (!["archive", "zipball", "tarball"].includes(parts[2])) return null;
  }
  if (!upstream.slice(0, 2).every(part => NAME.test(part))) return null;
  // Drop client query strings upstream and in cache keys. These routes do not
  // need them, and ?random=... must not force repeated downloads.
  return { kind: "github", type, target: target(host, upstream), repository,
    manifest: false, ping: false, ttl: 3600 };
}

export function repositoryAllowed(route: Route, allowlist: string | undefined): boolean {
  if (route.ping || allowlist === undefined) return true;
  return allowlist.split(",").some(entry =>
    entry.trim().toLowerCase() === route.repository.toLowerCase());
}
