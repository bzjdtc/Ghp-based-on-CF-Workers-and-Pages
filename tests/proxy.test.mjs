import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { fixture, secret, digest, manifestType, basic, privateHeaders, MockResponse } from "./helpers/runtime.mjs";

test("download routing, authorization, and cache behavior in workerd", async t => {
  const f = fixture();
  t.after(() => f.mf.dispose());

  await t.test("missing/wrong credentials cannot fetch or read a populated cache", async () => {
    const path = "/raw/owner/repo/main/auth.txt";
    const first = await f.fetch(path);
    assert.equal(await first.text(), "hello");
    for (const Authorization of ["", "Bearer wrong", "Basic !!!", "Bearer ghcr-public-token"]) {
      const response = await f.fetch(path, { headers: { Authorization } });
      assert.equal(response.status, 401);
      assert.match(response.headers.get("WWW-Authenticate"), /^Basic /);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      await response.text();
    }
    assert.equal(f.requests.length, 1);
  });

  await t.test("Docker Basic login succeeds locally without upstream requests", async () => {
    const before = f.requests.length;
    const response = await f.fetch("/v2/", { headers: {
      Authorization: "Basic " + Buffer.from(`proxy:${secret}`).toString("base64"),
    } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Docker-Distribution-Api-Version"), "registry/2.0");
    assert.equal(await response.text(), "{}");
    assert.equal(f.requests.length, before);
  });

  await t.test("GitHub routes preserve safe encoded filenames and omit credentials", async () => {
    const paths = new Map([
      ["/owner/repo/releases/download/v1/file%23%3F%20x.zip?random=1", "https://github.com/owner/repo/releases/download/v1/file%23%3F%20x.zip"],
      ["/raw/owner/repo/main/file.txt", "https://raw.githubusercontent.com/owner/repo/main/file.txt"],
      ["/owner/repo/raw/main/file.txt", "https://raw.githubusercontent.com/owner/repo/main/file.txt"],
      ["/owner/repo/archive/refs/heads/main.zip", "https://github.com/owner/repo/archive/refs/heads/main.zip"],
      ["/owner/repo/zipball/main", "https://github.com/owner/repo/zipball/main"],
      ["/owner/repo/tarball/main", "https://github.com/owner/repo/tarball/main"],
      ["/gist/user/abc123/raw", "https://gist.githubusercontent.com/user/abc123/raw"],
      ["/gist/user/abc123/raw/revision/file.txt", "https://gist.githubusercontent.com/user/abc123/raw/revision/file.txt"],
    ]);
    for (const [path, expected] of paths) {
      const response = await f.fetch(path, { method: "HEAD", headers: { Cookie: "secret=client" } });
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), "");
      assert.equal(f.requests.at(-1).url, expected);
      assert.equal(f.requests.at(-1).headers.authorization, undefined);
      assert.equal(f.requests.at(-1).headers.cookie, undefined);
    }
  });

  await t.test("query strings and raw aliases share a cache entry", async () => {
    const before = f.requests.length;
    for (const path of ["/raw/owner/repo/main/cache.txt?nonce=a", "/owner/repo/raw/main/cache.txt?nonce=b"]) {
      const response = await f.fetch(path);
      assert.equal(await response.text(), "hello");
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    }
    assert.equal(f.requests.length, before + 1);
  });

  await t.test("conditional GET, HEAD, and Range reuse the cache", async () => {
    const path = "/raw/owner/repo/main/conditional.txt";
    await (await f.fetch(path)).text();
    const before = f.requests.length;
    const conditional = await f.fetch(path, { headers: { "If-None-Match": '"hello"' } });
    assert.equal(conditional.status, 304);
    const head = await f.fetch(path, { method: "HEAD" });
    assert.equal(await head.text(), "");
    const range = await f.fetch(path, { headers: { Range: "bytes=1-3" } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "ell");
    assert.equal(f.requests.length, before);
    const ifRange = await f.fetch(path, { headers: { Range: "bytes=1-3", "If-Range": '"old"' } });
    assert.equal(await ifRange.text(), "hello");
    assert.equal(f.requests.length, before + 1);
    assert.equal(f.requests.at(-1).headers["if-range"], '"old"');
  });

  await t.test("unsupported routes, traversal, multipart ranges and push methods are refused", async () => {
    const before = f.requests.length;
    for (const path of ["/https://example.org/file", "/raw/owner/repo/main/%2f..%2fsecret", "/raw/owner/repo/main/%5c..%5csecret",
      "/raw/owner/repo/main/%252e%252e/file", "/raw/owner/repo/main/%zz",
      "/v2/_catalog", "/v2/owner/repo/tags/list", "/v2/owner/repo/blobs/uploads/",
      "/v2/owner/repo/blobs/sha256:bad", "/v2/UPPER/repo/manifests/latest"]) {
      assert.equal((await f.fetch(path)).status, 404, path);
    }
    assert.equal((await f.fetch("/raw/owner/repo/main/file", { headers: { Range: "bytes=0-1,3-4" } })).status, 416);
    assert.equal((await f.fetch("/v2/owner/repo/manifests/latest", { method: "PUT", body: "push" })).status, 405);
    assert.equal((await f.fetch("/", { method: "POST" })).status, 405);
    assert.equal(f.requests.length, before);
  });
});

test("anonymous route selection is exact and controlled by the master switch", async t => {
  const types = {
    gist: ["/gist/user/abc123/raw/file.txt", "/https://gist.githubusercontent.com/gist/user/abc123/raw/file.txt"],
    raw: ["/raw/owner/repo/main/file.txt", "/owner/repo/raw/main/file.txt"],
    releases: ["/owner/repo/releases/download/v1/file.zip"],
    archive: ["/owner/repo/archive/refs/heads/main.zip", "/owner/repo/zipball/main", "/owner/repo/tarball/main"],
    git: ["/owner/repo.git/info/refs?service=git-upload-pack", "/https://github.com/owner/repo.git/info/refs?service=git-upload-pack"],
    ghcr: ["/v2/", "/ghcr.io/v2/", "/v2/owner/image/manifests/latest", `/v2/owner/image/blobs/${digest}`],
  };
  for (const selected of Object.keys(types)) {
    await t.test(`only selected ${selected} routes and their aliases are public`, async () => {
      const f = fixture({ bindings: { ANONYMOUS_ROUTES: ` ${selected} ` } });
      try {
        for (const [type, paths] of Object.entries(types)) {
          for (const path of paths) {
            const response = await f.fetch(path, { method: "HEAD", headers: { Authorization: "" } });
            const ping = path === "/v2/" || path === "/ghcr.io/v2/";
            assert.equal(response.status, type === selected && !ping ? 200 : 401, path);
            await response.text();
          }
        }
        for (const path of ["/https://evil.test/raw/owner/repo/main/file", "/gist/user/releases/download/v1/file.zip",
          "/raw/owner/repo/main/%2fsecret", "/v2/_catalog"]) {
          assert.equal((await f.fetch(path, { headers: { Authorization: "" } })).status, 401, path);
        }
      } finally { await f.mf.dispose(); }
    });
  }
  await t.test("disabled, missing or unrecognized settings cannot exempt cached Gist data", async () => {
    for (const bindings of [
      { ALLOW_ANONYMOUS: "false" }, { ALLOW_ANONYMOUS: "" }, { ALLOW_ANONYMOUS: "TRUE" },
      { ANONYMOUS_ROUTES: "" }, { ANONYMOUS_ROUTES: "gist-typo,github,*" },
    ]) {
      const f = fixture({ bindings });
      try {
        const path = "/gist/user/abc123/raw/file.txt";
        assert.equal(await (await f.fetch(path)).text(), "hello");
        assert.equal((await f.fetch(path, { headers: { Authorization: "" } })).status, 401);
        assert.equal(f.requests.length, 1);
      } finally { await f.mf.dispose(); }
    }
  });
  await t.test("multiple selected types work without a secret; other types fail closed", async () => {
    const f = fixture({ bindings: { PROXY_TOKEN: "", ANONYMOUS_ROUTES: "gist,raw,releases" } });
    try {
      for (const path of [types.gist[0], types.raw[0], types.releases[0]]) {
        assert.equal(await (await f.fetch(path, { headers: { Authorization: "" } })).text(), "hello");
      }
      for (const path of [types.archive[0], types.ghcr[0], "/unknown"]) {
        assert.equal((await f.fetch(path, { headers: { Authorization: "" } })).status, 503);
      }
    } finally { await f.mf.dispose(); }
  });
  await t.test("public Raw and GHCR still obey repository restrictions", async () => {
    const f = fixture({ bindings: { ANONYMOUS_ROUTES: "raw,ghcr",
      ALLOWED_GITHUB_REPOSITORIES: "owner/allowed", ALLOWED_GHCR_REPOSITORIES: "owner/allowed" } });
    try {
      for (const path of [types.raw[0], types.ghcr[2]]) {
        assert.equal((await f.fetch(path, { headers: { Authorization: "" } })).status, 403);
      }
      assert.equal(f.requests.length, 0);
    } finally { await f.mf.dispose(); }
  });
});

test("public GHCR supports native and composite private credentials with a configured proxy secret", async t => {
  const f = fixture({ bindings: { ANONYMOUS_ROUTES: "ghcr" }, upstream(request) {
    const url = new URL(request.url);
    const authorization = request.headers.get("Authorization");
    if (url.pathname === "/token") {
      if (authorization !== basic("alice", "ghp_test_alice")) return new MockResponse(null, { status: 403 });
      return MockResponse.json({ token: "private-token" });
    }
    if (authorization !== "Bearer private-token") return new MockResponse(null, { status: 401 });
    return new MockResponse("private bytes", { headers: { "Content-Length": "13", "Cache-Control": "public" } });
  } });
  t.after(() => f.mf.dispose());
  const path = "/v2/owner/private/manifests/latest";
  for (const headers of [
    { Authorization: basic("alice", "ghp_test_alice") },
    privateHeaders(),
    { Authorization: "", "X-GHCR-Authorization": basic("alice", "ghp_test_alice") },
  ]) {
    for (let i = 0; i < 2; i++) {
      assert.equal(await (await f.fetch(path, { headers })).text(), "private bytes");
    }
  }
  assert.equal(f.requests.length, 12, "all credentialed requests bypass the cache");
  for (const headers of [{ Authorization: "" }, { Authorization: basic("bob", "invalid-pat") }]) {
    assert.equal((await f.fetch(path, { headers })).status, headers.Authorization ? 403 : 401,
      "opening the proxy does not open private packages");
  }
  assert.equal((await f.fetch(path, { headers: { Authorization: "Basic !!!" } })).status, 400);
});

test("Gist Raw downloads are public while other downloads stay protected", async t => {
  await t.test("Gist GET, HEAD, cached and conditional reads need no proxy credentials", async () => {
    const f = fixture();
    try {
      const path = "/gist/user/abc123/raw/file.txt";
      const response = await f.fetch(path, { headers: { Authorization: "" } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("WWW-Authenticate"), null);
      assert.equal(await response.text(), "hello");
      const cached = await f.fetch(path + "?random=1", { headers: { Authorization: "Bearer wrong" } });
      assert.equal(await cached.text(), "hello");
      const head = await f.fetch(path, { method: "HEAD", headers: { Authorization: "" } });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      const conditional = await f.fetch(path, { headers: { Authorization: "", "If-None-Match": '"hello"' } });
      assert.equal(conditional.status, 304);
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].url, "https://gist.githubusercontent.com/user/abc123/raw/file.txt");
      const revision = await f.fetch("/gist/user/abc123/raw/revision/file.txt", { headers: {
        Authorization: "Basic !!!", Cookie: "secret=client",
        "X-GHCR-Authorization": basic("alice", "ghp_fake_test"),
      } });
      assert.equal(await revision.text(), "hello");
      assert.equal(f.requests.at(-1).headers.authorization, undefined);
      assert.equal(f.requests.at(-1).headers.cookie, undefined);
      assert.equal(f.requests.at(-1).headers["x-ghcr-authorization"], undefined);
    } finally { await f.mf.dispose(); }
  });
  await t.test("selected Gist exemption does not require a configured proxy secret", async () => {
    const f = fixture({ bindings: { PROXY_TOKEN: "" } });
    try {
      assert.equal(await (await f.fetch("/gist/user/abc123/raw", { headers: { Authorization: "" } })).text(), "hello");
      assert.equal(await (await f.fetch("/https://gist.githubusercontent.com/gist/user/abc123/raw", {
        headers: { Authorization: "" },
      })).text(), "hello");
      for (const path of ["/raw/o/r/main/file", "/v2/", "/v2/owner/image/manifests/latest"]) {
        assert.equal((await f.fetch(path, { headers: { Authorization: "" } })).status, 503, path);
      }
      assert.equal(f.requests.length, 1);
    } finally { await f.mf.dispose(); }
  });
    await t.test("full Gist URLs and the extra /gist/ form share public cache entries", async () => {
    const f = fixture();
    try {
      for (const path of ["/gist/user/abc123/raw/file.txt",
        "/https://gist.githubusercontent.com/user/abc123/raw/file.txt?random=1",
        "/https://gist.githubusercontent.com/gist/user/abc123/raw/file.txt?random=2"]) {
        const response = await f.fetch(path, { headers: { Authorization: "" } });
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get("WWW-Authenticate"), null);
        assert.equal(await response.text(), "hello");
      }
      const head = await f.fetch("/https://gist.githubusercontent.com/gist/user/abc123/raw/file.txt", {
        method: "HEAD", headers: { Authorization: "" },
      });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].url, "https://gist.githubusercontent.com/user/abc123/raw/file.txt");
    } finally { await f.mf.dispose(); }
  });
  await t.test("full Gist paths preserve the username gist, revisions and escaped filenames", async () => {
    const f = fixture();
    try {
      for (const [path, expected] of [
        ["/https://gist.githubusercontent.com/gist/abc123/raw/file.txt", "https://gist.githubusercontent.com/gist/abc123/raw/file.txt"],
        ["/https://gist.githubusercontent.com/user/abc123/raw/revision/file%23%3F%20x.txt?random=1", "https://gist.githubusercontent.com/user/abc123/raw/revision/file%23%3F%20x.txt"],
        ["/https://gist.githubusercontent.com/gist/user/abc123/raw/revision/file.txt", "https://gist.githubusercontent.com/user/abc123/raw/revision/file.txt"],
      ]) {
        assert.equal(await (await f.fetch(path, { headers: { Authorization: "" } })).text(), "hello");
        assert.equal(f.requests.at(-1).url, expected);
      }
    } finally { await f.mf.dispose(); }
  });
  await t.test("embedded URLs cannot change the host, protocol, credentials, port or route", async () => {
    const f = fixture();
    try {
      for (const path of [
        "/https://gist.githubusercontent.com.evil.test/user/abc123/raw/file.txt",
        "/https://gist.githubusercontent.com@evil.test/user/abc123/raw/file.txt",
        "/https://user:password@gist.githubusercontent.com/user/abc123/raw/file.txt",
        "/https://gist.githubusercontent.com:444/user/abc123/raw/file.txt",
        "/http://gist.githubusercontent.com/user/abc123/raw/file.txt",
        "/https://raw.githubusercontent.com/owner/repo/main/file.txt",
        "/https://gist.githubusercontent.com/user/abc123/archive/main",
        "/https://gist.githubusercontent.com/user/abc123/raw/%2fsecret",
        "/https://gist.githubusercontent.com/gist/user/abc123/raw/%5csecret",
        "/https://gist.githubusercontent.com/user/abc123/raw/%252e%252e/file",
      ]) {
        assert.equal((await f.fetch(path)).status, 404, path);
        assert.equal((await f.fetch(path, { headers: { Authorization: "" } })).status, 401, path);
      }
      assert.equal(f.requests.length, 0);
    } finally { await f.mf.dispose(); }
  });
  await t.test("Gist-like paths cannot bypass other routes or path validation", async () => {
    const f = fixture();
    try {
      for (const path of ["/gist/user/abc123/raw/%2f..%2fsecret", "/gist/user/abc123/raw/%252e%252e/file",
        "/gist/user/abc123/raw/%5cfile", "/gist/user/abc123/archive/main", "/gist/user/releases/download/v1/file.zip",
        "/raw/gist/repo/main/file", "/user/abc123/raw/main/file", "/v2/gist/image/manifests/latest"]) {
        assert.equal((await f.fetch(path, { headers: { Authorization: "" } })).status, 401, path);
      }
      assert.equal(f.requests.length, 0);
    } finally { await f.mf.dispose(); }
  });
  await t.test("Gist still respects repository restrictions and allowed methods", async () => {
    const f = fixture({ bindings: { ALLOWED_GITHUB_REPOSITORIES: "user/allowed" } });
    try {
      assert.equal((await f.fetch("/gist/user/abc123/raw", { headers: { Authorization: "" } })).status, 403);
      assert.equal((await f.fetch("/https://gist.githubusercontent.com/user/abc123/raw", {
        headers: { Authorization: "" },
      })).status, 403);
      assert.equal((await f.fetch("/https://gist.githubusercontent.com/gist/user/abc123/raw", {
        headers: { Authorization: "" },
      })).status, 403);
      assert.equal((await f.fetch("/gist/user/allowed/raw", { method: "POST", body: "upload", headers: { Authorization: "" } })).status, 405);
      assert.equal(f.requests.length, 0);
      assert.equal(await (await f.fetch("/gist/user/allowed/raw", { headers: { Authorization: "" } })).text(), "hello");
    } finally { await f.mf.dispose(); }
  });
  await t.test("public Gist redirects cannot reach protected GitHub downloads", async () => {
    for (const location of ["https://github.com/owner/repo/releases/download/v1/file.zip",
      "https://raw.githubusercontent.com/owner/repo/main/file", "https://evil.test/file"]) {
      const f = fixture({ upstream: () => new MockResponse(null, { status: 302, headers: { Location: location } }) });
      try {
        assert.equal((await f.fetch("/gist/user/abc123/raw", { headers: { Authorization: "" } })).status, 502);
        assert.equal(f.requests.length, 1);
      } finally { await f.mf.dispose(); }
    }
  });
  await t.test("Gist can still redirect to its own revision URL", async () => {
    const f = fixture({ upstream(request) {
      return new URL(request.url).pathname === "/user/abc123/raw"
        ? new MockResponse(null, { status: 302, headers: { Location: "/user/abc123/raw/revision/file.txt" } })
        : new MockResponse("hello");
    } });
    try {
      assert.equal(await (await f.fetch("/gist/user/abc123/raw", { headers: { Authorization: "" } })).text(), "hello");
      assert.equal(f.requests.length, 2);
    } finally { await f.mf.dispose(); }
  });
  for (const limiter of ["IP_RATE_LIMITER", "TOTAL_RATE_LIMITER"]) {
    await t.test(`anonymous Gist requests are still covered by ${limiter}`, async () => {
      const f = fixture({ ratelimits: {
        IP_RATE_LIMITER: { namespace_id: "1", simple: { limit: limiter === "IP_RATE_LIMITER" ? 1 : 100, period: 60 } },
        TOTAL_RATE_LIMITER: { namespace_id: "2", simple: { limit: limiter === "TOTAL_RATE_LIMITER" ? 1 : 100, period: 60 } },
      } });
      try {
        const path = "/gist/user/abc123/raw";
        await (await f.fetch(path, { headers: { Authorization: "" } })).text();
        const response = await f.fetch("/https://gist.githubusercontent.com/gist/user/abc123/raw", {
          headers: { Authorization: "" },
        });
        assert.equal(response.status, 429);
        assert.equal(response.headers.get("Retry-After"), "60");
        assert.equal(f.requests.length, 1);
      } finally { await f.mf.dispose(); }
    });
  }
});

