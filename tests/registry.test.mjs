import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { registryFixture, getSession } from "./helpers/registry.mjs";
import { secret, basic, digest, MockResponse } from "./helpers/runtime.mjs";

const privateAuth = basic("alice", "ghp_test_alice");
const privatePath = "/v2/owner/private/manifests/latest";

test("Registry challenge drives credential validation and anonymous/public pulls", async t => {
  const f = registryFixture();
  t.after(() => f.mf.dispose());
  for (const path of ["/v2/", "/ghcr.io/v2/"]) {
    const ping = await f.clientFetch(path);
    assert.equal(ping.status, 401);
    assert.equal(ping.headers.get("WWW-Authenticate"), 'Bearer realm="https://proxy.test/__registry/token",service="ghcr.io"');
  }
  assert.equal(f.requests.length, 0);
  for (const password of ["nonsense", "ghp_revoked", ""]) {
    const denied = await getSession(f, "", basic("alice", password));
    assert.equal(denied.status, password ? 403 : 400);
    assert.equal((await denied.json()).token, undefined);
  }
  const login = await getSession(f, "", privateAuth);
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.equal(session.expires_in, 60);
  assert.ok(!JSON.stringify(session).includes("ghp_test_alice"));
  assert.equal(login.headers.get("Cache-Control"), "no-store");
  assert.equal(login.headers.get("Pragma"), "no-cache");
  assert.equal((await f.clientFetch("/v2/", { headers: { Authorization: `Bearer ${session.token}` } })).status, 200);
  const anonymous = await (await getSession(f, "owner/public")).json();
  assert.ok(anonymous.token);
  const publicManifest = await f.clientFetch("/v2/owner/public/manifests/latest", {
    headers: { Authorization: `Bearer ${anonymous.token}` },
  });
  assert.equal(publicManifest.status, 200);
  assert.equal((await publicManifest.json()).schemaVersion, 2);
});

