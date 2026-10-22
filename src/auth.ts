import { validRegistryToken, verifyRegistrySession } from "./registry";

export interface Access {
  authorized: boolean;
  ghcrAuthorization?: string;
  registryToken?: string;
  proxyAuthenticated?: boolean;
  error?: string;
}

function basicCredentials(value: string): { username: string; password: string } | null {
  if (value.length > 8192 || !/^Basic [a-zA-Z0-9+/]+={0,2}$/i.test(value)) return null;
  try {
    const decoded = atob(value.slice(6));
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
  } catch { return null; }
}

function ghcrBasic(username: string, password: string): string | undefined {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_\[\]-]{0,255}$/.test(username) ||
    !/^[\x21-\x7e]{1,4096}$/.test(password)) return undefined;
  return "Basic " + btoa(`${username}:${password}`);
}

async function sameSecret(candidate: string, secret: string): Promise<boolean> {
  const encode = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode.encode(candidate)),
    crypto.subtle.digest("SHA-256", encode.encode(secret)),
  ]);
  const left = new Uint8Array(actual);
  const right = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

export async function authorize(request: Request, secret: string | undefined,
  ghcr: boolean, anonymous = false, registry?: { repository: string; origin: string }): Promise<Access> {
  // Public GitHub file routes never interpret or forward client credentials.
  if (anonymous && !ghcr) return { authorized: true };
  const value = request.headers.get("Authorization") ?? "";
  if (value.length > 32_775) return { authorized: false };
  if (ghcr && !registry && !secret && /^Bearer /i.test(value)) return { authorized: false };
  if (registry && /^Bearer /i.test(value)) {
    const bearer = value.slice(7);
    if (!secret || !await sameSecret(bearer, secret)) {
      const token = secret ? await verifyRegistrySession(bearer, secret, registry.repository, registry.origin, anonymous)
        : anonymous && validRegistryToken(bearer) ? bearer : undefined;
      if (!token) return { authorized: false };
      if (request.headers.has("X-GHCR-Authorization")) return { authorized: true, error: "Conflicting GHCR credentials" };
      return { authorized: true, registryToken: token };
    }
  }
  if (value.length > 8192) return { authorized: false };
  if (ghcr && value && !/^(?:Basic|Bearer) /i.test(value)) return { authorized: true, error: "Invalid GHCR credentials" };
  const basic = basicCredentials(value);
  if (ghcr && /^Basic(?: |$)/i.test(value) && !basic) {
    return { authorized: anonymous || !secret, error: "Invalid GHCR credentials" };
  }
  let authorized = !secret;
  let upstream: string | undefined;
  if (secret) {
    if (/^Bearer /i.test(value)) authorized = await sameSecret(value.slice(7), secret);
    else if (basic) {
      authorized = await sameSecret(basic.password, secret);
      if (!authorized && ghcr && basic.password[secret.length] === ":") {
        authorized = await sameSecret(basic.password.slice(0, secret.length), secret);
        if (authorized) {
          upstream = ghcrBasic(basic.username, basic.password.slice(secret.length + 1));
          if (!upstream) return { authorized: true, error: "Invalid GHCR credentials" };
        }
      }
    }
  } else if (ghcr && basic) {
    // Public GHCR routes still require GitHub credentials for private packages.
    upstream = ghcrBasic(basic.username, basic.password);
    if (!upstream) return { authorized: true, error: "Invalid GHCR credentials" };
  }
  const proxyAuthenticated = !!secret && authorized;
  if (!authorized && anonymous) {
    if (value && !basic) return { authorized: false };
    authorized = true;
    // Also accept native username/PAT on public GHCR routes when a proxy
    // secret exists. Valid composite passwords above retain their meaning.
    if (basic) {
      upstream = ghcrBasic(basic.username, basic.password);
      if (!upstream) return { authorized: true, error: "Invalid GHCR credentials" };
    }
  }
  if (!authorized) return { authorized: false };

  const extra = request.headers.get("X-GHCR-Authorization");
  if (extra !== null) {
    if (!ghcr || upstream) return { authorized: true, error: "Conflicting or misplaced GHCR credentials" };
    const credentials = basicCredentials(extra);
    upstream = credentials && ghcrBasic(credentials.username, credentials.password) || undefined;
    if (!upstream) return { authorized: true, error: "X-GHCR-Authorization must contain GitHub Basic credentials" };
  }
  return { authorized: true, ghcrAuthorization: upstream, proxyAuthenticated };
}
