import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "../../apps/server/dist/app.js";

async function setup(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-launcher-products-"));
  const options = { dataDir, logger: false, engines: [], launcherSecurity: { controlToken: "owned-launcher-control" } };
  let app = createServer(options);
  await app.ready();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    inject: options => app.inject(options),
    token: async () => {
      const reply = await app.inject({ method: "POST", url: "/api/launcher/bootstrap", headers: { authorization: "Bearer owned-launcher-control" } });
      assert.equal(reply.statusCode, 200);
      return reply.json().token;
    },
    reopen: async () => { await app.close(); app = createServer(options); await app.ready(); },
  };
}

// Execute the browser script actually delivered by the server. Fetch uses the
// real session exchange, so a wrong destination cannot hide a failed login.
async function open(f, query, token) {
  const script = await f.inject({ method: "GET", url: "/__ponderosa_bootstrap.js" });
  assert.equal(script.statusCode, 200);
  assert.equal(script.headers["cache-control"], "no-store");
  let current = new URL("http://localhost/__ponderosa_bootstrap" + query + (token ? "#" + encodeURIComponent(token) : ""));
  const result = { redirects: [], exchanges: 0, cookie: undefined, status: { textContent: "" } };
  await vm.runInNewContext(script.body, {
    URLSearchParams,
    navigator: {},
    document: { getElementById: () => result.status },
    location: {
      get hash() { return current.hash; },
      get search() { return current.search; },
      replace(destination) { result.redirects.push(destination); },
    },
    history: { replaceState(_state, _title, url) { current = new URL(url, current); } },
    async fetch(url, options) {
      result.exchanges++;
      assert.equal(current.hash, "", "Clear the bootstrap secret before exchanging it");
      const reply = await f.inject({ method: options.method, url, headers: options.headers, payload: options.body });
      result.cookie = reply.headers["set-cookie"];
      return { ok: reply.statusCode === 204 };
    },
  });
  return result;
}

test("authenticated launcher destinations keep the two UIs and reject arbitrary redirects", async t => {
  const f = await setup(t);
  const cases = [
    ["", "/"],
    ["?next=%2F", "/"],
    ["?next=%2Fbranches", "/branches"],
    ["?next=/branches", "/branches"],
    ["?next=https%3A%2F%2Fexample.com", "/"],
    ["?next=%2F%2Fexample.com", "/"],
    ["?next=javascript%3Aalert(1)", "/"],
    ["?next=%252Fbranches", "/"],
    ["?next=%2Fbranches%2Fother", "/"],
    ["?next=%2Fbranches%3Fother%3D1", "/"],
    ["?next=%2Fbranches%23fragment", "/"],
    ["?next=%20%2Fbranches", "/"],
    ["?next=%5C%5Cexample.com", "/"],
    ["?next=", "/"],
  ];
  for (const [query, destination] of cases) await t.test(query || "CLI launch without next", async () => {
    const result = await open(f, query, await f.token());
    assert.deepEqual(result.redirects, [destination]);
    assert.equal(result.exchanges, 1);
    assert.match(result.cookie, /HttpOnly; SameSite=Strict; Path=\//);
  });
});

test("failed or reused bootstrap never navigates; missing proof cannot grant API access", async t => {
  const f = await setup(t), token = await f.token();
  assert.deepEqual((await open(f, "?next=%2Fbranches", token)).redirects, ["/branches"]);
  for (const value of [token, "invalid-bootstrap"]) {
    const result = await open(f, "?next=%2Fbranches", value);
    assert.deepEqual(result.redirects, []);
    assert.equal(result.exchanges, 1);
    assert.equal(result.cookie, undefined);
    assert.match(result.status.textContent, /expired or was already used/);
  }
  const missing = await open(f, "?next=%2Fbranches");
  assert.equal(missing.exchanges, 0);
  assert.deepEqual(missing.redirects, ["/branches"]);
  for (const url of ["/api/projects", "/api/branches"]) {
    assert.equal((await f.inject({ method: "GET", url })).statusCode, 401);
  }
  assert.equal((await f.inject({ method: "POST", url: "/api/launcher/bootstrap" })).statusCode, 401);
});

test("both launcher actions establish the same engine session boundary across restart", async t => {
  const f = await setup(t), cookies = [];
  for (const query of ["?next=%2F", "?next=%2Fbranches"]) {
    cookies.push((await open(f, query, await f.token())).cookie.split(";", 1)[0]);
  }
  const check = async () => {
    for (const cookie of cookies) for (const url of ["/api/projects", "/api/branches"]) {
      const reply = await f.inject({ method: "GET", url, headers: { cookie } });
      assert.equal(reply.statusCode, 200);
      assert.deepEqual(reply.json(), []);
    }
  };
  await check();
  await f.reopen();
  await check();
});