test("GHCR anonymous authentication, manifests, and blob redirects", async t => {
  const f = fixture({ upstream(request) {
    const url = new URL(request.url);
    if (url.pathname === "/token") {
      assert.equal(url.origin, "https://ghcr.io");
      assert.equal(url.searchParams.get("service"), "ghcr.io");
      assert.equal(url.searchParams.get("scope"), "repository:owner/image:pull");
      assert.equal(request.headers.get("Authorization"), null);
      return MockResponse.json({ token: "anonymous-test-token", expires_in: 300 });
    }
    if (url.hostname === "pkg-containers.githubusercontent.com") {
      assert.equal(request.headers.get("Authorization"), null);
      assert.equal(url.search, "?sig=upstream-signature");
      return new MockResponse("layer", { headers: { "Content-Length": "5" } });
    }
    if (!request.headers.has("Authorization")) {
      return new MockResponse(null, { status: 401, headers: {
        "WWW-Authenticate": 'Bearer realm="https://evil.test/token",service="evil.test"',
      } });
    }
    assert.equal(request.headers.get("Authorization"), "Bearer anonymous-test-token");
    if (url.pathname.includes("/blobs/")) {
      return new MockResponse(null, { status: 307, headers: {
        Location: "https://pkg-containers.githubusercontent.com/ghcr1/blobs/data?sig=upstream-signature",
      } });
    }
    const body = JSON.stringify({ schemaVersion: 2, mediaType: request.headers.get("Accept") });
    return new MockResponse(body, { headers: { "Content-Type": manifestType,
      "Content-Length": String(Buffer.byteLength(body)), "Docker-Content-Digest": digest } });
  } });
  t.after(() => f.mf.dispose());

  const headers = { Accept: manifestType };
  const response = await f.fetch("/v2/owner/image/manifests/latest?nonce=1", { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).schemaVersion, 2);
  assert.equal(response.headers.get("Docker-Content-Digest"), digest);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[0].headers.authorization, undefined);
  const alias = await f.fetch("/ghcr.io/v2/owner/image/manifests/latest?nonce=2", {
    headers: { Accept: `${manifestType}; q=0.9; random=value` },
  });
  await alias.text();
  assert.equal(f.requests.length, 3, "Accept parameters and route aliases share cache");

  const other = await f.fetch("/v2/owner/image/manifests/latest", {
    headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
  });
  await other.text();
  assert.equal(f.requests.length, 4, "different supported media types remain isolated");
  const layer = await f.fetch(`/v2/owner/image/blobs/${digest}`);
  assert.equal(await layer.text(), "layer");
  assert.equal(f.requests.length, 6, "repository token is reused for blob requests");
  assert.ok(f.requests.every(entry => !entry.url.includes("evil.test")));
  assert.equal((await f.fetch("/v2/owner/image/manifests/latest", { headers: { Accept: "text/html" } })).status, 406);
});

