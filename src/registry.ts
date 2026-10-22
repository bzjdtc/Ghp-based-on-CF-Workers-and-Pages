import { validRegistryRepository } from "./routes";

export const REGISTRY_TOKEN_PATH = "/__registry/token";
const SESSION_PREFIX = "gp1";
const MAX_SESSION_SECONDS = 60;
const ENCODER = new TextEncoder();
const TOKEN = /^[A-Za-z0-9._~+\/-]+=*$/;

export function validRegistryToken(value: string): boolean {
  return value.length > 0 && value.length <= 16_384 && TOKEN.test(value);
}

export function registryChallenge(url: URL, repository = ""): string {
  const realm = new URL(REGISTRY_TOKEN_PATH, url.origin);
  // HTTP is only useful for local development. Never advertise a remote HTTP
  // credential endpoint, and never use forwarded host/realm headers.
  if (!["localhost", "127.0.0.1", "[::1]"].includes(realm.hostname)) realm.protocol = "https:";
  return `Bearer realm="${realm.href}",service="ghcr.io"` +
    (repository ? `,scope="repository:${repository}:pull"` : "");
}

export function registryTokenRepository(url: URL): string | null {
  const allowed = new Set(["service", "scope", "account", "client_id", "offline_token"]);
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || seen.has(key) || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return null;
    seen.add(key);
  }
  if (url.searchParams.get("service") !== "ghcr.io") return null;
  const scope = url.searchParams.get("scope");
  if (!scope) return "";
  const match = /^repository:([^:]+):pull$/.exec(scope);
  return match && validRegistryRepository(match[1]) ? match[1] : null;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error("Noncanonical encoding");
  return bytes;
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ENCODER.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueRegistrySession(token: string, secret: string | undefined,
  repository: string, origin: string, lifetime: number, proxyAuthenticated: boolean): Promise<{ token: string; expires_in: number }> {
  const expires = Math.max(1, Math.min(MAX_SESSION_SECONDS, Math.floor(lifetime)));
  if (!secret) return { token, expires_in: expires };
  // Only the short-lived GHCR token is carried by the client. Never put a PAT
  // or proxy password in a session, and never retain private session state.
  const claims = base64url(ENCODER.encode(JSON.stringify({
    repository, origin, expires: Math.floor(Date.now() / 1000) + expires, token, proxyAuthenticated,
  })));
  const message = `${SESSION_PREFIX}.${claims}`;
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(secret), ENCODER.encode(message));
  return { token: `${message}.${base64url(new Uint8Array(signature))}`, expires_in: expires };
}

export async function verifyRegistrySession(value: string, secret: string,
  repository: string, origin: string, anonymous: boolean): Promise<string | undefined> {
  if (value.length > 32_768) return undefined;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_PREFIX || parts[2].length !== 43) return undefined;
  try {
    const signature = unbase64url(parts[2]);
    if (!await crypto.subtle.verify("HMAC", await sessionKey(secret), signature, ENCODER.encode(`${parts[0]}.${parts[1]}`))) return undefined;
    const claims = JSON.parse(new TextDecoder().decode(unbase64url(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (claims.repository !== repository || claims.origin !== origin ||
      typeof claims.proxyAuthenticated !== "boolean" || !anonymous && !claims.proxyAuthenticated ||
      !Number.isSafeInteger(claims.expires) || claims.expires <= now || claims.expires > now + MAX_SESSION_SECONDS ||
      typeof claims.token !== "string" || !validRegistryToken(claims.token)) return undefined;
    return claims.token;
  } catch { return undefined; }
}
