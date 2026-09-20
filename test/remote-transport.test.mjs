// Offline acceptance for the private UDS-only MCP transport.
//
// Everything here runs against a real Unix-domain socket and a real HTTP client:
// no mock server, no TCP listener, no network. The only injected seam is the
// downstream `fetch`, because the whole point of these tests is what the worker
// does with a capture response it never really makes.
//
// The properties under test are the ones that fail silently in production:
// a request context that leaks between two users, a key that reaches a log, a
// deadline that stops guarding once the headers arrive, a caller that hangs up
// while the renderer keeps running.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import {
  mkdtempSync,
  rmSync,
  statSync,
  existsSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createUdsWorker, configFromEnv } from "../src/uds-worker.js";
import { captureScreenshot } from "../src/server.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The worker must never read this, on any path, for any reason.
const POISON_ENV_KEY = "POISON_ENV_KEY_MUST_NEVER_BE_SENT";
process.env.SITESHOT_API_KEY = POISON_ENV_KEY;

/** A private directory that only this test owns, cleaned up by the caller. */
function privateDir() {
  // os.tmpdir() keeps the socket path inside the ~104 byte sun_path limit.
  const dir = mkdtempSync(join(tmpdir(), "ss-uds-"));
  chmodSync(dir, 0o700);
  return dir;
}

/** Baseline config: every bound is explicit, because the worker refuses to invent one. */
function baseConfig(dir, overrides = {}) {
  return {
    socketPath: join(dir, "m.sock"),
    socketMode: 0o600,
    allowedHosts: ["localhost"],
    maxRequestBytes: 64 * 1024,
    maxImageBytes: 1024 * 1024,
    maxResponseBytes: 2 * 1024 * 1024,
    maxErrorBodyBytes: 64 * 1024,
    maxConcurrentRequests: 2,
    captureTimeoutMs: 90_000,
    requestBodyTimeoutMs: 10_000,
    fetchImpl: async () => {
      throw new Error("fetch must not be reached in this test");
    },
    logger: () => {},
    ...overrides,
  };
}

/**
 * One HTTP request over the socket. Returns status, headers and the raw body,
 * or lets the caller drive the socket directly via `onRequest`.
 */
function udsRequest(socketPath, { method = "POST", path = "/mcp", headers = {}, body, onRequest } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    if (onRequest) {
      onRequest(req);
      return;
    }
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The header trio the future Django adapter synthesises from validated server state. */
function ctx({ subject = "user-1", key = "KEY-1", correlation = "corr-1" } = {}) {
  return {
    "x-siteshot-subject": subject,
    "x-siteshot-api-key": key,
    "x-siteshot-correlation-id": correlation,
  };
}

/** Headers a well-behaved MCP client sends on every POST. */
function mcpHeaders(extra = {}) {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...ctx(),
    ...extra,
  };
}

/** POST one JSON-RPC message and parse the JSON response. */
async function rpc(socketPath, message, { headers = {}, ...rest } = {}) {
  const body = typeof message === "string" ? message : JSON.stringify(message);
  const res = await udsRequest(socketPath, {
    headers: { ...mcpHeaders(headers), "content-length": Buffer.byteLength(body) },
    body,
    ...rest,
  });
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = undefined;
  }
  return { ...res, json };
}