test("redirect restrictions, resource bounds, and response privacy", async t => {
  for (const location of ["https://evil.test/huge", "http://github.com/file", "https://user:pass@github.com/file",
    "https://github.com:444/file", "https://release-assets.githubusercontent.com.evil.test/file"]) {
    await t.test(`blocks redirect to ${location}`, async () => {
      const f = fixture({ upstream: () => new MockResponse(null, { status: 302, headers: { Location: location } }) });
      try {
        assert.equal((await f.fetch("/owner/repo/releases/download/v1/asset")).status, 502);
        assert.equal(f.requests.length, 1);
      } finally { await f.mf.dispose(); }
    });
  }
  await t.test("stops redirect loops after three hops", async () => {
    const f = fixture({ upstream: () => new MockResponse(null, { status: 302, headers: { Location: "https://github.com/loop" } }) });
    try {
      assert.equal((await f.fetch("/owner/repo/zipball/main")).status, 502);
      assert.equal(f.requests.length, 4);
    } finally { await f.mf.dispose(); }
  });
  await t.test("large downloads stream without application cache writes", async () => {
    const body = "x".repeat(1024 * 1024 + 1);
    const f = fixture({ upstream: () => new MockResponse(body, { headers: { "Content-Length": String(body.length) } }) });
    try {
      for (let i = 0; i < 2; i++) assert.equal((await (await f.fetch("/raw/o/r/main/large")).text()).length, body.length);
      assert.equal(f.requests.length, 2);
    } finally { await f.mf.dispose(); }
  });
  await t.test("cookies and private responses never enter the shared cache", async () => {
    const f = fixture({ upstream: () => new MockResponse("hello", { headers: {
      "Content-Length": "5", "Set-Cookie": "session=upstream", "Cache-Control": "private",
    } }) });
    try {
      for (let i = 0; i < 2; i++) {
        const response = await f.fetch("/raw/o/r/main/private");
        assert.equal(response.headers.get("Set-Cookie"), null);
        assert.equal(response.headers.get("Cache-Control"), "private, no-store");
        await response.text();
      }
      assert.equal(f.requests.length, 2);
    } finally { await f.mf.dispose(); }
  });
  await t.test("invalid and oversized GHCR token bodies fail safely", async () => {
    for (const body of ["not json", "null", JSON.stringify({ token: "x".repeat(65536) })]) {
      const f = fixture({ upstream(request) {
        return new URL(request.url).pathname === "/token" ? new MockResponse(body) : new MockResponse(null, { status: 401 });
      } });
      try {
        assert.equal((await f.fetch("/v2/owner/image/manifests/latest")).status, 502);
        assert.equal(f.requests.length, 2);
      } finally { await f.mf.dispose(); }
    }
  });
});