test("Private manifests and blobs require valid scoped sessions and bypass all shared caches", async t => {
  const f = registryFixture();
  t.after(() => f.mf.dispose());
  const first = await f.clientFetch(privatePath);
  assert.equal(first.status, 401);
  assert.match(first.headers.get("WWW-Authenticate"), /scope="repository:owner\/private:pull"/);
  const granted = await getSession(f, "owner/private", privateAuth);
  const { token } = await granted.json();
  assert.ok(token);
  const before = f.requests.length;
  for (const method of ["HEAD", "GET", "GET"]) {
    const response = await f.clientFetch(privatePath, { method, headers: { Authorization: `Bearer ${token}`, Cookie: "client=secret" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    await response.text();
  }
  assert.equal(f.requests.length, before + 3);
  const blob = await f.clientFetch(`/v2/owner/private/blobs/${digest}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(await blob.text(), "blob");
  for (const entry of f.requests) {
    assert.equal(entry.headers.cookie, undefined);
    if (new URL(entry.url).pathname !== "/token") assert.ok(!entry.headers.authorization?.startsWith("Basic"));
  }
  const blocked = await f.clientFetch(privatePath, { headers: { Authorization: "Bearer invalid-session" } });
  assert.equal(blocked.status, 401);
  assert.equal((await f.clientFetch(privatePath)).status, 401, "private data never becomes anonymous cache content");
});

test("Protected proxy sessions require the proxy secret and work across isolates", async t => {
  const f = registryFixture({ bindings: { ALLOW_ANONYMOUS: "false" } });
  const another = registryFixture({ bindings: { ALLOW_ANONYMOUS: "false" }, grants: f.grants });
  t.after(async () => { await f.mf.dispose(); await another.mf.dispose(); });
  for (const authorization of ["", privateAuth, basic("alice", "wrong:ghp_test_alice")]) {
    assert.equal((await getSession(f, "owner/private", authorization)).status, 401);
  }
  assert.equal(f.requests.length, 0);
  const response = await getSession(f, "owner/private", basic("alice", `${secret}:ghp_test_alice`));
  assert.equal(response.status, 200);
  const { token } = await response.json();
  assert.equal((await another.clientFetch(privatePath, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  const raw = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).token;
  assert.equal((await f.clientFetch(privatePath, { headers: { Authorization: `Bearer ${raw}` } })).status, 401,
    "an upstream token alone cannot bypass proxy authentication");
  assert.equal((await getSession(f, "owner/public", basic("proxy", secret))).status, 200);
});

test("Session integrity, repository, audience, expiry and credential conflicts fail closed", async t => {
  const f = registryFixture();
  const rotated = registryFixture({ bindings: { PROXY_TOKEN: "rotated-secret" }, grants: f.grants });
  const closed = registryFixture({ bindings: { ALLOW_ANONYMOUS: "false" }, grants: f.grants });
  const restricted = registryFixture({ bindings: { ALLOWED_GHCR_REPOSITORIES: "owner/other" }, grants: f.grants });
  t.after(async () => { await f.mf.dispose(); await rotated.mf.dispose(); await closed.mf.dispose(); await restricted.mf.dispose(); });
  const { token } = await (await getSession(f, "owner/private", privateAuth)).json();
  const parts = token.split(".");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
  function signed(change) {
    const payload = Buffer.from(JSON.stringify({ ...claims, ...change })).toString("base64url");
    const message = `gp1.${payload}`;
    return `${message}.${createHmac("sha256", secret).update(message).digest("base64url")}`;
  }
  const before = f.requests.length;
  for (const bad of [parts.slice(0, 2).join("."), token + "x", token.replace("gp1.", "gp2."),
    "x".repeat(33_000), signed({ expires: Math.floor(Date.now() / 1000) - 1 }),
    signed({ expires: Math.floor(Date.now() / 1000) + 3600 })]) {
    assert.equal((await f.clientFetch(privatePath, { headers: { Authorization: `Bearer ${bad}` } })).status, 401);
  }
  assert.equal((await f.clientFetch(privatePath.replace("/private/", "/other/"), { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await f.mf.dispatchFetch("https://other.test" + privatePath, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await rotated.clientFetch(privatePath, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await closed.clientFetch(privatePath, { headers: { Authorization: `Bearer ${token}` } })).status, 401,
    "turning off anonymous access immediately rejects sessions issued without a proxy password");
  assert.equal((await restricted.clientFetch(privatePath, { headers: { Authorization: `Bearer ${token}` } })).status, 403,
    "tightened repository policies also apply to existing sessions");
  assert.equal(restricted.requests.length, 0);
  assert.equal((await f.clientFetch(privatePath, { headers: { Authorization: `Bearer ${token}`, "X-GHCR-Authorization": privateAuth } })).status, 400);
  assert.equal(f.requests.length, before);
  assert.equal((await f.mf.dispatchFetch("http://proxy.test/__registry/token?service=ghcr.io", {
    headers: { Authorization: privateAuth },
  })).status, 400, "remote credential endpoints require HTTPS");
});

test("Token queries cannot widen scopes, inject credentials, choose upstream services or bypass allowlists", async t => {
  const f = registryFixture({ bindings: { ALLOWED_GHCR_REPOSITORIES: "owner/allowed" } });
  t.after(() => f.mf.dispose());
  const root = "/__registry/token?service=ghcr.io";
  for (const query of ["", "service=evil.test", "service=ghcr.io&service=ghcr.io", "service=ghcr.io&realm=https://evil.test",
    "service=ghcr.io&password=secret", "service=ghcr.io&scope=registry:catalog:*",
    "service=ghcr.io&scope=repository:owner/allowed:pull,push", "service=ghcr.io&scope=repository:owner/allowed:push",
    "service=ghcr.io&scope=repository:owner/allowed:pull&scope=repository:owner/other:pull",
    "service=ghcr.io&scope=repository:owner%2f..%2fprivate:pull", "service=ghcr.io&scope=repository:owner/UPPER:pull",
    "service=ghcr.io&scope=repository:owner/private:pull%0a"]) {
    assert.equal((await f.clientFetch("/__registry/token?" + query)).status, 400, query);
  }
  assert.equal((await f.clientFetch(root, { method: "POST", body: "password=secret" })).status, 405);
  assert.equal((await getSession(f, "owner/blocked", privateAuth)).status, 403);
  assert.equal(f.requests.length, 0);
  assert.equal((await getSession(f, "", privateAuth)).status, 200, "login grants no package scope");
  assert.equal((await getSession(f, "owner/allowed", privateAuth)).status, 200);
  assert.ok(f.requests.every(entry => entry.url.startsWith("https://ghcr.io/token?service=ghcr.io")));
});

test("Anonymous deployments without a proxy secret still validate supplied PATs at GHCR", async t => {
  const f = registryFixture({ bindings: { PROXY_TOKEN: "" } });
  t.after(() => f.mf.dispose());
  assert.equal((await getSession(f, "", basic("alice", "wrong"))).status, 403);
  assert.equal((await getSession(f, "", "Bearer wrong")).status, 401);
  const { token } = await (await getSession(f, "owner/private", privateAuth)).json();
  assert.equal((await f.clientFetch(privatePath, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  const before = f.requests.length;
  assert.equal((await f.clientFetch(privatePath, { headers: { Authorization: "Bearer forged" } })).status, 403);
  assert.equal(f.requests.length, before + 1);
});

test("Token minting consumes IP and total quotas even when the supplied PAT is invalid", async t => {
  for (const limit of ["IP_RATE_LIMITER", "TOTAL_RATE_LIMITER"]) {
    const f = registryFixture({ ratelimits: {
      IP_RATE_LIMITER: { namespace_id: "1", simple: { limit: limit === "IP_RATE_LIMITER" ? 1 : 100, period: 60 } },
      TOTAL_RATE_LIMITER: { namespace_id: "2", simple: { limit: limit === "TOTAL_RATE_LIMITER" ? 1 : 100, period: 60 } },
    } });
    try {
      assert.equal((await getSession(f, "", basic("alice", "wrong"))).status, 403);
      assert.equal((await getSession(f, "", privateAuth)).status, 429);
      assert.equal(f.requests.length, 1);
    } finally { await f.mf.dispose(); }
  }
});

test("Truncated, oversized and stalled upstream token responses never issue sessions", async t => {
  for (const body of ['{"token":', JSON.stringify({ token: "x".repeat(65_536) }), JSON.stringify({ token: "bad token" }),
    JSON.stringify({ token: "valid-token", expires_in: -1 })]) {
    const f = registryFixture({ upstream: () => new MockResponse(body) });
    try { assert.equal((await getSession(f)).status, 502); } finally { await f.mf.dispose(); }
  }
  const f = registryFixture({ upstream: () => new MockResponse(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"token":"valid-token"}')); },
  })) });
  try { assert.equal((await getSession(f)).status, 502, "complete JSON without a completed body still times out"); }
  finally { await f.mf.dispose(); }
});