/** Start a worker and guarantee it is closed and its directory removed. */
async function withWorker(t, overrides = {}, fn) {
  const dir = privateDir();
  const config = baseConfig(dir, overrides);
  const worker = createUdsWorker(config);
  await worker.start();
  t.after(async () => {
    await worker.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return fn ? fn(worker, config) : { worker, config, dir };
}

// ---------------------------------------------------------------------------
// Configuration: every bound is mandatory. A missing one is a startup failure,
// never a number this package invented on the operator's behalf.
// ---------------------------------------------------------------------------

test("every bound must be configured explicitly", () => {
  const dir = privateDir();
  try {
    const required = [
      "socketPath",
      "socketMode",
      "allowedHosts",
      "maxRequestBytes",
      "maxImageBytes",
      "maxResponseBytes",
      "maxErrorBodyBytes",
      "maxConcurrentRequests",
      "captureTimeoutMs",
      "requestBodyTimeoutMs",
    ];
    for (const field of required) {
      const config = baseConfig(dir);
      delete config[field];
      assert.throws(
        () => createUdsWorker(config),
        (err) => err instanceof Error && err.message.includes(field),
        `missing ${field} must fail construction and name the field`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid bounds are rejected rather than coerced", () => {
  const dir = privateDir();
  try {
    const bad = [
      ["maxRequestBytes", 0],
      ["maxRequestBytes", -1],
      ["maxRequestBytes", 1.5],
      ["maxRequestBytes", "64000"],
      ["maxImageBytes", 0],
      ["maxResponseBytes", 0],
      // Too small to hold even the refusal it would have to send instead.
      ["maxResponseBytes", 64],
      ["maxErrorBodyBytes", 0],
      ["maxConcurrentRequests", 0],
      ["captureTimeoutMs", 0],
      ["requestBodyTimeoutMs", 0],
      ["socketPath", "relative/m.sock"],
      ["allowedHosts", []],
      ["allowedHosts", "localhost"],
      ["socketMode", 0o666],
    ];
    for (const [field, value] of bad) {
      assert.throws(
        () => createUdsWorker(baseConfig(dir, { [field]: value })),
        (err) => err instanceof Error && err.message.includes(field),
        `${field}=${String(value)} must be rejected`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Socket lifecycle: this process owns exactly one socket, in a directory it
// checked, and it removes nothing it did not create.
// ---------------------------------------------------------------------------

test("listens on the configured socket and never on a TCP port", async (t) => {
  const { worker, config } = await withWorker(t);
  assert.equal(typeof worker.address(), "string", "address must be a socket path, not {port}");
  assert.equal(worker.address(), config.socketPath);
  // What Node itself is bound to. An object here would mean a TCP port exists.
  const bound = worker.listenerAddress();
  assert.equal(typeof bound, "string", `the listener must be a pipe, got ${JSON.stringify(bound)}`);
  assert.equal(bound.startsWith(config.socketPath.replace(/[^/]+$/, "")), true, "and inside the private directory");
  assert.ok(statSync(config.socketPath).isSocket(), "the path is a real socket");
  assert.equal(statSync(config.socketPath).mode & 0o777, 0o600, "socket carries the configured mode");
});

test("refuses a world-writable parent directory", async () => {
  const dir = privateDir();
  try {
    chmodSync(dir, 0o707);
    const worker = createUdsWorker(baseConfig(dir));
    await assert.rejects(() => worker.start(), /world-writable/i);
    assert.equal(existsSync(join(dir, "m.sock")), false, "no socket is left behind on a refused start");
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses to start on top of an existing path and leaves it untouched", async () => {
  const dir = privateDir();
  const sockPath = join(dir, "m.sock");
  try {
    writeFileSync(sockPath, "not-a-socket-and-not-ours");
    const worker = createUdsWorker(baseConfig(dir));
    await assert.rejects(() => worker.start(), /already exists/i);
    assert.equal(statSync(sockPath).isFile(), true, "the pre-existing path survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a symlinked parent directory", async () => {
  const real = privateDir();
  const link = join(real, "..", `ss-uds-link-${process.pid}`);
  try {
    symlinkSync(real, link);
    const worker = createUdsWorker(baseConfig(link));
    await assert.rejects(() => worker.start(), /symlink/i);
  } finally {
    unlinkSync(link);
    rmSync(real, { recursive: true, force: true });
  }
});

test("shutdown removes only the socket it created, and restart is clean", async () => {
  const dir = privateDir();
  const neighbour = join(dir, "someone-elses.sock");
  try {
    mkdirSync(join(dir, "sub"), { mode: 0o700 });
    writeFileSync(neighbour, "");
    const first = createUdsWorker(baseConfig(dir));
    await first.start();
    assert.ok(statSync(join(dir, "m.sock")).isSocket());
    await first.close();
    assert.equal(existsSync(join(dir, "m.sock")), false, "own socket removed on shutdown");
    assert.equal(existsSync(neighbour), true, "an unrelated path in the same directory is untouched");

    const second = createUdsWorker(baseConfig(dir));
    await second.start();
    assert.ok(statSync(join(dir, "m.sock")).isSocket(), "restart succeeds after a clean shutdown");
    await second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Method / path / session policy. Each rejection is explicit; nothing silently
// downgrades to a capability this transport does not have.
// ---------------------------------------------------------------------------

test("only POST /mcp is served", async (t) => {
  const { config } = await withWorker(t);
  const sock = config.socketPath;

  const get = await udsRequest(sock, { method: "GET", path: "/mcp", headers: mcpHeaders() });
  assert.equal(get.status, 405, "GET streaming is refused, not downgraded");
  assert.equal(JSON.parse(get.body).error.data.reason, "method_not_allowed");
  assert.equal(get.headers.allow, "POST");

  for (const method of ["DELETE", "PUT", "PATCH", "HEAD"]) {
    const res = await udsRequest(sock, { method, path: "/mcp", headers: mcpHeaders() });
    assert.equal(res.status, 405, `${method} is refused`);
  }

  for (const path of ["/", "/mcp/", "/mcp/extra", "/sse", "/mcp?x=1"]) {
    const res = await udsRequest(sock, { path, headers: mcpHeaders(), body: "{}" });
    assert.equal(res.status, 404, `${path} is not served`);
    assert.equal(JSON.parse(res.body).error.data.reason, "not_found");
  }
});

test("a supplied Mcp-Session-Id is rejected, never treated as identity", async (t) => {
  const { config } = await withWorker(t);
  const res = await rpc(config.socketPath, { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
    headers: { "mcp-session-id": "pretend-this-authenticates-me" },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.data.reason, "session_not_supported");
});

test("public credential and forwarded-authority headers are refused", async (t) => {
  const { config } = await withWorker(t);
  const forbidden = {
    authorization: "Bearer not-a-real-token",
    "proxy-authorization": "Basic nope",
    cookie: "sessionid=abc",
    origin: "https://evil.example",
    "x-forwarded-for": "203.0.113.9",
    "x-forwarded-host": "mcp.site-shot.com",
    "x-forwarded-proto": "https",
    forwarded: "for=203.0.113.9",
  };
  for (const [name, value] of Object.entries(forbidden)) {
    const res = await rpc(config.socketPath, { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      headers: { [name]: value },
    });
    assert.equal(res.status, 403, `${name} must be refused`);
    assert.equal(res.json.error.data.reason, "forbidden_header");
    assert.ok(!res.body.includes(value), `${name} value must not be echoed back`);
  }
});

test("an unsupported Host is refused", async (t) => {
  const { config } = await withWorker(t);
  const res = await rpc(config.socketPath, { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
    headers: { host: "mcp.site-shot.com" },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.data.reason, "host_not_allowed");
});

// ---------------------------------------------------------------------------
// Internal context. The socket is the trust boundary; these headers are only
// how the adapter hands over what it already validated.
// ---------------------------------------------------------------------------

/** A recording fetch. Every capture the worker makes lands in `calls`. */
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url, signal: init?.signal, aborted: false };
    init?.signal?.addEventListener("abort", () => {
      call.aborted = true;
    });
    calls.push(call);
    return handler(url, init, calls.length - 1);
  };
  return { fetchImpl, calls };
}

const okImage = (bytes = PNG, contentType = "image/png") =>
  new Response(bytes, { status: 200, headers: { "content-type": contentType } });

test("a missing, duplicated or malformed context is refused before any capture", async (t) => {
  const { fetchImpl, calls } = makeFetch(() => okImage());
  const { config } = await withWorker(t, { fetchImpl });
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "capture_screenshot", arguments: { url: "https://example.com" } } };

  for (const name of Object.values({ s: "x-siteshot-subject", k: "x-siteshot-api-key", c: "x-siteshot-correlation-id" })) {
    const headers = mcpHeaders();
    delete headers[name];
    const body = JSON.stringify(call);
    const res = await udsRequest(config.socketPath, { headers: { ...headers, "content-length": Buffer.byteLength(body) }, body });
    assert.equal(res.status, 403, `${name} missing must be refused`);
    assert.equal(JSON.parse(res.body).error.data.reason, "context_missing");

    const dup = await rpc(config.socketPath, call, { headers: { [name]: ["one", "two"] } });
    assert.equal(dup.status, 403, `${name} duplicated must be refused`);
    assert.equal(dup.json.error.data.reason, "context_duplicate");
  }

  for (const value of ["", "has space", "tab\there".replace("\t", " "), "x".repeat(600), "ünicode"]) {
    const res = await rpc(config.socketPath, call, { headers: { "x-siteshot-api-key": value } });
    assert.equal(res.status, 403, `key ${JSON.stringify(value)} must be refused`);
    assert.match(JSON.parse(res.body).error.data.reason, /^context_(invalid|missing)$/);
  }

  assert.equal(calls.length, 0, "no capture may be attempted for a request with no valid context");
});

test("the process environment key is never a fallback identity", async (t) => {
  const { fetchImpl, calls } = makeFetch(() => okImage());
  const { config } = await withWorker(t, { fetchImpl });
  assert.equal(process.env.SITESHOT_API_KEY, POISON_ENV_KEY, "the poison key is set for this whole file");

  const headers = mcpHeaders();
  delete headers["x-siteshot-api-key"];
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "capture_screenshot", arguments: { url: "https://example.com" } },
  });
  const res = await udsRequest(config.socketPath, {
    headers: { ...headers, "content-length": Buffer.byteLength(body) },
    body,
  });
  assert.equal(res.status, 403, "no environment key stands in for a missing context");
  assert.equal(calls.length, 0);

  // And with a valid context, the key that goes upstream is the request's own.
  const good = await rpc(config.socketPath, JSON.parse(body), { headers: ctx({ key: "REQUEST-OWNED-KEY" }) });
  assert.equal(good.status, 200);
  assert.equal(new URL(calls[0].url).searchParams.get("userkey"), "REQUEST-OWNED-KEY");
  assert.ok(!calls[0].url.includes(POISON_ENV_KEY), "the environment key never reaches the API");
});

// ---------------------------------------------------------------------------
// The MCP session itself: one fresh stateless instance per POST.
// ---------------------------------------------------------------------------

test("initialize negotiates 2025-11-25 and issues no session", async (t) => {
  const { config } = await withWorker(t);
  const res = await rpc(config.socketPath, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "acceptance", version: "0.0.0" } },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /application\/json/);
  assert.equal(res.headers["mcp-session-id"], undefined, "a stateless transport issues no session id");
  assert.equal(res.json.result.protocolVersion, "2025-11-25");
  assert.equal(res.json.result.serverInfo.name, "site-shot");
  assert.equal(res.json.id, 1);
});

test("tools/list serves exactly the two existing tools, unchanged", async (t) => {
  const { config } = await withWorker(t);
  const res = await rpc(config.socketPath, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(res.status, 200);
  const names = res.json.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["capture_full_page", "capture_screenshot"], "exactly two tools, same names");

  const capture = res.json.result.tools.find((tool) => tool.name === "capture_screenshot");
  const full = res.json.result.tools.find((tool) => tool.name === "capture_full_page");
  const shared = ["url", "width", "height", "format", "block_ads", "block_cookie_banners", "country", "strict_country", "language", "time_zone", "geolocation", "wait_ms", "max_height"];
  assert.deepEqual(Object.keys(capture.inputSchema.properties).sort(), [...shared, "full_page"].sort());
  assert.deepEqual(Object.keys(full.inputSchema.properties).sort(), [...shared].sort());
  assert.match(capture.inputSchema.properties.country.description, /ISO 3166-1 alpha-2/);
  for (const param of ["width", "height", "wait_ms"]) {
    assert.doesNotMatch(capture.inputSchema.properties[param].description, /[0-9]/, `${param} names no invented default`);
  }
});

test("both tools capture through the shared implementation", async (t) => {
  const { fetchImpl, calls } = makeFetch(() => okImage());
  const { config } = await withWorker(t, { fetchImpl });

  const shot = await rpc(config.socketPath, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "capture_screenshot", arguments: { url: "example.com", country: "de" } },
  });
  assert.equal(shot.status, 200);
  assert.equal(shot.json.result.isError, undefined);
  assert.equal(shot.json.result.content[0].type, "image");
  assert.equal(shot.json.result.content[0].mimeType, "image/png");
  assert.equal(Buffer.from(shot.json.result.content[0].data, "base64").toString("hex"), PNG.toString("hex"));
  const first = new URL(calls[0].url);
  assert.equal(first.searchParams.get("url"), "https://example.com", "bare domains still get https://");
  assert.equal(first.searchParams.get("country"), "DE");
  assert.equal(first.searchParams.get("strict_country"), "1", "strict country is still the default");
  assert.equal(first.searchParams.get("full_size"), null);

  const page = await rpc(config.socketPath, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "capture_full_page", arguments: { url: "https://example.com" } },
  });
  assert.equal(page.json.result.content[0].type, "image");
  const second = new URL(calls[1].url);
  assert.equal(second.searchParams.get("full_size"), "1");
  assert.equal(second.searchParams.get("max_height"), "20000");
});

test("notifications are acknowledged without a response body", async (t) => {
  const { config } = await withWorker(t);
  const res = await rpc(config.socketPath, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
  assert.equal(res.body, "");
});

test("the SDK owns protocol errors; the worker owns the envelope", async (t) => {
  const { fetchImpl, calls } = makeFetch(() => okImage());
  const { config } = await withWorker(t, { fetchImpl });
  const sock = config.socketPath;

  const badJson = await rpc(sock, "{not json");
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, -32700);

  const badMessage = await rpc(sock, { hello: "world" });
  assert.equal(badMessage.status, 400);
  assert.equal(badMessage.json.error.code, -32700);

  const badVersion = await rpc(sock, { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
    headers: { "mcp-protocol-version": "1999-01-01" },
  });
  assert.equal(badVersion.status, 400);
  assert.match(badVersion.json.error.message, /Unsupported protocol version/);

  const badContentType = await rpc(sock, { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
    headers: { "content-type": "text/plain" },
  });
  assert.equal(badContentType.status, 415);

  const badAccept = await rpc(sock, { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
    headers: { accept: "application/json" },
  });
  assert.equal(badAccept.status, 406, "JSON-only clients are told, not silently streamed to");

  const unknownMethod = await rpc(sock, { jsonrpc: "2.0", id: 9, method: "resources/list" });
  assert.equal(unknownMethod.status, 200);
  assert.equal(unknownMethod.json.error.code, -32601);

  const unknownTool = await rpc(sock, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "capture_markdown", arguments: {} },
  });
  assert.ok(unknownTool.json.error || unknownTool.json.result?.isError, "an unregistered tool is an error");

  assert.equal(calls.length, 0, "no protocol error may reach the capture API");
});

test("two users sharing one JSON-RPC id stay independent, and a rotated key takes effect next request", async (t) => {
  const seen = [];
  const fetchImpl = async (url) => {
    const key = new URL(url).searchParams.get("userkey");
    seen.push(key);
    // A distinct body per user, so a crossed response is visible in the bytes.
    return okImage(Buffer.from(`image-for-${key}`));
  };
  const { config } = await withWorker(t, { fetchImpl });
  const callFor = (key, id) =>
    rpc(config.socketPath, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "capture_screenshot", arguments: { url: `https://${key}.example` } },
    }, { headers: ctx({ subject: `subject-${key}`, key, correlation: `corr-${key}` }) });

  // Same JSON-RPC id, two different users, in flight together.
  const [a, b] = await Promise.all([callFor("KEY-A", 42), callFor("KEY-B", 42)]);
  assert.equal(a.json.id, 42);
  assert.equal(b.json.id, 42);
  assert.equal(Buffer.from(a.json.result.content[0].data, "base64").toString(), "image-for-KEY-A");
  assert.equal(Buffer.from(b.json.result.content[0].data, "base64").toString(), "image-for-KEY-B");
  assert.deepEqual([...seen].sort(), ["KEY-A", "KEY-B"]);

  // A rotated key is simply the next request's key. No restart, no cached map.
  const rotated = await callFor("KEY-A-ROTATED", 42);
  assert.equal(Buffer.from(rotated.json.result.content[0].data, "base64").toString(), "image-for-KEY-A-ROTATED");
  assert.equal(seen.at(-1), "KEY-A-ROTATED");
});

test("nothing is retained between requests", async (t) => {
  const { fetchImpl } = makeFetch(() => okImage());
  const { worker, config } = await withWorker(t, { fetchImpl });
  await rpc(config.socketPath, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "capture_screenshot", arguments: { url: "https://example.com" } },
  });
  assert.equal(worker.activeCount(), 0, "the request context is discarded on the terminal path");
});