test("configuration fails closed, allowlists, and rate limits", async t => {
  await t.test("missing secret is blocked; anonymous access requires explicit opt-in", async () => {
    for (const [bindings, expected] of [
      [{ PROXY_TOKEN: "" }, 503],
      [{ PROXY_TOKEN: "", ALLOW_ANONYMOUS: "true", ANONYMOUS_ROUTES: "ghcr" }, 401],
      [{ PROXY_TOKEN: secret, ALLOW_ANONYMOUS: "true" }, 401],
    ]) {
      const f = fixture({ bindings });
      try {
        const response = await f.fetch("/v2/", { headers: { Authorization: "" } });
        assert.equal(response.status, expected);
        await response.text();
        assert.equal(f.requests.length, 0);
      } finally { await f.mf.dispose(); }
    }
  });
  await t.test("missing rate limit bindings block proxy downloads", async () => {
    const f = fixture({ ratelimits: {} });
    try {
      assert.equal((await f.fetch("/raw/o/r/main/file")).status, 503);
      assert.equal(f.requests.length, 0);
    } finally { await f.mf.dispose(); }
  });
  await t.test("repository restrictions apply before upstream/cache", async () => {
    const f = fixture({ bindings: { ALLOWED_GITHUB_REPOSITORIES: "owner/allowed", ALLOWED_GHCR_REPOSITORIES: "owner/allowed" } });
    try {
      assert.equal((await f.fetch("/raw/owner/repo/main/file")).status, 403);
      assert.equal((await f.fetch("/v2/owner/image/manifests/latest")).status, 403);
      assert.equal(f.requests.length, 0);
      assert.equal((await f.fetch("/raw/owner/allowed/main/file")).status, 200);
    } finally { await f.mf.dispose(); }
  });
  for (const limiter of ["IP_RATE_LIMITER", "TOTAL_RATE_LIMITER"]) {
    await t.test(`${limiter} rejects excess traffic before fetch`, async () => {
      const f = fixture({ ratelimits: {
        IP_RATE_LIMITER: { namespace_id: "1", simple: { limit: limiter === "IP_RATE_LIMITER" ? 1 : 100, period: 60 } },
        TOTAL_RATE_LIMITER: { namespace_id: "2", simple: { limit: limiter === "TOTAL_RATE_LIMITER" ? 1 : 100, period: 60 } },
      } });
      try {
        await (await f.fetch("/raw/o/r/main/one")).text();
        const response = await f.fetch("/raw/o/r/main/two");
        assert.equal(response.status, 429);
        assert.equal(response.headers.get("Retry-After"), "60");
        assert.equal(f.requests.length, 1);
      } finally { await f.mf.dispose(); }
    });
  }
});