// ---------------------------------------------------------------------------
// Lifetime. The deadline guards the whole capture, a hang-up actually stops the
// render fetch, and the three ways a capture can end stay distinguishable.
// ---------------------------------------------------------------------------

/** A promise plus its resolver, for tests that need an explicit gate, not a sleep. */
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Poll until `predicate` holds, so the tests wait on state rather than on the clock. */
async function until(predicate, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A response whose body emits `chunks` and then stalls forever unless released.
 * `state` records what the consumer actually did to the stream.
 */
function stallingResponse({ status = 200, contentType = "image/png", chunks = [], release } = {}) {
  const state = { reads: 0, cancelled: false };
  let index = 0;
  const body = new ReadableStream({
    async pull(controller) {
      state.reads++;
      if (index < chunks.length) {
        controller.enqueue(new Uint8Array(chunks[index++]));
        return;
      }
      // Nothing more until somebody says so; a real slow render looks like this.
      if (release) await release;
      controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, { status, headers: { "content-type": contentType } }), state };
}

/**
 * One request over a raw socket, counting every byte that comes back — status
 * line, headers and body. The output budget is a claim about the socket, so the
 * test has to look at the socket.
 */
function rawRequest(socketPath, { headers, body, method = "POST", path = "/mcp" }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const chunks = [];
    socket.on("connect", () => {
      const head = [
        `${method} ${path} HTTP/1.1`,
        ...Object.entries({ host: "localhost", ...headers, connection: "close" }).map(([k, v]) => `${k}: ${v}`),
        "",
        "",
      ].join("\r\n");
      socket.write(head);
      if (body !== undefined) socket.write(body);
    });
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", reject);
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const text = raw.toString("utf8");
      const status = Number(text.slice(9, 12));
      const bodyText = text.slice(text.indexOf("\r\n\r\n") + 4);
      let json;
      try {
        json = JSON.parse(bodyText);
      } catch {
        json = undefined;
      }
      resolve({ total: raw.byteLength, status, bodyText, json, text });
    });
  });
}

/** Start a request and keep the handle, so the test can hang up mid-flight. */
function startRequest(socketPath, { method = "POST", path = "/mcp", headers = {}, body } = {}) {
  const req = http.request({ socketPath, method, path, headers });
  const response = new Promise((resolve, reject) => {
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
  });
  if (body !== undefined) req.write(body);
  req.end();
  return { req, response };
}

const callBody = (id, args = { url: "https://example.com" }, name = "capture_screenshot") =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

function callHeaders(overrides = {}) {
  const body = overrides.body;
  const headers = mcpHeaders(overrides.headers);
  if (body !== undefined) headers["content-length"] = Buffer.byteLength(body);
  return headers;
}

test("hanging up before the render responds aborts the capture fetch", async (t) => {
  const { fetchImpl, calls } = makeFetch(
    (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  );
  const { worker, config } = await withWorker(t, { fetchImpl });

  const body = callBody(1);
  const { req, response } = startRequest(config.socketPath, { headers: callHeaders({ body }), body });
  await until(() => calls.length === 1);
  assert.equal(calls[0].aborted, false, "the capture is still running before the hang-up");

  req.destroy();
  await response.catch(() => {});
  await until(() => calls[0].aborted);
  assert.equal(calls[0].aborted, true, "the caller's disconnect reaches the render fetch");
  await until(() => worker.activeCount() === 0);
  assert.equal(calls.length, 1, "a cancelled capture is never retried");
});

test("hanging up during a slow image body stops the read and cancels the stream", async (t) => {
  const release = gate();
  let captured;
  const { fetchImpl, calls } = makeFetch(() => {
    captured = stallingResponse({ chunks: [PNG], release: release.promise });
    return captured.response;
  });
  const { worker, config } = await withWorker(t, { fetchImpl });

  const body = callBody(2);
  const { req, response } = startRequest(config.socketPath, { headers: callHeaders({ body }), body });
  await until(() => captured && captured.state.reads >= 2, { timeoutMs: 5000 });
  const readsAtHangup = captured.state.reads;

  req.destroy();
  await response.catch(() => {});
  await until(() => captured.state.cancelled);
  assert.equal(captured.state.cancelled, true, "the upstream body stream is cancelled, not abandoned");
  assert.equal(calls[0].aborted, true, "the fetch signal fires too");
  assert.equal(captured.state.reads, readsAtHangup, "no further reads after the hang-up");
  await until(() => worker.activeCount() === 0);
  release.open();
});

test("the deadline stays armed through the image body, and says so", async (t) => {
  const release = gate();
  let captured;
  const { fetchImpl } = makeFetch(() => {
    captured = stallingResponse({ chunks: [PNG], release: release.promise });
    return captured.response;
  });
  const { worker, config } = await withWorker(t, { fetchImpl, captureTimeoutMs: 200 });

  const res = await rpc(config.socketPath, JSON.parse(callBody(3)));
  assert.equal(res.status, 200, "the MCP call itself completes — it is the capture that failed");
  assert.equal(res.json.result.isError, true);
  assert.match(res.json.result.content[0].text, /deadline_exceeded/, "a stalled body is a deadline, not a success");
  assert.doesNotMatch(res.json.result.content[0].text, /client_cancelled/);
  assert.equal(captured.state.cancelled, true, "the stalled upstream body is cancelled");
  assert.equal(worker.activeCount(), 0);
  release.open();
});

test("the deadline also covers a stalled error body", async (t) => {
  const release = gate();
  let captured;
  const { fetchImpl } = makeFetch(() => {
    captured = stallingResponse({
      status: 500,
      contentType: "application/json",
      chunks: [Buffer.from('{"error":"')],
      release: release.promise,
    });
    return captured.response;
  });
  const { config } = await withWorker(t, { fetchImpl, captureTimeoutMs: 200 });

  const res = await rpc(config.socketPath, JSON.parse(callBody(4)));
  assert.equal(res.json.result.isError, true);
  assert.match(res.json.result.content[0].text, /deadline_exceeded/);
  assert.equal(captured.state.cancelled, true);
  release.open();
});

test("a separate cancellation POST is acknowledged but cannot cancel an earlier request", async (t) => {
  // This is the honest limit of a stateless transport: the cancelling POST gets
  // its own SDK Protocol instance, whose cancellation map knows nothing about
  // the request it names. The only real cancellation is the original connection.
  const release = gate();
  const { fetchImpl, calls } = makeFetch(async () => {
    await release.promise;
    return okImage(Buffer.from("finished-anyway"));
  });
  const { config } = await withWorker(t, { fetchImpl });

  const body = callBody(77);
  const inFlight = startRequest(config.socketPath, { headers: callHeaders({ body }), body });
  await until(() => calls.length === 1);

  const cancel = await rpc(config.socketPath, {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 77, reason: "user pressed stop" },
  });
  assert.equal(cancel.status, 202, "the notification is accepted at the protocol level");
  assert.equal(cancel.body, "");
  assert.equal(calls[0].aborted, false, "and it does not reach the earlier request's capture");

  release.open();
  const done = await inFlight.response;
  const result = JSON.parse(done.body).result;
  assert.equal(result.isError, undefined, "the earlier request completed normally");
  assert.equal(Buffer.from(result.content[0].data, "base64").toString(), "finished-anyway");
});

test("an upstream failure is not reported as a timeout", async (t) => {
  const { fetchImpl } = makeFetch(() => {
    throw new TypeError("fetch failed: connect ECONNREFUSED https://api.site-shot.com/?userkey=SECRET");
  });
  const { config } = await withWorker(t, { fetchImpl });
  const res = await rpc(config.socketPath, JSON.parse(callBody(5)));
  assert.equal(res.json.result.isError, true);
  assert.match(res.json.result.content[0].text, /upstream_unreachable/);
  assert.doesNotMatch(res.json.result.content[0].text, /deadline_exceeded|client_cancelled/);
});

// ---------------------------------------------------------------------------
// Bounds. Every limit is refused explicitly: a truncated screenshot presented
// as a good one is the failure mode this whole section exists to prevent.
// ---------------------------------------------------------------------------

/** A JSON-RPC tools/call body padded to exactly `size` bytes. */
function bodyOfSize(size, id = 1) {
  const base = JSON.parse(callBody(id, { url: "https://example.com", language: "" }));
  const overhead = Buffer.byteLength(JSON.stringify(base));
  const pad = size - overhead;
  assert.ok(pad >= 0, `cannot build a ${size}-byte body; the envelope alone is ${overhead}`);
  base.params.arguments.language = "x".repeat(pad);
  const out = JSON.stringify(base);
  assert.equal(Buffer.byteLength(out), size, "padding must land on the exact byte count");
  return out;
}

test("the request-byte ceiling is exact and refuses rather than truncates", async (t) => {
  const limit = 2048;
  const { fetchImpl, calls } = makeFetch(() => okImage());
  const { config } = await withWorker(t, { fetchImpl, maxRequestBytes: limit });

  for (const size of [limit - 1, limit]) {
    const body = bodyOfSize(size, 1);
    const res = await udsRequest(config.socketPath, { headers: callHeaders({ body }), body });
    assert.equal(res.status, 200, `${size} bytes is within the ${limit}-byte ceiling`);
  }

  const over = bodyOfSize(limit + 1, 1);
  const rejected = await udsRequest(config.socketPath, { headers: callHeaders({ body: over }), body: over });
  assert.equal(rejected.status, 413, `${limit + 1} bytes is over the ceiling`);
  assert.equal(JSON.parse(rejected.body).error.data.reason, "payload_too_large");

  // A chunked body declares no length, so the ceiling has to hold while reading.
  const headers = callHeaders();
  delete headers["content-length"];
  const chunked = await udsRequest(config.socketPath, {
    headers,
    onRequest: (req) => {
      req.write(over.slice(0, 100));
      req.write(over.slice(100));
      req.end();
    },
  });
  assert.equal(chunked.status, 413, "an undeclared over-sized body is caught while streaming");

  assert.equal(calls.length, 2, "only the two in-ceiling requests reached the API");
});

test("the image-byte ceiling is exact and never returns a partial screenshot", async (t) => {
  const limit = 4096;
  const sized = (n) => okImage(Buffer.alloc(n, 0x7f));
  let next = 0;
  const sizes = [limit - 1, limit, limit + 1];
  const { fetchImpl } = makeFetch(() => sized(sizes[next++]));
  const { config } = await withWorker(t, { fetchImpl, maxImageBytes: limit });

  for (const expected of [limit - 1, limit]) {
    const res = await rpc(config.socketPath, JSON.parse(callBody(1)));
    assert.equal(res.json.result.isError, undefined, `${expected} bytes fits`);
    assert.equal(Buffer.from(res.json.result.content[0].data, "base64").byteLength, expected);
  }

  const over = await rpc(config.socketPath, JSON.parse(callBody(1)));
  assert.equal(over.json.result.isError, true, `${limit + 1} bytes is refused`);
  assert.match(over.json.result.content[0].text, /response_too_large/);
  assert.equal(over.json.result.content.some((part) => part.type === "image"), false, "no partial image is returned");
});

test("a streamed image is refused at the ceiling without buffering the rest", async (t) => {
  const limit = 4096;
  const release = gate();
  let captured;
  const { fetchImpl } = makeFetch(() => {
    captured = stallingResponse({
      chunks: [Buffer.alloc(3000, 1), Buffer.alloc(3000, 2), Buffer.alloc(3000, 3)],
      release: release.promise,
    });
    return captured.response;
  });
  const { config } = await withWorker(t, { fetchImpl, maxImageBytes: limit });

  const res = await rpc(config.socketPath, JSON.parse(callBody(1)));
  assert.match(res.json.result.content[0].text, /response_too_large/);
  assert.equal(captured.state.cancelled, true, "the rest of the oversized body is cancelled, not drained");
  assert.ok(captured.state.reads <= 3, "reading stops at the ceiling rather than consuming the whole body");
  release.open();
});