test("client-supplied GHCR credentials for private images and OCI artifacts", async t => {
  const f = fixture({ upstream(request) {
    const url = new URL(request.url);
    if (url.pathname === "/token") {
      assert.equal(url.origin, "https://ghcr.io");
      assert.equal(url.searchParams.get("service"), "ghcr.io");
      assert.equal(request.headers.get("X-GHCR-Authorization"), null);
      const authorization = request.headers.get("Authorization");
      if (![basic("alice", "ghp_test_alice"), basic("bob", "ghp_test_bob")].includes(authorization)) {
        return new MockResponse(null, { status: 401 });
      }
      const scope = url.searchParams.get("scope");
      assert.ok(scope === null || /^repository:owner\/(?:image|artifact):pull$/.test(scope));
      return MockResponse.json({ token: authorization === basic("alice", "ghp_test_alice")
        ? "alice-private-token" : "bob-private-token", expires_in: 3600 });
    }
    if (url.hostname === "pkg-containers.githubusercontent.com") {
      assert.equal(request.headers.get("Authorization"), null);
      assert.equal(request.headers.get("X-GHCR-Authorization"), null);
      assert.equal(request.headers.get("Range"), "bytes=0-4");
      return new MockResponse("layer", { status: 206, headers: { "Content-Range": "bytes 0-4/10" } });
    }
    assert.match(request.headers.get("Authorization"), /^(?:Bearer alice-private-token|Bearer bob-private-token)$/);
    assert.equal(request.headers.get("X-GHCR-Authorization"), null);
    if (url.pathname === "/v2/") return new MockResponse("{}");
    if (url.pathname.includes("/blobs/")) {
      return new MockResponse(null, { status: 307, headers: {
        Location: "https://pkg-containers.githubusercontent.com/ghcr1/private?sig=signed",
      } });
    }
    const body = JSON.stringify({ schemaVersion: 2,
      artifactType: url.pathname.includes("/artifact/") ? "application/example" : undefined,
      identity: request.headers.get("Authorization") });
    return new MockResponse(request.method === "HEAD" ? null : body, { headers: {
      "Content-Type": manifestType, "Content-Length": String(Buffer.byteLength(body)),
      "Docker-Content-Digest": digest, "Cache-Control": "public, max-age=3600",
    } });
  } });
  t.after(() => f.mf.dispose());

  await t.test("explicit Basic ping validates the GitHub PAT without requesting repository access", async () => {
    const before = f.requests.length;
    const response = await f.fetch("/v2/", { headers: privateHeaders() });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "{}");
    assert.equal(f.requests.length, before + 2);
    assert.equal(new URL(f.requests[before].url).pathname, "/token");
    assert.equal(new URL(f.requests[before].url).searchParams.has("scope"), false);
    assert.equal(f.requests[before].headers.authorization, basic("alice", "ghp_test_alice"));
  });

  await t.test("reads private image/OCI manifests, digests, HEAD, and ranged blobs", async () => {
    for (const path of ["/v2/owner/image/manifests/latest", `/v2/owner/image/manifests/${digest}`,
      "/ghcr.io/v2/owner/artifact/manifests/v1"]) {
      const response = await f.fetch(path, { headers: privateHeaders() });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).schemaVersion, 2);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      assert.equal(response.headers.get("Docker-Content-Digest"), digest);
    }
    const head = await f.fetch("/v2/owner/image/manifests/latest", { method: "HEAD", headers: privateHeaders() });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const layer = await f.fetch(`/v2/owner/artifact/blobs/${digest}`, {
      headers: { ...privateHeaders(), Range: "bytes=0-4" },
    });
    assert.equal(layer.status, 206);
    assert.equal(await layer.text(), "layer");
    assert.ok(f.requests.every(entry => !entry.url.includes(secret) &&
      (entry.headers.authorization ?? "").indexOf(secret) === -1));
  });

  await t.test("never reuses private tokens or cached bytes across users or repeated requests", async () => {
    const before = f.requests.length;
    for (const [username, pat] of [["alice", "ghp_test_alice"], ["bob", "ghp_test_bob"], ["alice", "ghp_test_alice"]]) {
      const response = await f.fetch("/v2/owner/image/manifests/latest", { headers: privateHeaders(username, pat) });
      assert.equal((await response.json()).identity, `Bearer ${username}-private-token`);
    }
    assert.equal(f.requests.length, before + 6);
    const denied = await f.fetch("/v2/owner/image/manifests/latest", { headers: privateHeaders("alice", "ghp_wrong") });
    assert.equal(denied.status, 403);
    assert.equal(f.requests.length, before + 7, "invalid PAT cannot reuse another request's token/cache");
  });

  await t.test("HTTP header credentials work with independent proxy Bearer auth", async () => {
    const response = await f.fetch("/v2/owner/artifact/manifests/v1", {
      headers: { "X-GHCR-Authorization": basic("bob", "ghp_test_bob") },
    });
    assert.equal((await response.json()).identity, "Bearer bob-private-token");
  });

  await t.test("valid GitHub credentials cannot bypass the proxy secret", async () => {
    const before = f.requests.length;
    for (const headers of [privateHeaders("alice", "ghp_test_alice", "wrong-proxy"),
      { Authorization: basic("alice", "ghp_test_alice") },
      { Authorization: "Bearer wrong", "X-GHCR-Authorization": basic("alice", "ghp_test_alice") }]) {
      assert.equal((await f.fetch("/v2/owner/image/manifests/latest", { headers })).status, 401);
    }
    assert.equal(f.requests.length, before);
  });

  await t.test("malformed, ambiguous, or misplaced GitHub credentials are rejected locally", async () => {
    const before = f.requests.length;
    for (const headers of [privateHeaders("alice", ""), privateHeaders("bad user", "ghp_test"),
      { "X-GHCR-Authorization": "Bearer ghp_test" },
      { "X-GHCR-Authorization": "Basic !!!" },
      { ...privateHeaders(), "X-GHCR-Authorization": basic("alice", "ghp_test_alice") }]) {
      assert.equal((await f.fetch("/v2/owner/image/manifests/latest", { headers })).status, 400);
    }
    assert.equal((await f.fetch("/raw/owner/repo/main/file", {
      headers: { "X-GHCR-Authorization": basic("alice", "ghp_test_alice") },
    })).status, 400);
    assert.equal(f.requests.length, before);
    const preflight = await f.fetch("/v2/", { method: "OPTIONS" });
    assert.match(preflight.headers.get("Access-Control-Allow-Headers"), /X-GHCR-Authorization/);
  });
});