test("a marker past the error-body ceiling is not found, and no body text escapes", async (t) => {
  const secret = "country_unavailable";
  const { fetchImpl } = makeFetch(
    () =>
      new Response(Buffer.concat([Buffer.alloc(300, 0x41), Buffer.from(secret)]), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  const { config } = await withWorker(t, { fetchImpl, maxErrorBodyBytes: 64 });

  const res = await rpc(config.socketPath, JSON.parse(callBody(1, { url: "https://example.com", country: "MC" })));
  const text = res.json.result.content[0].text;
  assert.equal(res.json.result.isError, true);
  assert.match(text, /upstream_error/, "an unreadable marker is not guessed at");
  assert.doesNotMatch(text, /AAAA/, "no upstream body text is returned");
});

test("capacity is bounded, refused before any capture, and released on every outcome", async (t) => {
  const release = gate();
  const { fetchImpl, calls } = makeFetch(async () => {
    await release.promise;
    return okImage();
  });
  const { worker, config } = await withWorker(t, { fetchImpl, maxConcurrentRequests: 2 });

  const body = callBody(1);
  const one = startRequest(config.socketPath, { headers: callHeaders({ body }), body });
  const two = startRequest(config.socketPath, { headers: callHeaders({ body }), body });
  await until(() => calls.length === 2);

  const third = await udsRequest(config.socketPath, { headers: callHeaders({ body }), body });
  assert.equal(third.status, 503, "a third concurrent request is refused");
  assert.equal(JSON.parse(third.body).error.data.reason, "capacity_exhausted");
  assert.equal(calls.length, 2, "the refused request never reached the API");

  release.open();
  assert.equal((await one.response).status, 200);
  assert.equal((await two.response).status, 200);
  await until(() => worker.activeCount() === 0);

  // A failing capture must free its slot just as a successful one does.
  const failing = createUdsWorker; // referenced so the intent is obvious in a stack trace
  void failing;
  const afterSuccess = await udsRequest(config.socketPath, { headers: callHeaders({ body }), body });
  assert.equal(afterSuccess.status, 200, "the slot was released");
  assert.equal(worker.activeCount(), 0);
});

test("slots are released after an error and after a hang-up", async (t) => {
  const outcomes = [];
  const gates = [gate(), gate()];
  const { fetchImpl } = makeFetch(async (_url, _init, index) => {
    outcomes.push(index);
    if (index === 0) throw new TypeError("fetch failed");
    if (index === 1) {
      await gates[1].promise;
      return okImage();
    }
    return okImage();
  });
  const { worker, config } = await withWorker(t, { fetchImpl, maxConcurrentRequests: 1 });
  const body = callBody(1);

  const failed = await udsRequest(config.socketPath, { headers: callHeaders({ body }), body });
  assert.equal(failed.status, 200);
  assert.match(JSON.parse(failed.body).result.content[0].text, /upstream_unreachable/);
  assert.equal(worker.activeCount(), 0, "an upstream failure releases the slot");

  const hungUp = startRequest(config.socketPath, { headers: callHeaders({ body }), body });
  await until(() => worker.activeCount() === 1);
  hungUp.req.destroy();
  await hungUp.response.catch(() => {});
  await until(() => worker.activeCount() === 0);
  gates[1].open();

  const after = await udsRequest(config.socketPath, { headers: callHeaders({ body }), body });
  assert.equal(after.status, 200, "a hang-up does not strand the slot");
});

test("a slow request body is refused on its own deadline", async (t) => {
  const { fetchImpl, calls } = makeFetch(() => okImage());
  const { worker, config } = await withWorker(t, { fetchImpl, requestBodyTimeoutMs: 150 });
  const body = callBody(1);
  const headers = callHeaders();
  delete headers["content-length"];

  const res = await udsRequest(config.socketPath, {
    headers,
    onRequest: (req) => {
      req.write(body.slice(0, 10)); // ...and then never finish.
    },
  });
  assert.equal(res.status, 408);
  assert.equal(JSON.parse(res.body).error.data.reason, "request_body_timeout");
  assert.equal(calls.length, 0, "a half-sent request never reaches the API");
  await until(() => worker.activeCount() === 0);
});

// ---------------------------------------------------------------------------
// Redaction. The request URL carries `userkey`; anything that echoes an
// upstream failure verbatim is one stack trace away from publishing a key.
// ---------------------------------------------------------------------------

test("no secret survives any failure shape, in the result or in the log", async (t) => {
  const KEY = "SECRET-KEY-abc+def/123";
  const SUBJECT = "subject-9f3c-private";
  const CORRELATION = "corr-abcdef";
  const encoded = encodeURIComponent(KEY);
  const leaks = [KEY, encoded, `userkey=${encoded}`, SUBJECT];

  // One failure shape per request, each carrying the key back in a different way.
  const shapes = [
    () => {
      throw new TypeError(`fetch failed for https://api.site-shot.com/?url=x&userkey=${encoded}`);
    },
    () =>
      new Response(JSON.stringify({ error: `bad key ${KEY}`, url: `https://api.site-shot.com/?userkey=${encoded}` }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response(`upstream said: userkey=${encoded} is invalid (subject ${SUBJECT})`, {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    () =>
      new Response(
        new ReadableStream({
          pull() {
            throw new Error(`stream broke: userkey=${encoded}`);
          },
        }),
        { status: 200, headers: { "content-type": "image/png" } },
      ),
    () =>
      new Response(
        new ReadableStream({
          pull() {
            throw new Error(`error body broke: ${KEY}`);
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
  ];

  const logged = [];
  let index = 0;
  const { fetchImpl } = makeFetch(() => shapes[index++]());
  const { config } = await withWorker(t, { fetchImpl, logger: (line) => logged.push(line) });

  for (let shape = 0; shape < shapes.length; shape++) {
    const res = await rpc(config.socketPath, JSON.parse(callBody(shape)), {
      headers: ctx({ subject: SUBJECT, key: KEY, correlation: CORRELATION }),
    });
    assert.equal(res.status, 200, `shape ${shape} still returns a well-formed MCP result`);
    const result = res.json.result;
    assert.equal(result.isError, true, `shape ${shape} is an error`);
    assert.match(result.content[0].text, /^Site-Shot /, `shape ${shape} keeps a readable message`);
    for (const leak of leaks) {
      assert.ok(!res.body.includes(leak), `shape ${shape} must not leak ${leak.slice(0, 12)}…`);
    }
    assert.doesNotMatch(res.body, /api\.site-shot\.com\/\?/, `shape ${shape} must not return the request URL`);
    assert.doesNotMatch(res.body, /\bat [A-Za-z]+ \(/, `shape ${shape} must not return a stack frame`);
  }

  const log = logged.join("\n");
  assert.ok(log.length > 0, "the worker records an outcome line per request");
  for (const leak of leaks) {
    assert.ok(!log.includes(leak), `the log must not contain ${leak.slice(0, 12)}…`);
  }
  assert.doesNotMatch(log, /userkey/, "the log never contains the query parameter name, let alone its value");
  assert.ok(log.includes(CORRELATION), "the adapter's correlation id is what makes a log line traceable");
});

test("a country-unavailable failure keeps its useful, validated explanation", async (t) => {
  const { fetchImpl } = makeFetch(
    () =>
      new Response(JSON.stringify({ error: "country_unavailable" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  const { config } = await withWorker(t, { fetchImpl });
  const res = await rpc(config.socketPath, JSON.parse(callBody(1, { url: "https://example.com", country: "MC" })));
  const text = res.json.result.content[0].text;
  assert.match(text, /"MC"/, "names the country the caller actually asked for");
  assert.match(text, /strict_country/, "still suggests the opt-out");
  assert.match(text, /country_unavailable/);
  assert.doesNotMatch(text, /undefined/);
});

test("the served version matches the package it is published from", async (t) => {
  const { config } = await withWorker(t);
  const res = await rpc(config.socketPath, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "acceptance", version: "0.0.0" } },
  });
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(res.json.result.serverInfo.version, pkg.version, "the handshake version is not hand-kept");
});

// ---------------------------------------------------------------------------
// Regressions found by independent review. Each of these shipped green once.
// ---------------------------------------------------------------------------

// MCP-P1-01. Node's own listener teardown unlinks the bound path unconditionally,
// so an inode check *after* close() is too late: whatever sits at the path by
// then has already been deleted. The socket this process binds must therefore
// never be the path other processes are told to use.
test("a foreign file that replaced our socket survives shutdown", async () => {
  const dir = privateDir();
  const sockPath = join(dir, "m.sock");
  try {
    const worker = createUdsWorker(baseConfig(dir));
    await worker.start();
    assert.ok(statSync(sockPath).isSocket());

    // Somebody removes our socket and puts an unrelated file in its place.
    unlinkSync(sockPath);
    writeFileSync(sockPath, "an unrelated file that must outlive this worker");

    await worker.close();
    assert.equal(existsSync(sockPath), true, "the replacement must still be there");
    assert.equal(readFileSync(sockPath, "utf8"), "an unrelated file that must outlive this worker");

    // And nothing of ours is left lying around in the directory either.
    const leftovers = readdirSync(dir).filter((name) => name !== "m.sock");
    assert.deepEqual(leftovers, [], `no staging path may survive: ${leftovers.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// MCP-P1-02. The image budget bounds the bytes the renderer returned. It says
// nothing about the bytes we write: base64 inflates by 4/3 and the JSON-RPC
// envelope adds more on top. A 512-byte image under a 512-byte "response"
// budget produced a 781-byte response.
//
// The budget is checked here against the bytes that actually cross the socket —
// status line, headers and body — not against the part the worker composes.
test("the serialized response has its own exact ceiling, above the image ceiling", async (t) => {
  const wireBudget = 2048;
  let imageBytes = 0;
  const { fetchImpl } = makeFetch(() => okImage(Buffer.alloc(imageBytes, 0x2a)));
  const { config } = await withWorker(t, {
    fetchImpl,
    maxImageBytes: 1024 * 1024, // deliberately generous: the wire bound must bite on its own
    maxResponseBytes: wireBudget,
  });

  const attempt = async (size) => {
    imageBytes = size;
    const body = callBody(1);
    const raw = await rawRequest(config.socketPath, { headers: callHeaders({ body }), body });
    return { ...raw, servedImage: raw.json?.result?.content?.[0]?.type === "image" };
  };

  // Find the exact largest image that still fits, by asking rather than by
  // re-deriving the worker's own arithmetic in the test.
  let low = 1;
  let high = wireBudget;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((await attempt(mid)).servedImage) low = mid;
    else high = mid - 1;
  }

  const fits = await attempt(low);
  assert.equal(fits.servedImage, true, `${low} image bytes is the largest that fits`);
  assert.ok(fits.total <= wireBudget, `at the boundary the whole HTTP response is ${fits.total} bytes`);

  const over = await attempt(low + 1);
  assert.equal(over.servedImage, false, `${low + 1} image bytes must not be served`);
  assert.equal(over.status, 500, "an output the server cannot send is reported as a server-side failure");
  assert.equal(over.json.result, undefined, "an over-budget response is not sent as a result");
  assert.equal(over.json.error.data.reason, "response_too_large");
  assert.equal(over.json.id, 1, "an affordable id is still echoed");
  assert.ok(over.total <= wireBudget, `the refusal itself crosses the socket at ${over.total} bytes`);
});

// MCP-P1-03. A body that is not a readable stream cannot be bounded or aborted,
// so it is an explicit failure rather than a quietly different code path.
test("a response without a readable body is an explicit failure, not a fallback", async (t) => {
  const { fetchImpl } = makeFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => "image/png" },
    arrayBuffer: async () => new ArrayBuffer(8),
  }));
  const { config } = await withWorker(t, { fetchImpl });
  const res = await rpc(config.socketPath, JSON.parse(callBody(1)));
  assert.equal(res.json.result.isError, true);
  assert.match(res.json.result.content[0].text, /response_unreadable/);
});

test("shutting down with a capture in flight aborts it instead of hanging", async (t) => {
  const dir = privateDir();
  const release = gate();
  const { fetchImpl, calls } = makeFetch(async () => {
    await release.promise;
    return okImage();
  });
  const worker = createUdsWorker(baseConfig(dir, { fetchImpl }));
  await worker.start();
  try {
    const body = callBody(1);
    const inFlight = startRequest(join(dir, "m.sock"), { headers: callHeaders({ body }), body });
    // The caller's connection is destroyed by the shutdown below, so claim that
    // rejection now rather than letting it land while close() is still running.
    const hungUp = inFlight.response.catch(() => "hung up");
    await until(() => calls.length === 1);

    const started = Date.now();
    await worker.close();
    assert.ok(Date.now() - started < 4000, "close() must not wait on an in-flight capture");
    assert.equal(calls[0].aborted, true, "shutdown cancels the capture it interrupted");
    assert.equal(worker.activeCount(), 0);
    assert.equal(existsSync(join(dir, "m.sock")), false, "our socket is removed on shutdown");
    assert.equal(await hungUp, "hung up", "the interrupted caller is disconnected, not left waiting");
  } finally {
    release.open();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Independent security review: the caller's own input is a secret too. A URL can
// carry userinfo credentials, and echoing the rejected value back puts them in
// the MCP result and in every transcript that result lands in.
test("rejected caller input is never echoed back", async (t) => {
  const { fetchImpl, calls } = makeFetch(() => okImage());
  const { config } = await withWorker(t, { fetchImpl });

  const urlSecret = "SYNTH_TARGET_SECRET";
  const badUrl = await rpc(config.socketPath, JSON.parse(callBody(1, { url: `https://user:${urlSecret}@[` })));
  const urlText = badUrl.json.result.content[0].text;
  assert.equal(badUrl.json.result.isError, true);
  assert.match(urlText, /invalid_url/, "still classified");
  assert.match(urlText, /https:\/\/example\.com/, "still says what a good URL looks like");
  assert.ok(!badUrl.body.includes(urlSecret), "the rejected URL's credentials must not come back");
  assert.doesNotMatch(urlText, /user:/, "no userinfo at all");

  const countrySecret = "NOT-A-COUNTRY-BUT-A-SECRET";
  const badCountry = await rpc(
    config.socketPath,
    JSON.parse(callBody(2, { url: "https://example.com", country: countrySecret })),
  );
  const countryText = badCountry.json.result.content[0].text;
  assert.equal(badCountry.json.result.isError, true);
  assert.match(countryText, /invalid_country/);
  assert.match(countryText, /ISO 3166-1 alpha-2/, "still tells the agent what to send instead");
  assert.ok(!badCountry.body.includes(countrySecret), "the rejected country value must not come back");

  assert.equal(calls.length, 0, "neither rejected input reached the API");
});

// Independent review: when the mode grants the group access, the group is part
// of the trust boundary. Verifying owner and mode alone leaves "which group?"
// to whatever the directory happened to inherit.
test("group access must name the group it trusts, and prove it", async () => {
  const dir = privateDir();
  try {
    // 0600 keeps the group out entirely, so no group strategy is owed.
    assert.doesNotThrow(() => createUdsWorker(baseConfig(dir, { socketMode: 0o600 })));

    // 0660 without a named group is a trust claim with nothing behind it.
    assert.throws(
      () => createUdsWorker(baseConfig(dir, { socketMode: 0o660 })),
      /socketGroup/,
      "group-accessible mode must name the group",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a group-accessible socket is created in, and verified against, that group", async (t) => {
  if (typeof process.getgid !== "function") return t.skip("POSIX-only check");
  const gid = process.getgid();
  const dir = privateDir();
  try {
    // The directory has to be traversable by the group, or a 0660 socket in it
    // is unreachable by the very peer the mode was widened for.
    chmodSync(dir, 0o710);
    const worker = createUdsWorker(baseConfig(dir, { socketMode: 0o660, socketGroup: gid }));
    await worker.start();
    const info = statSync(join(dir, "m.sock"));
    assert.equal(info.mode & 0o777, 0o660);
    assert.equal(info.gid, gid, "the socket carries the configured group");
    assert.equal(info.uid, process.getuid(), "and is still owned by this process");
    await worker.close();
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a group the process cannot grant is a startup failure, not a silent downgrade", async (t) => {
  if (typeof process.getgid !== "function") return t.skip("POSIX-only check");
  if (process.getuid() === 0) return t.skip("running as root: any group can be granted");
  const mine = new Set(process.getgroups());
  const foreign = [0, 1, 2, 3, 4, 5].find((gid) => !mine.has(gid));
  if (foreign === undefined) return t.skip("no gid available that this process is not a member of");

  const dir = privateDir();
  try {
    chmodSync(dir, 0o710);
    const worker = createUdsWorker(baseConfig(dir, { socketMode: 0o660, socketGroup: foreign }));
    await assert.rejects(() => worker.start(), /group/i);
    assert.equal(existsSync(join(dir, "m.sock")), false, "a refused start leaves no socket behind");
    assert.deepEqual(readdirSync(dir), [], "and no staging path either");
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory the trusted group cannot reach is refused", async (t) => {
  if (typeof process.getgid !== "function") return t.skip("POSIX-only check");
  const dir = privateDir(); // 0700: owner only, no group traversal
  try {
    const worker = createUdsWorker(baseConfig(dir, { socketMode: 0o660, socketGroup: process.getgid() }));
    await assert.rejects(() => worker.start(), /group/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a group-writable socket directory is refused when the group is trusted", async (t) => {
  if (typeof process.getgid !== "function") return t.skip("POSIX-only check");
  const dir = privateDir();
  try {
    chmodSync(dir, 0o730); // the group could replace our socket
    const worker = createUdsWorker(baseConfig(dir, { socketMode: 0o660, socketGroup: process.getgid() }));
    await assert.rejects(() => worker.start(), /group-writable/i);
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The private entrypoint: the same worker, configured from the environment,
// started as its own process.
// ---------------------------------------------------------------------------

test("the entrypoint requires every bound in the environment and ignores the API key", () => {
  const env = {
    SITESHOT_MCP_UDS_PATH: "/tmp/ss/m.sock",
    SITESHOT_MCP_UDS_MODE: "0600",
    SITESHOT_MCP_ALLOWED_HOSTS: "localhost, siteshot-mcp",
    SITESHOT_MCP_MAX_REQUEST_BYTES: "65536",
    SITESHOT_MCP_MAX_IMAGE_BYTES: "8388608",
    SITESHOT_MCP_MAX_RESPONSE_BYTES: "12582912",
    SITESHOT_MCP_MAX_ERROR_BODY_BYTES: "65536",
    SITESHOT_MCP_MAX_CONCURRENT_REQUESTS: "2",
    SITESHOT_MCP_CAPTURE_TIMEOUT_MS: "90000",
    SITESHOT_MCP_REQUEST_BODY_TIMEOUT_MS: "10000",
    SITESHOT_API_KEY: POISON_ENV_KEY,
  };

  const config = configFromEnv(env);
  assert.equal(config.socketPath, "/tmp/ss/m.sock");
  assert.equal(config.socketMode, 0o600);
  assert.deepEqual(config.allowedHosts, ["localhost", "siteshot-mcp"]);
  assert.equal(config.maxImageBytes, 8388608);
  assert.equal(config.maxResponseBytes, 12582912);
  assert.equal(config.maxConcurrentRequests, 2);
  assert.ok(!("apiKey" in config), "the worker is never configured with a process-wide key");
  assert.ok(!JSON.stringify(config).includes(POISON_ENV_KEY), "and never carries one anywhere");

  for (const name of Object.keys(env)) {
    if (name === "SITESHOT_API_KEY") continue;
    const partial = { ...env };
    delete partial[name];
    assert.throws(() => configFromEnv(partial), new RegExp(name), `${name} must be required`);
  }
  assert.throws(() => configFromEnv({ ...env, SITESHOT_MCP_MAX_IMAGE_BYTES: "lots" }), /MAX_IMAGE_BYTES/);
  assert.throws(() => configFromEnv({ ...env, SITESHOT_MCP_UDS_MODE: "0666" }), /socketMode/);
});

/** The real entrypoint as its own process, configured the way a launch would. */
function spawnEntrypoint(sockPath, entry = fileURLToPath(new URL("../src/uds-worker.js", import.meta.url))) {
  const child = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env.PATH,
      SITESHOT_MCP_UDS_PATH: sockPath,
      SITESHOT_MCP_UDS_MODE: "0600",
      SITESHOT_MCP_ALLOWED_HOSTS: "localhost",
      SITESHOT_MCP_MAX_REQUEST_BYTES: "65536",
      SITESHOT_MCP_MAX_IMAGE_BYTES: "8388608",
      SITESHOT_MCP_MAX_RESPONSE_BYTES: "12582912",
      SITESHOT_MCP_MAX_ERROR_BODY_BYTES: "65536",
      SITESHOT_MCP_MAX_CONCURRENT_REQUESTS: "2",
      SITESHOT_MCP_CAPTURE_TIMEOUT_MS: "90000",
      SITESHOT_MCP_REQUEST_BODY_TIMEOUT_MS: "10000",
      // Present on purpose: a stray key in the worker's environment must stay unused.
      SITESHOT_API_KEY: POISON_ENV_KEY,
    },
    // stdin is a pipe because the instrumented copy below is released over it.
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (c) => stderr.push(c.toString()));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, stderr, exited };
}

/** A child that will not exit must fail this test, not hang the whole run. */
async function exitWithin(exited, timeoutMs, what) {
  let timer;
  try {
    return await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: no exit within ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A temporary, instrumented copy of the real entrypoint. Spinning until the
// socket appears and then signalling finds the earliest moment an observer
// can see, but it does not CAUSE the interleaving -- the child may well have
// finished start() before the parent gets scheduled. These two injections
// make it causal: the child stops at the post-publication await and stays
// there until released, and it announces that its signal handler ran, so the
// parent knows the stop landed inside the window rather than after it.
//
// Test-only, written to a temp file and deleted. Every anchor is asserted, so
// if the source moves this fails loudly instead of quietly instrumenting
// nothing.
const PUBLISH_ANCHOR = "      await link(staging, config.socketPath);\n";
const STOP_ANCHOR = "    stopping = true;\n";
const HANDLERS_ANCHOR = '  process.on("SIGTERM", stop);\n  process.on("SIGINT", stop);\n';
const START_ANCHOR = "    await worker.start();\n";

const HOLD_AT_PUBLICATION = `      process.stderr.write("[barrier] published\\n");
      await new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.once("data", resolve);
      });
`;
const ANNOUNCE_STOP = '    process.stderr.write("[barrier] stop-handled\\n");\n';

let instrumentedCount = 0;

const FAIL_AFTER_PUBLICATION = '      throw new Error("injected: startup failed after publishing");\n';

function instrumentedEntrypoint({ legacy = false, failAfterPublish = false } = {}) {
  let source = readFileSync(new URL("../src/uds-worker.js", import.meta.url), "utf8");
  for (const [name, anchor] of [["publication", PUBLISH_ANCHOR], ["stop", STOP_ANCHOR]]) {
    assert.equal(source.split(anchor).length - 1, 1, `${name} anchor is not unique; re-point the instrumentation`);
  }
  source = source.replace(
    PUBLISH_ANCHOR,
    PUBLISH_ANCHOR + (failAfterPublish ? FAIL_AFTER_PUBLICATION : HOLD_AT_PUBLICATION),
  );
  source = source.replace(STOP_ANCHOR, STOP_ANCHOR + ANNOUNCE_STOP);
  if (legacy) {
    // The ordering before this fix: handlers installed only once start()
    // resolved. Reproduced here so the barrier is shown to catch it.
    assert.equal(source.split(HANDLERS_ANCHOR).length - 1, 1, "handler anchor is not unique");
    assert.equal(source.split(START_ANCHOR).length - 1, 1, "start anchor is not unique");
    source = source.replace(HANDLERS_ANCHOR, "");
    source = source.replace(
      START_ANCHOR,
      START_ANCHOR + '    process.on("SIGTERM", stop);\n    process.on("SIGINT", stop);\n',
    );
  }
  source = source.replace('from "./server.js"', 'from "../src/server.js"');
  const file = fileURLToPath(
    new URL(`./tmp-entrypoint-${process.pid}-${instrumentedCount++}.mjs`, import.meta.url),
  );
  writeFileSync(file, source);
  return file;
}

test("the entrypoint runs as its own process, serves MCP, and cleans up on SIGTERM", async () => {
  const dir = privateDir();
  const sockPath = join(dir, "m.sock");
  const { child, stderr, exited } = spawnEntrypoint(sockPath);

  try {
    await until(() => existsSync(sockPath), { timeoutMs: 10_000 });
    assert.equal(statSync(sockPath).mode & 0o777, 0o600);

    // A real MCP handshake over the real socket, with no capture and no network.
    const res = await rpc(sockPath, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "entrypoint", version: "0" } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.result.serverInfo.name, "site-shot");

    const tools = await rpc(sockPath, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(tools.json.result.tools.map((tool) => tool.name).sort(), [
      "capture_full_page",
      "capture_screenshot",
    ]);

    child.kill("SIGTERM");
    const end = await exited;
    assert.equal(end.code, 0, `clean exit (stderr: ${stderr.join("")})`);
    assert.equal(existsSync(sockPath), false, "the worker removes its own socket on the way out");
    assert.deepEqual(readdirSync(dir), [], "and leaves no staging path behind");
    assert.ok(!stderr.join("").includes(POISON_ENV_KEY), "nothing logs the stray environment key");
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Memory. The point is not a number, it is the shape: peak cost tracks the
// configured budget and the concurrency limit, and does not track the number of
// requests served. Numbers are printed for the implementation receipt.
// ---------------------------------------------------------------------------

test("serving many budget-sized captures does not grow memory with request count", async (t) => {
  const imageBudget = 8 * 1024 * 1024;
  const wireBudget = 12 * 1024 * 1024;
  const rounds = 12;
  const concurrency = 2;

  // One shared fixture: a new 8 MiB buffer per call would measure the fixture,
  // not the worker. Response bodies are per-call, which is what we want bounded.
  const fixture = Buffer.alloc(imageBudget, 0x5a);
  const { fetchImpl } = makeFetch(() => okImage(fixture));
  const { worker, config } = await withWorker(t, {
    fetchImpl,
    maxImageBytes: imageBudget,
    maxResponseBytes: wireBudget,
    maxConcurrentRequests: concurrency,
  });

  const body = callBody(1);
  // Warm up so the first-call allocations are not counted as growth.
  await udsRequest(config.socketPath, { headers: callHeaders({ body }), body });

  const settle = async () => {
    // The client reading the last byte does not mean the worker has finished with
    // it: the response write and the per-request teardown are still in flight, and
    // sampling there measures two live responses rather than what is retained.
    await until(() => worker.activeCount() === 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Run under --expose-gc (see `npm run test:remote`) for a number that is not
    // just V8 declining to hand pages back. Twice, because the first pass only
    // makes the second one's work reachable, and then a turn for the finalizers.
    globalThis.gc?.();
    globalThis.gc?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return process.memoryUsage();
  };

  const baseline = await settle();
  const samples = [];
  for (let round = 0; round < rounds / concurrency; round++) {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const res = await udsRequest(config.socketPath, { headers: callHeaders({ body }), body });
        assert.equal(res.status, 200);
        assert.equal(Buffer.byteLength(res.body) > imageBudget, true, "a full-budget image really was returned");
      }),
    );
    samples.push(await settle());
  }

  const mib = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  const rss = samples.map((s) => s.rss);
  const retained = samples.map((s) => s.heapUsed + s.external);
  const half = Math.floor(samples.length / 2);
  const earlyPeak = Math.max(...retained.slice(0, half));
  const latePeak = Math.max(...retained.slice(half));
  console.log(
    `[memory] gc=${typeof globalThis.gc === "function"} imageBudget=${mib(imageBudget)}MiB ` +
      `wireBudget=${mib(wireBudget)}MiB concurrency=${concurrency} requests=${rounds}\n` +
      `[memory] rss: baseline=${mib(baseline.rss)}MiB peak=${mib(Math.max(...rss))}MiB final=${mib(rss.at(-1))}MiB\n` +
      `[memory] heapUsed+external: baseline=${mib(baseline.heapUsed + baseline.external)}MiB ` +
      `firstHalfPeak=${mib(earlyPeak)}MiB secondHalfPeak=${mib(latePeak)}MiB drift=${mib(latePeak - earlyPeak)}MiB`,
  );

  // The property that matters is not an absolute number — that is a function of
  // the budget and the concurrency limit, and is reported above for the receipt.
  // It is that serving more requests does not cost more memory: if anything were
  // queued or retained per request, the second half would sit a full image (or
  // several) above the first.
  if (typeof globalThis.gc === "function") {
    assert.ok(
      latePeak - earlyPeak < imageBudget,
      `retained memory must plateau: second half peaked ${mib(latePeak - earlyPeak)}MiB above the first, ` +
        `which is more than one ${mib(imageBudget)}MiB image`,
    );
  } else {
    // Said out loud rather than silently skipped: without a forced collection
    // the numbers above measure V8's appetite, not this worker's retention.
    t.diagnostic("retention check NOT performed — run `npm run test:remote` (it sets --expose-gc)");
  }
  assert.equal(worker.activeCount(), 0, "nothing is queued or retained afterwards");
  assert.ok(worker.stats().peakActive <= concurrency, "the concurrency limit actually held");
});

// Final peer review: fail-closed startup.
test("a group-writable socket directory is refused whatever the socket mode is", async () => {
  const dir = privateDir();
  try {
    // 0770 with a 0600 socket: no group was ever "trusted", but any member of
    // the directory's group can still unlink our socket and bind their own, and
    // the adapter would then hand that impostor the customer's key.
    chmodSync(dir, 0o770);
    const worker = createUdsWorker(baseConfig(dir, { socketMode: 0o600 }));
    await assert.rejects(() => worker.start(), /group-writable/i);
    assert.equal(worker.address(), null, "a refused start leaves nothing listening");
    assert.deepEqual(readdirSync(dir), [], "and nothing on disk");
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken logger fails construction, and a throwing one unwinds the start", async () => {
  const dir = privateDir();
  try {
    assert.throws(() => createUdsWorker(baseConfig(dir, { logger: "not-a-function" })), /logger/);

    const worker = createUdsWorker(
      baseConfig(dir, {
        logger: () => {
          throw new Error("log sink is down");
        },
      }),
    );
    await assert.rejects(() => worker.start(), /log sink is down/);
    assert.equal(worker.address(), null, "no listener survives a failed start");
    assert.equal(existsSync(join(dir, "m.sock")), false, "and no socket is left published");
    assert.deepEqual(readdirSync(dir), [], "and no staging path either");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Codex wire re-test: intercepting the SDK's `send` bounded only the responses
// that go *through* it. The SDK also returns HTTP errors of its own, and a
// refusal that echoes the caller's 3000-character JSON-RPC id is itself over
// budget. The bound has to sit on the actual HTTP output, once, for everything.
test("the HTTP output budget holds for every response the SDK can produce", async (t) => {
  const budget = 1024;
  const { fetchImpl, calls } = makeFetch(() => okImage(Buffer.alloc(32, 0x11)));
  const { config } = await withWorker(t, {
    fetchImpl,
    maxRequestBytes: 65536,
    maxImageBytes: 1024 * 1024, // generous on purpose: the output bound must hold alone
    maxResponseBytes: budget,
  });

  const longId = "x".repeat(3000);
  const cases = [
    {
      name: "a 3000-character JSON-RPC id on a successful capture",
      message: {
        jsonrpc: "2.0",
        id: longId,
        method: "tools/call",
        params: { name: "capture_screenshot", arguments: { url: "https://example.com" } },
      },
      headers: {},
    },
    {
      name: "a 3000-character unsupported protocol version",
      message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      headers: { "mcp-protocol-version": "9".repeat(3000) },
    },
    {
      name: "a 3000-character method name",
      message: { jsonrpc: "2.0", id: 2, method: "z".repeat(3000) },
      headers: {},
    },
    {
      name: "invalid params on a real tool",
      message: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "capture_screenshot", arguments: { url: "https://example.com", width: "w".repeat(3000) } },
      },
      headers: {},
    },
    {
      name: "a long id on a protocol error",
      message: { jsonrpc: "2.0", id: longId, method: "resources/list" },
      headers: {},
    },
  ];

  for (const { name, message, headers } of cases) {
    const body = JSON.stringify(message);
    const res = await rawRequest(config.socketPath, {
      headers: { ...mcpHeaders(headers), "content-length": Buffer.byteLength(body) },
      body,
    });
    assert.ok(res.total <= budget, `${name}: ${res.total} bytes crossed the socket, over the ${budget}-byte budget`);
    assert.ok(res.json, `${name}: the response is still well-formed JSON`);
    assert.equal(res.json.jsonrpc, "2.0", `${name}: and still JSON-RPC`);
    assert.ok(!res.text.includes(longId.slice(0, 200)), `${name}: an over-budget id must not be echoed`);

    if (res.json.error?.data?.reason === "response_too_large") {
      assert.equal(res.status, 500, `${name}: an output we cannot send is a server-side failure, truthfully`);
      assert.equal(res.json.error.data.limitBytes, budget);
      // The id is dropped only when echoing it is what would not fit.
      assert.ok(
        res.json.id === null || String(res.json.id).length < 100,
        `${name}: the refusal must not carry an id it cannot afford`,
      );
    }
  }

  // Within budget, the id is still echoed — dropping it is the exception, not the rule.
  const small = await rpc(config.socketPath, JSON.parse(callBody(4242)));
  assert.equal(small.status, 200);
  assert.equal(small.json.id, 4242);
  assert.equal(small.json.result.content[0].type, "image");

  // And a budget too small for a real response fails loudly rather than serving a
  // broken one: under 1 KiB even tools/list, with both full schemas, is refused.
  const listed = await rpc(config.socketPath, { jsonrpc: "2.0", id: 5, method: "tools/list" });
  assert.equal(listed.status, 500);
  assert.equal(listed.json.error.data.reason, "response_too_large");

  assert.ok(calls.length >= 1, "the successful-capture case really did capture");
});

test("back-to-back requests at the concurrency limit are never spuriously refused", async (t) => {
  // The slot has to be free the moment the response is written. If it is only
  // released after an awaited teardown, a client that sends its next request as
  // soon as it reads the last one gets a 503 for capacity that is not in use.
  const concurrency = 2;
  const { fetchImpl } = makeFetch(() => okImage());
  const { worker, config } = await withWorker(t, { fetchImpl, maxConcurrentRequests: concurrency });
  const body = callBody(1);

  const statuses = [];
  for (let round = 0; round < 40; round++) {
    const pair = await Promise.all(
      Array.from({ length: concurrency }, () =>
        udsRequest(config.socketPath, { headers: callHeaders({ body }), body }),
      ),
    );
    statuses.push(...pair.map((res) => res.status));
  }

  const refused = statuses.filter((status) => status !== 200);
  assert.deepEqual(refused, [], `${refused.length} of ${statuses.length} requests were refused with capacity free`);
  assert.equal(worker.activeCount(), 0);
});

// Independent security review: the upstream Content-Type was copied straight into
// the MCP result's mimeType. That reflects whatever the header says — a marker, or
// `image/svg+xml`, which is active content the caller never asked for. The two
// tools offer png and jpeg; those are the two types that may come back.
test("only the image types the tools actually offer are served", async (t) => {
  const MARKER = "SYNTH_MIME_SECRET";
  const logged = [];
  let contentType = "image/png";
  const { fetchImpl } = makeFetch(() => okImage(PNG, contentType));
  const { config } = await withWorker(t, { fetchImpl, logger: (line) => logged.push(line) });

  for (const good of ["image/png", "image/jpeg", "image/png; charset=binary"]) {
    contentType = good;
    const res = await rpc(config.socketPath, JSON.parse(callBody(1)));
    assert.equal(res.json.result.isError, undefined, `${good} is served`);
    assert.equal(res.json.result.content[0].type, "image");
    assert.equal(res.json.result.content[0].mimeType, good.split(";")[0], `${good} keeps its exact type`);
  }

  for (const bad of [`image/${MARKER}`, "image/svg+xml", "image/webp", "image/gif", "image/svg+xml; charset=utf-8"]) {
    contentType = bad;
    const res = await rpc(config.socketPath, JSON.parse(callBody(1)));
    assert.equal(res.json.result.isError, true, `${bad} must not be served`);
    assert.match(res.json.result.content[0].text, /unsupported_image_type/);
    assert.equal(
      res.json.result.content.some((part) => part.type === "image"),
      false,
      `${bad} must not come back as an image at all`,
    );
    assert.ok(!res.body.includes(MARKER), "an upstream subtype must never be reflected");
    assert.ok(!res.body.includes("svg"), `${bad}: no raw subtype in the result`);
  }

  const log = logged.join("\n");
  assert.ok(!log.includes(MARKER), "and never reaches the log either");
  assert.ok(!log.includes("svg"), "no raw subtype in the log");
});

test("the capture function itself refuses an unexpected image type", async () => {
  // Called directly, with no transport in the way: the allowlist lives in the
  // shared capture code, so stdio gets it too.
  const res = await captureScreenshot(
    { url: "https://example.com" },
    {
      apiKey: "K",
      fetchImpl: async () =>
        new Response(PNG, { status: 200, headers: { "content-type": "image/SYNTH_MIME_SECRET" } }),
    },
  );
  assert.equal(res.isError, true);
  assert.equal(res._meta["com.site-shot.mcp/error"].code, "unsupported_image_type");
  assert.ok(!JSON.stringify(res).includes("SYNTH_MIME_SECRET"), "the subtype is not reflected");
});

// ---------------------------------------------------------------------------
// Startup cancellation (CR-MCP-START-001).
//
// A supervisor may stop a worker at any moment, including while it is still
// starting. The window that made that dangerous: start() publishes a reachable
// socket partway through and keeps going, and main() used to install its
// signal handlers only after start() resolved -- so a signal in between took
// Node's default action, killing the process with the published socket left on
// disk for the next start to refuse.
//
// None of these tests waits for anything to become convenient. Each one makes
// the stop land in a specific place: calling close() on the line after start()
// is guaranteed to land while start() is in flight, because start() has
// already yielded at its first await; and the "started" log line is emitted
// after the socket is published and before start() returns, which is the exact
// interval the defect lived in.
// ---------------------------------------------------------------------------

test("a stop before publication leaves nothing published and nothing staged", async () => {
  const dir = privateDir();
  try {
    const worker = createUdsWorker(baseConfig(dir));
    // No await between these two: the stop is in flight before start() can
    // reach its publication step.
    const starting = worker.start();
    const stopping = worker.close();
    const [started] = await Promise.allSettled([starting, stopping]);

    assert.equal(started.status, "rejected", "a cancelled start must not report success");
    assert.equal(started.reason.cancelled, true, "and must say it was cancelled, not failed");
    assert.equal(existsSync(join(dir, "m.sock")), false, "nothing was published");
    assert.deepEqual(readdirSync(dir), [], "and no staging socket survived");

    // The point of cleaning up: the next start is ordinary.
    const next = createUdsWorker(baseConfig(dir));
    await next.start();
    assert.ok(statSync(join(dir, "m.sock")).isSocket(), "a later start is clean");
    await next.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop after publication and before start() returns removes the socket", async () => {
  const dir = privateDir();
  try {
    const lines = [];
    let stopping = null;
    const worker = createUdsWorker(
      baseConfig(dir, {
        logger: (line) => {
          lines.push(line);
          // Emitted after link() and before start() returns: the interval a
          // readiness probe cannot see past, because the socket is already
          // reachable and answering here.
          if (line.includes("outcome=started") && !stopping) stopping = worker.close();
        },
      }),
    );

    await worker.start();
    assert.ok(
      lines.some((line) => line.includes("outcome=started")),
      "the socket really was published before the stop",
    );
    assert.ok(stopping, "the stop was issued from inside the publication window");
    await stopping;

    assert.equal(existsSync(join(dir, "m.sock")), false, "the published socket was removed");
    assert.deepEqual(readdirSync(dir), [], "and no staging socket survived");

    const next = createUdsWorker(baseConfig(dir));
    await next.start();
    assert.ok(statSync(join(dir, "m.sock")).isSocket(), "a later start is clean");
    await next.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping repeatedly is one stop, and a late stop unlinks nothing", async () => {
  const dir = privateDir();
  const sockPath = join(dir, "m.sock");
  try {
    const worker = createUdsWorker(baseConfig(dir));
    const starting = worker.start();
    // Three stops at once, the way SIGINT behind SIGTERM behind a supervisor
    // call arrive. None of them may return before the single teardown is done.
    const stops = [worker.close(), worker.close(), worker.close()];
    await Promise.allSettled([starting, ...stops]);
    for (const stop of stops) await stop;

    assert.equal(existsSync(sockPath), false);
    assert.deepEqual(readdirSync(dir), []);

    // Something else takes the path afterwards. A stop that still thought it
    // owned it would delete a stranger's file.
    writeFileSync(sockPath, "someone else's");
    await worker.close();
    await worker.close();
    assert.equal(readFileSync(sockPath, "utf8"), "someone else's", "a late stop unlinked a foreign path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop leaves a foreign replacement at the published path alone", async () => {
  const dir = privateDir();
  const sockPath = join(dir, "m.sock");
  try {
    const worker = createUdsWorker(baseConfig(dir));
    await worker.start();
    const ours = statSync(sockPath).ino;

    // The published socket is replaced by an unrelated file at the same path.
    // Shutdown identifies its socket by inode, so this must survive.
    unlinkSync(sockPath);
    writeFileSync(sockPath, "not ours");
    assert.notEqual(statSync(sockPath).ino, ours, "the replacement is a different inode");

    await worker.close();
    assert.equal(readFileSync(sockPath, "utf8"), "not ours", "shutdown removed a path it did not own");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a startup error overlapping a stop settles without leaking or unlinking", async () => {
  const dir = privateDir();
  const sockPath = join(dir, "m.sock");
  try {
    // Something is already at the published path, so start() refuses it --
    // deterministically, and for a reason that is not the cancellation.
    writeFileSync(sockPath, "occupied");
    const worker = createUdsWorker(baseConfig(dir));
    const starting = worker.start();
    const stopping = worker.close();
    const [started, stopped] = await Promise.allSettled([starting, stopping]);

    assert.equal(started.status, "rejected");
    assert.match(started.reason.message, /already exists/, "the real startup error is reported");
    assert.notEqual(started.reason.cancelled, true, "and is not mislabelled as a cancellation");
    assert.equal(stopped.status, "fulfilled", "the stop still completes");
    assert.equal(readFileSync(sockPath, "utf8"), "occupied", "the occupying file is untouched");
    assert.deepEqual(readdirSync(dir), ["m.sock"], "no staging socket survived the failed start");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The causal proof. The child is held at the post-publication await, the
// signal is sent while it is held, the handler is observed to have run, and
// only then is startup released. Nothing here waits for a convenient moment.
for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} received while startup is held after publication stops cleanly`, async () => {
    const dir = privateDir();
    const sockPath = join(dir, "m.sock");
    const entry = instrumentedEntrypoint();
    const { child, stderr, exited } = spawnEntrypoint(sockPath, entry);
    try {
      await until(() => stderr.join("").includes("[barrier] published"), { timeoutMs: 15_000 });
      assert.ok(existsSync(sockPath), "the barrier is meant to hold AFTER publication");

      child.kill(signal);
      // The handler ran while startup was still held. Until this line
      // appears, the stop has not landed inside the window and releasing
      // would test the ordinary post-start path instead.
      await until(() => stderr.join("").includes("[barrier] stop-handled"), { timeoutMs: 15_000 });
      assert.ok(existsSync(sockPath), "startup is still held, so the socket is still published");

      child.stdin.write("go\n");
      const end = await exitWithin(exited, 20_000, `${signal} during held startup`);

      assert.equal(end.signal, null, `killed by ${signal} instead of handling it`);
      assert.equal(end.code, 0, `clean exit (stderr: ${stderr.join("")})`);
      assert.equal(existsSync(sockPath), false, "the published socket outlived the worker");
      assert.deepEqual(readdirSync(dir), [], "and no staging socket survived");
    } finally {
      child.kill("SIGKILL");
      await exited.catch(() => {});
      rmSync(entry, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the pre-fix entrypoint ordering is killed by the same barrier", async () => {
  // The control. Same instrumentation, handlers installed only after start()
  // resolves -- which is where they were. Without this, the two tests above
  // would pass on code that never had the defect and prove nothing about it.
  const dir = privateDir();
  const sockPath = join(dir, "m.sock");
  const entry = instrumentedEntrypoint({ legacy: true });
  const { child, stderr, exited } = spawnEntrypoint(sockPath, entry);
  try {
    await until(() => stderr.join("").includes("[barrier] published"), { timeoutMs: 15_000 });
    child.kill("SIGTERM");

    const end = await exitWithin(exited, 20_000, "pre-fix ordering");
    assert.equal(end.signal, "SIGTERM", "the pre-fix ordering is supposed to die by the signal");
    assert.equal(end.code, null);
    assert.ok(
      !stderr.join("").includes("[barrier] stop-handled"),
      "no handler can have run: that is the defect",
    );
    assert.equal(existsSync(sockPath), true, "and the published socket is left behind");
  } finally {
    child.kill("SIGKILL");
    await exited.catch(() => {});
    rmSync(entry, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two starts at once: exactly one is refused, and cleanup still holds", async () => {
  const dir = privateDir();
  const sockPath = join(dir, "m.sock");
  try {
    const worker = createUdsWorker(baseConfig(dir));
    // `server` is only assigned partway through startup, after its first
    // await, so a guard on `server` alone lets both of these through -- and
    // they then share one worker's server, staging path and owned inode.
    const [first, second] = await Promise.allSettled([worker.start(), worker.start()]);
    const outcomes = [first, second];
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1, "exactly one start wins");
    const refused = outcomes.find((o) => o.status === "rejected");
    assert.match(refused.reason.message, /already started/);

    assert.ok(statSync(sockPath).isSocket(), "the winner published exactly one socket");
    await worker.close();
    assert.equal(existsSync(sockPath), false, "and it is the one that gets removed");
    assert.deepEqual(readdirSync(dir), [], "no staging path was orphaned by the loser");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a startup that fails after publishing still takes its socket with it", async () => {
  // The other half of owning the inode. Nothing stops this worker: startup
  // itself fails at a point where the socket is already published, so the
  // only thing that can clean up is start()'s own unwinding -- and it can
  // only do that if it already knows which inode is its own. Claiming
  // ownership after publication instead leaves a live path nothing removes,
  // which the next start then refuses.
  const dir = privateDir();
  const sockPath = join(dir, "m.sock");
  const entry = instrumentedEntrypoint({ failAfterPublish: true });
  const { child, stderr, exited } = spawnEntrypoint(sockPath, entry);
  try {
    const end = await exitWithin(exited, 20_000, "failed startup");
    assert.equal(end.code, 1, `a failed startup exits non-zero (stderr: ${stderr.join("")})`);
    assert.match(stderr.join(""), /injected: startup failed after publishing/);
    assert.equal(existsSync(sockPath), false, "the published socket outlived the failed startup");
    assert.deepEqual(readdirSync(dir), [], "and no staging socket survived");
  } finally {
    child.kill("SIGKILL");
    await exited.catch(() => {});
    rmSync(entry, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