test("private authorization failures never fall back to anonymous access or shared caches", async t => {
  let allowed = true;
  const f = fixture({ upstream(request) {
    const url = new URL(request.url);
    const authorization = request.headers.get("Authorization");
    if (url.pathname === "/token") {
      if (!authorization) return MockResponse.json({ token: "anonymous-token" });
      assert.equal(authorization, basic("alice", "ghp_test_alice"));
      return MockResponse.json({ token: "private-token" });
    }
    if (authorization === "Bearer private-token") {
      if (!allowed) return new MockResponse(null, { status: 403 });
      return new MockResponse("private bytes", { headers: { "Content-Length": "13", "Cache-Control": "public" } });
    }
    if (url.pathname.includes("/private/")) return new MockResponse(null, { status: 403 });
    return new MockResponse("public bytes", { headers: { "Content-Length": "12", "Cache-Control": "public" } });
  } });
  t.after(() => f.mf.dispose());
  const path = "/v2/owner/image/manifests/latest";
  assert.equal(await (await f.fetch(path)).text(), "public bytes");
  const before = f.requests.length;
  assert.equal(await (await f.fetch(path, { headers: privateHeaders() })).text(), "private bytes");
  assert.equal(f.requests.length, before + 2, "credentialed reads bypass existing public cache");
  assert.equal(await (await f.fetch(path)).text(), "public bytes", "private bytes cannot overwrite public cache");
  allowed = false;
  assert.equal((await f.fetch(path, { headers: privateHeaders() })).status, 403, "revoked permission cannot use cached private bytes");
  const privatePath = "/v2/owner/private/manifests/latest";
  allowed = true;
  assert.equal(await (await f.fetch(privatePath, { headers: privateHeaders() })).text(), "private bytes");
  assert.equal((await f.fetch(privatePath)).status, 403, "another proxy user cannot read private bytes anonymously");
});

test("Git Smart HTTP cloning is read-only, bounded, and isolated from caches", async t => {
  const refs = "/https://github.com/owner/repo.git/info/refs?service=git-upload-pack";
  const rpc = "/https://github.com/owner/repo.git/git-upload-pack";
  const headers = { "Content-Type": "application/x-git-upload-pack-request", "Git-Protocol": "version=2" };
  const packet = Buffer.from("0014command=ls-refs\n00010000\0binary");

  await t.test("both URL formats relay discovery and binary/gzip negotiation without credentials or caches", async () => {
    const responseBytes = Buffer.from([0, 255, 1, 128, 10]);
    const f = fixture({ bindings: { PROXY_TOKEN: "", ANONYMOUS_ROUTES: "git" }, captureBody: true,
      upstream(request) {
        return new MockResponse(responseBytes, { headers: {
          "Content-Type": request.method === "POST" ? "application/x-git-upload-pack-result"
            : "application/x-git-upload-pack-advertisement",
          "Content-Length": String(responseBytes.length), "Cache-Control": "public, max-age=3600",
        } });
      } });
    try {
      for (const path of [refs, "/owner/repo.git/info/refs?service=git-upload-pack"]) {
        const response = await f.fetch(path, { headers: {
          Authorization: basic("private-user", "do-not-forward"), Cookie: "session=client", "Git-Protocol": "version=2",
        } });
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), responseBytes);
        assert.equal(response.headers.get("Content-Type"), "application/x-git-upload-pack-advertisement");
        assert.equal(response.headers.get("Set-Cookie"), null);
        assert.equal(response.headers.get("Cache-Control"), "private, no-store");
        assert.equal(f.requests.at(-1).url, "https://github.com/owner/repo.git/info/refs?service=git-upload-pack");
        assert.equal(f.requests.at(-1).method, "GET");
      }
      for (const encoding of [undefined, "gzip"]) {
        const body = encoding ? gzipSync(packet) : packet;
        const response = await f.fetch(encoding ? rpc : "/owner/repo.git/git-upload-pack", { method: "POST", body,
          headers: { ...headers, ...(encoding ? { "Content-Encoding": encoding } : {}), Cookie: "client=secret" } });
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), responseBytes);
        assert.equal(response.headers.get("Content-Type"), "application/x-git-upload-pack-result");
        const upstream = f.requests.at(-1);
        assert.equal(upstream.url, "https://github.com/owner/repo.git/git-upload-pack");
        assert.equal(upstream.method, "POST");
        assert.equal(upstream.headers["content-type"], headers["Content-Type"]);
        assert.equal(upstream.headers["content-encoding"], encoding);
        assert.deepEqual(upstream.body, body);
      }
      assert.equal(f.requests.length, 4, "every negotiation reaches GitHub despite public upstream cache headers");
      for (const request of f.requests) {
        assert.equal(request.headers["git-protocol"], "version=2");
        assert.equal(request.headers.authorization, undefined);
        assert.equal(request.headers.cookie, undefined);
        assert.equal(request.headers["x-ghcr-authorization"], undefined);
      }
      const preflight = await f.fetch(rpc, { method: "OPTIONS" });
      assert.match(preflight.headers.get("Access-Control-Allow-Methods"), /POST/);
      assert.match(preflight.headers.get("Access-Control-Allow-Headers"), /Git-Protocol/);
    } finally { await f.mf.dispose(); }
  });

  await t.test("proxy authentication and the master switch protect discovery and POST alike", async () => {
    for (const bindings of [{ ANONYMOUS_ROUTES: "raw" }, { ANONYMOUS_ROUTES: "git", ALLOW_ANONYMOUS: "false" }]) {
      const f = fixture({ bindings });
      try {
        for (const Authorization of ["", "Bearer wrong"]) {
          assert.equal((await f.fetch(refs, { headers: { Authorization } })).status, 401);
          assert.equal((await f.fetch(rpc, { method: "POST", body: packet, headers: { ...headers, Authorization } })).status, 401);
        }
        assert.equal(f.requests.length, 0);
        assert.equal((await f.fetch(refs, { headers: { Authorization: basic("proxy", secret) } })).status, 200);
        assert.equal((await f.fetch(rpc, { method: "POST", body: packet, headers })).status, 200);
        assert.ok(f.requests.every(request => !request.headers.authorization));
      } finally { await f.mf.dispose(); }
    }
  });

  await t.test("only the two download endpoints, their methods, and exact service parameter are accepted", async () => {
    const f = fixture({ bindings: { ANONYMOUS_ROUTES: "git" } });
    try {
      for (const path of [
        "/https://github.com/owner/repo.git/info/refs", refs + "&nonce=1", refs + "&service=git-upload-pack",
        refs.replace("git-upload-pack", "git-receive-pack"), rpc + "?service=git-upload-pack",
        "/https://github.com/owner/repo.git/git-receive-pack", "/owner/repo.git/git-receive-pack",
        "/https://github.com/owner/repo.git/objects/info/packs",
        "/https://github.com.evil.test/owner/repo.git/info/refs?service=git-upload-pack",
        "/https://github.com@evil.test/owner/repo.git/info/refs?service=git-upload-pack",
        "/https://user:pass@github.com/owner/repo.git/info/refs?service=git-upload-pack",
        "/https://github.com:444/owner/repo.git/info/refs?service=git-upload-pack",
        "/http://github.com/owner/repo.git/info/refs?service=git-upload-pack",
        "/https://github.com/owner/repo.git%2fextra/info/refs?service=git-upload-pack",
        "/https://github.com/owner/%2e%2egit/info/refs?service=git-upload-pack",
        "/https://github.com/owner/repo/archive/refs/heads/main.zip",
      ]) assert.equal((await f.fetch(path)).status, 404, path);
      for (const [path, method] of [[rpc, "GET"], [rpc, "HEAD"], [rpc, "PUT"], [refs, "POST"],
        ["/raw/owner/repo/main/file", "POST"], [rpc.replace("git-upload-pack", "git-receive-pack"), "POST"]]) {
        assert.equal((await f.fetch(path, { method, ...(method === "POST" || method === "PUT" ? { body: packet } : {}), headers })).status, 405);
      }
      assert.equal(f.requests.length, 0);
    } finally { await f.mf.dispose(); }
  });

  await t.test("invalid negotiation headers and empty/oversized bodies are rejected before contacting GitHub", async () => {
    const f = fixture({ bindings: { ANONYMOUS_ROUTES: "git" } });
    try {
      assert.equal((await f.fetch(refs, { headers: { "Git-Protocol": "version=2:untrusted=value" } })).status, 400);
      for (const invalid of [{ "Content-Type": "text/plain" }, { "Content-Encoding": "br" }]) {
        assert.equal((await f.fetch(rpc, { method: "POST", body: packet, headers: { ...headers, ...invalid } })).status, 415);
      }
      assert.equal((await f.fetch(rpc, { method: "POST", headers })).status, 400);
      const oversized = Buffer.alloc(1024 * 1024 + 1, 120);
      assert.equal((await f.fetch(rpc, { method: "POST", headers, body: oversized })).status, 413);
      assert.equal((await f.fetch(rpc, { method: "POST", headers, duplex: "half", body: new ReadableStream({
        start(controller) { controller.enqueue(oversized); controller.close(); },
      }) })).status, 413, "chunked requests without Content-Length have the same bound");
      assert.equal(f.requests.length, 0);
      assert.equal((await f.fetch(rpc, { method: "POST", headers, body: oversized.subarray(0, 1024 * 1024) })).status, 200);
    } finally { await f.mf.dispose(); }
  });

  await t.test("Git repository allowlists and quotas cover discovery and POST", async () => {
    const f = fixture({ bindings: { ANONYMOUS_ROUTES: "git", ALLOWED_GITHUB_REPOSITORIES: "OWNER/allowed" }, ratelimits: {
      IP_RATE_LIMITER: { namespace_id: "1", simple: { limit: 100, period: 60 } },
      TOTAL_RATE_LIMITER: { namespace_id: "2", simple: { limit: 1, period: 60 } },
    } });
    try {
      assert.equal((await f.fetch(refs)).status, 403);
      assert.equal((await f.fetch(rpc, { method: "POST", body: packet, headers })).status, 403);
      assert.equal(f.requests.length, 0);
      assert.equal((await f.fetch(refs.replace("repo.git", "allowed.git"))).status, 200);
      assert.equal((await f.fetch(rpc.replace("repo.git", "allowed.git"), { method: "POST", body: packet, headers })).status, 429);
      assert.equal(f.requests.length, 1);
    } finally { await f.mf.dispose(); }
  });

  await t.test("Git redirects cannot change repositories, services, hosts, or POST semantics", async () => {
    for (const location of ["https://github.com/owner/repo.git/git-receive-pack",
      "https://github.com/owner/other.git/info/refs?service=git-upload-pack", "https://github.com/owner/repo/archive/main.zip",
      "https://codeload.github.com/owner/repo.git/info/refs?service=git-upload-pack",
      "https://evil.test/owner/repo.git/info/refs?service=git-upload-pack"]) {
      const f = fixture({ upstream: () => new MockResponse(null, { status: 307, headers: { Location: location } }) });
      try {
        assert.equal((await f.fetch(refs)).status, 502, location);
        assert.equal(f.requests.length, 1);
      } finally { await f.mf.dispose(); }
    }
    for (const status of [301, 302, 303, 307, 308]) {
      const f = fixture({ captureBody: true, upstream(request, requests) {
        return requests.length === 1 ? new MockResponse(null, { status, headers: {
          Location: "https://github.com/OWNER/repo.git/git-upload-pack",
        } }) : new MockResponse("pack");
      } });
      try {
        const response = await f.fetch(rpc, { method: "POST", body: packet, headers });
        assert.equal(response.status, status >= 307 ? 200 : 502);
        if (status >= 307) {
          assert.equal(await response.text(), "pack");
          assert.deepEqual(f.requests[1].body, packet);
          assert.equal(f.requests[1].method, "POST");
        }
      } finally { await f.mf.dispose(); }
    }
  });

  await t.test("private GitHub repositories return access denied without a misleading proxy challenge", async () => {
    const f = fixture({ bindings: { ANONYMOUS_ROUTES: "git" }, upstream: () => new MockResponse(null, {
      status: 401, headers: { "WWW-Authenticate": "Basic realm=GitHub" },
    }) });
    try {
      const response = await f.fetch(refs, { headers: { Authorization: "" } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("WWW-Authenticate"), null);
      assert.match(await response.text(), /private or unavailable/);
    } finally { await f.mf.dispose(); }
  });
});

test("private credentials respect anonymous configuration, allowlists, and resource limits", async t => {
  await t.test("explicit anonymous mode supports native username/PAT login and rejects malformed Basic", async () => {
    const f = fixture({ bindings: { PROXY_TOKEN: "", ALLOW_ANONYMOUS: "true", ANONYMOUS_ROUTES: "ghcr" }, upstream(request) {
      if (new URL(request.url).pathname === "/token") {
        assert.equal(request.headers.get("Authorization"), basic("alice", "ghp_test_alice"));
        return MockResponse.json({ token: "private-token" });
      }
      assert.equal(request.headers.get("Authorization"), "Bearer private-token");
      return new MockResponse("{}");
    } });
    try {
      assert.equal((await f.fetch("/v2/", { headers: { Authorization: basic("alice", "ghp_test_alice") } })).status, 200);
      assert.equal((await f.fetch("/v2/", { headers: { Authorization: "Basic !!!" } })).status, 400);
    } finally { await f.mf.dispose(); }
  });
  await t.test("private credentials do not bypass repository allowlists", async () => {
    const f = fixture({ bindings: { ALLOWED_GHCR_REPOSITORIES: "owner/allowed" } });
    try {
      assert.equal((await f.fetch("/v2/owner/private/manifests/latest", { headers: privateHeaders() })).status, 403);
      assert.equal(f.requests.length, 0);
    } finally { await f.mf.dispose(); }
  });
  await t.test("private token acquisition is covered by request rate limits", async () => {
    const f = fixture({ ratelimits: {
      IP_RATE_LIMITER: { namespace_id: "1", simple: { limit: 100, period: 60 } },
      TOTAL_RATE_LIMITER: { namespace_id: "2", simple: { limit: 1, period: 60 } },
    } });
    try {
      await (await f.fetch("/v2/")).text();
      assert.equal((await f.fetch("/v2/", { headers: privateHeaders() })).status, 429);
      assert.equal(f.requests.length, 0);
    } finally { await f.mf.dispose(); }
  });
  await t.test("token endpoint redirects cannot leak PATs to an attacker", async () => {
    const f = fixture({ upstream: () => new MockResponse(null, { status: 302,
      headers: { Location: "https://evil.test/steal" } }) });
    try {
      assert.equal((await f.fetch("/v2/", { headers: privateHeaders() })).status, 502);
      assert.equal(f.requests.length, 1);
      assert.equal(new URL(f.requests[0].url).origin, "https://ghcr.io");
    } finally { await f.mf.dispose(); }
  });
});
