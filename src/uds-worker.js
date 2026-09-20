// Private Unix-domain-socket MCP worker.
//
// This is NOT a public endpoint and NOT an authentication boundary. It binds one
// filesystem socket inside a directory the operator made private, and it trusts
// the per-request context it reads there *because only a permitted local peer can
// open that socket* — never because a header says so. Put a public listener,
// a proxy, or an untrusted process on the other end and every guarantee below is
// void; terminating OAuth and synthesising the context is the adapter's job.
//
// Each POST gets its own McpServer and its own transport. Nothing about one
// request — key, subject, correlation id, cancellation — outlives it or is
// reachable from another, because none of it is stored anywhere but the closure
// that serves that request.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { chmod, chown, link, lstat, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createServer } from "./server.js";

/** Internal context headers. Names are an encoding, not an assertion of identity. */
export const CONTEXT_HEADERS = Object.freeze({
  subject: "x-siteshot-subject",
  apiKey: "x-siteshot-api-key",
  correlationId: "x-siteshot-correlation-id",
});

/**
 * Headers that must never reach this worker. A public credential arriving here
 * means something is forwarding a public request verbatim — the exact mistake
 * that would turn a header into an identity claim.
 */
const FORBIDDEN_HEADERS = Object.freeze([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "origin",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

const MAX_CONTEXT_VALUE_BYTES = 512;
// Printable ASCII only: the adapter generates these, so anything else is a bug
// or an injection attempt, not a user's name.
const CONTEXT_VALUE_RE = /^[\x21-\x7e]+$/;

const MCP_PATH = "/mcp";

// Enough for the largest refusal this worker can produce, so an over-budget
// response always has a in-budget answer to be replaced by.
const MIN_RESPONSE_BUDGET_BYTES = 1024;

class ConfigError extends Error {}

function requirePositiveInt(config, field) {
  const value = config[field];
  if (value === undefined || value === null) {
    throw new ConfigError(
      `site-shot uds-worker: ${field} must be configured explicitly — this worker does not invent a bound.`,
    );
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`site-shot uds-worker: ${field} must be a positive integer, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new ConfigError("site-shot uds-worker: a configuration object is required.");
  }

  const { socketPath } = config;
  if (socketPath === undefined || socketPath === null) {
    throw new ConfigError("site-shot uds-worker: socketPath must be configured explicitly.");
  }
  if (typeof socketPath !== "string" || !isAbsolute(socketPath)) {
    throw new ConfigError(`site-shot uds-worker: socketPath must be an absolute path, got ${JSON.stringify(socketPath)}.`);
  }

  const { socketMode } = config;
  if (socketMode === undefined || socketMode === null) {
    throw new ConfigError("site-shot uds-worker: socketMode must be configured explicitly.");
  }
  if (typeof socketMode !== "number" || !Number.isInteger(socketMode) || socketMode < 0 || socketMode > 0o777) {
    throw new ConfigError(`site-shot uds-worker: socketMode must be a file mode in 0..0o777, got ${socketMode}.`);
  }
  // "Other" may not reach the socket at all. Group access stays available for the
  // later co-deployed adapter/worker pair (0o660) without opening it to the host.
  if (socketMode & 0o007) {
    throw new ConfigError(`site-shot uds-worker: socketMode must not grant any access to other (got 0${socketMode.toString(8)}).`);
  }

  const { allowedHosts } = config;
  if (allowedHosts === undefined || allowedHosts === null) {
    throw new ConfigError("site-shot uds-worker: allowedHosts must be configured explicitly.");
  }
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0 || allowedHosts.some((h) => typeof h !== "string" || !h)) {
    throw new ConfigError("site-shot uds-worker: allowedHosts must be a non-empty array of host strings.");
  }

  // Widening the mode for the group makes that group a trust principal. Which
  // group it is then has to be stated and verified, not inherited from whatever
  // the directory happened to be created with.
  const groupAccessible = (socketMode & 0o070) !== 0;
  const { socketGroup } = config;
  if (groupAccessible && (socketGroup === undefined || socketGroup === null)) {
    throw new ConfigError(
      `site-shot uds-worker: socketMode 0${socketMode.toString(8)} grants group access, so socketGroup must name ` +
        `the gid that access is for.`,
    );
  }
  if (socketGroup !== undefined && socketGroup !== null) {
    if (typeof socketGroup !== "number" || !Number.isInteger(socketGroup) || socketGroup < 0) {
      throw new ConfigError(`site-shot uds-worker: socketGroup must be a numeric gid, got ${JSON.stringify(socketGroup)}.`);
    }
  }

  const limits = {
    maxRequestBytes: requirePositiveInt(config, "maxRequestBytes"),
    // The bytes the renderer returned...
    maxImageBytes: requirePositiveInt(config, "maxImageBytes"),
    // ...and the bytes we actually write, which base64 inflates by 4/3 before the
    // JSON-RPC envelope is added. Bounding only the first lets a within-budget
    // image become an over-budget response.
    maxResponseBytes: requirePositiveInt(config, "maxResponseBytes"),
    maxErrorBodyBytes: requirePositiveInt(config, "maxErrorBodyBytes"),
    maxConcurrentRequests: requirePositiveInt(config, "maxConcurrentRequests"),
    captureTimeoutMs: requirePositiveInt(config, "captureTimeoutMs"),
    requestBodyTimeoutMs: requirePositiveInt(config, "requestBodyTimeoutMs"),
  };
  // The refusal we substitute for an over-budget response has to fit the budget
  // itself, or the bound would have no way to hold.
  if (limits.maxResponseBytes < MIN_RESPONSE_BUDGET_BYTES) {
    throw new ConfigError(
      `site-shot uds-worker: maxResponseBytes must be at least ${MIN_RESPONSE_BUDGET_BYTES} bytes so the ` +
        `over-budget refusal itself fits, got ${limits.maxResponseBytes}.`,
    );
  }

  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ConfigError("site-shot uds-worker: fetchImpl must be a function (no global fetch available).");
  }

  const logger = config.logger ?? ((line) => process.stderr.write(`${line}\n`));
  if (typeof logger !== "function") {
    throw new ConfigError(`site-shot uds-worker: logger must be a function, got ${typeof config.logger}.`);
  }

  return Object.freeze({
    socketPath,
    socketMode,
    socketGroup: socketGroup ?? null,
    allowedHosts: Object.freeze([...allowedHosts]),
    ...limits,
    fetchImpl,
    logger,
  });
}

/** name -> [values], preserving duplicates so a doubled context header is visible. */
function collectHeaders(rawHeaders) {
  const out = new Map();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    const list = out.get(name);
    if (list) list.push(rawHeaders[i + 1]);
    else out.set(name, [rawHeaders[i + 1]]);
  }
  return out;
}

/**
 * Turn the request headers into the immutable context this request owns, or a
 * rejection. Never reports a value back — only which header was wrong.
 */
function readContext(headers) {
  const fields = {};
  for (const [field, name] of Object.entries(CONTEXT_HEADERS)) {
    const values = headers.get(name);
    if (!values) {
      return { error: { status: 403, reason: "context_missing", message: `Forbidden: missing ${name}.` } };
    }
    if (values.length > 1) {
      return { error: { status: 403, reason: "context_duplicate", message: `Forbidden: duplicate ${name}.` } };
    }
    const value = values[0];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value) > MAX_CONTEXT_VALUE_BYTES ||
      !CONTEXT_VALUE_RE.test(value)
    ) {
      return { error: { status: 403, reason: "context_invalid", message: `Forbidden: malformed ${name}.` } };
    }
    fields[field] = value;
  }
  return { context: Object.freeze(fields) };
}

function sendJsonRpcError(res, status, { code, message, reason, headers = {} }) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message, data: { reason } } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

/**
 * Read the request body with a hard byte ceiling and its own deadline. Refuses
 * before buffering rather than truncating: a half-read JSON-RPC envelope is not
 * a smaller request, it is a different one.
 */
function readBoundedRequestBody(req, { limit, timeoutMs }) {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      resolve({ error: { status: 413, reason: "payload_too_large" } });
      return;
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      resolve(value);
    };

    const timer = setTimeout(() => {
      finish({ error: { status: 408, reason: "request_body_timeout" } });
    }, timeoutMs);

    const onData = (chunk) => {
      total += chunk.length;
      if (total > limit) {
        finish({ error: { status: 413, reason: "payload_too_large" } });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish({ body: Buffer.concat(chunks) });
    const onError = () => finish({ error: { status: 400, reason: "request_body_error" } });
    const onAborted = () => finish({ aborted: true });

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

/** The JSON-RPC id of a single request, or null for a batch or a malformed one. */
function jsonRpcIdOf(parsedBody) {
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) return null;
  const { id } = parsedBody;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

// Node writes the status line itself and may add framing headers we do not set.
// Reserved so the budget covers what actually reaches the socket, not only the
// part this code composes. The acceptance suite measures the real socket bytes.
const HTTP_FRAMING_RESERVE_BYTES = 64;

function httpHeadBytes(status, entries) {
  let total = Buffer.byteLength(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ""}\r\n`);
  for (const [name, value] of entries) total += Buffer.byteLength(`${name}: ${value}\r\n`);
  return total + 2 + HTTP_FRAMING_RESERVE_BYTES; // + the blank line that ends the head
}

/** Read a Response body into memory, refusing past `cap` rather than buffering on. */
async function readBoundedResponseBody(response, cap) {
  if (!response.body) return { bytes: Buffer.alloc(0) };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return { overLimit: true };
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return { bytes: Buffer.concat(chunks, total) };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released by cancel() */
    }
  }
}

function tooLargeBody(id, budget) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message:
        `The response is larger than this server's ${budget}-byte output limit and was not sent. Capture a ` +
        `smaller region — lower max_height, or use jpeg instead of png.`,
      data: { reason: "response_too_large", limitBytes: budget },
    },
  });
}

/**
 * Forward the SDK's Response to the socket, or refuse it — decided before a
 * single header is written.
 *
 * Everything the SDK can emit passes through here: tool results, protocol
 * errors it generates itself, and the 202 for a notification. The refusal is
 * measured too, and drops the request id if echoing it is what would not fit —
 * a 3000-character id cannot be answered inside a 1 KiB budget.
 */
async function writeBoundedResponse(res, response, { budget, requestId }) {
  res.sendDate = false;
  const headerEntries = [...response.headers];
  const body = await readBoundedResponseBody(response, budget + 1);

  if (!body.overLimit) {
    const entries = [...headerEntries, ["content-length", String(body.bytes.byteLength)]];
    if (httpHeadBytes(response.status, entries) + body.bytes.byteLength <= budget) {
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(response.status, Object.fromEntries(entries));
        res.end(body.bytes);
      }
      return { refused: false };
    }
  }

  // Refuse, at a size we have checked rather than hoped for.
  let payload = Buffer.from(tooLargeBody(requestId, budget), "utf8");
  let entries = [
    ["content-type", "application/json"],
    ["content-length", String(payload.byteLength)],
  ];
  if (httpHeadBytes(500, entries) + payload.byteLength > budget) {
    payload = Buffer.from(tooLargeBody(null, budget), "utf8");
    entries = [
      ["content-type", "application/json"],
      ["content-length", String(payload.byteLength)],
    ];
  }
  if (!res.headersSent && !res.writableEnded) {
    res.writeHead(500, Object.fromEntries(entries));
    res.end(payload);
  }
  return { refused: true };
}

/**
 * Build the private worker. `start()` binds the socket after verifying that the
 * directory it lives in is actually private; `close()` removes only the socket
 * this process created.
 */
export function createUdsWorker(rawConfig) {
  const config = validateConfig(rawConfig);

  let server = null;
  let ownedSocket = null; // { dev, ino } of the socket we published, for safe cleanup.
  let boundPath = null; // The private staging path Node actually bound, and will unlink itself.
  // Startup and shutdown have to be able to happen at the same time. A
  // supervisor may cancel a start at any point, including after the socket is
  // reachable, and the answer to that cannot be "wait until it is convenient":
  // these three make a stop during a start deterministic instead.
  let startPromise = null; // The in-flight start(), so close() can let it settle.
  let closePromise = null; // The in-flight close(), so repeated stops are one stop.
  // Sticky, and checked at one point: immediately before link(). A stop that
  // arrives before that check stops the start without publishing; a stop that
  // arrives while link() is already in flight still publishes, and is cleaned
  // up rather than prevented -- which is why ownership is claimed before the
  // link rather than after it.
  let stopRequested = false;
  const active = new Set();
  const stats = { accepted: 0, rejected: 0, peakActive: 0 };

  /** One line per terminal outcome. Carries the correlation id and nothing else from the context. */
  function log(outcome, fields = {}) {
    const parts = [`site-shot-mcp-uds outcome=${outcome}`];
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) parts.push(`${key}=${value}`);
    }
    config.logger(parts.join(" "));
  }

  async function handle(req, res) {
    // 1. Route. Nothing but the one MCP endpoint exists here; a GET stream, a
    //    DELETE session teardown and an unknown path are refused, not downgraded.
    const [path] = String(req.url ?? "").split("?");
    if (req.method !== "POST") {
      stats.rejected++;
      sendJsonRpcError(res, 405, {
        code: -32000,
        message: "Method Not Allowed: this transport serves POST /mcp only.",
        reason: "method_not_allowed",
        headers: { allow: "POST" },
      });
      return;
    }
    if (path !== MCP_PATH || String(req.url ?? "").includes("?")) {
      stats.rejected++;
      sendJsonRpcError(res, 404, {
        code: -32000,
        message: "Not Found: this transport serves POST /mcp only.",
        reason: "not_found",
      });
      return;
    }

    const headers = collectHeaders(req.rawHeaders);

    // 2. Nothing public may ride along. These are refused outright rather than
    //    stripped, so a misconfigured adapter fails loudly instead of silently
    //    handing us an identity claim we would have to remember to ignore.
    for (const name of FORBIDDEN_HEADERS) {
      if (headers.has(name)) {
        stats.rejected++;
        sendJsonRpcError(res, 403, {
          code: -32000,
          message: `Forbidden: ${name} is not accepted by this private transport.`,
          reason: "forbidden_header",
        });
        return;
      }
    }

    const hostValues = headers.get("host") ?? [];
    if (hostValues.length !== 1 || !config.allowedHosts.includes(hostValues[0])) {
      stats.rejected++;
      sendJsonRpcError(res, 403, {
        code: -32000,
        message: "Forbidden: Host is not in the configured allow-list.",
        reason: "host_not_allowed",
      });
      return;
    }

    // 3. Sessions do not exist here. A supplied id is refused rather than
    //    ignored, so no client can believe it holds one.
    if (headers.has("mcp-session-id")) {
      stats.rejected++;
      sendJsonRpcError(res, 400, {
        code: -32000,
        message: "Bad Request: this transport is stateless and issues no session id.",
        reason: "session_not_supported",
      });
      return;
    }

    // 4. Authenticate the private context before any body or capture work.
    const { context, error: contextError } = readContext(headers);
    if (contextError) {
      stats.rejected++;
      sendJsonRpcError(res, contextError.status, {
        code: -32600,
        message: contextError.message,
        reason: contextError.reason,
      });
      return;
    }

    await serveMcp(req, res, { context, headers, hostValue: hostValues[0] });
  }

  async function serveMcp(req, res, { context, headers, hostValue }) {
    // 5. Admission. No queue: a request we cannot serve now is refused now,
    //    before a body is buffered or a render is paid for.
    if (active.size >= config.maxConcurrentRequests) {
      stats.rejected++;
      sendJsonRpcError(res, 503, {
        code: -32000,
        message: "Service Unavailable: this worker is at its configured concurrency limit.",
        reason: "capacity_exhausted",
      });
      return;
    }

    const slot = { context };
    active.add(slot);
    stats.accepted++;
    stats.peakActive = Math.max(stats.peakActive, active.size);

    let outcome = "served";
    let mcpServer = null;
    let transport = null;
    let disconnected = false;
    let resolveDisconnect;
    const disconnect = new Promise((resolve) => {
      resolveDisconnect = resolve;
    });

    // Registered before any awaiting, so a caller that hangs up during the body
    // read — or during a 70-second render — is noticed at once.
    const onClose = () => {
      if (res.writableFinished) return;
      disconnected = true;
      outcome = "client_disconnected";
      // Closing the transport runs the SDK's own close path, which aborts every
      // in-flight request handler; that signal is what reaches the capture fetch.
      void teardown();
      resolveDisconnect();
    };
    res.on("close", onClose);

    // One teardown, shared by the disconnect handler and the finally, so the
    // second caller waits for the first rather than racing past it.
    let tornDown = null;
    function teardown() {
      tornDown ??= (async () => {
        await transport?.close().catch(() => {});
        await mcpServer?.close().catch(() => {});
      })();
      return tornDown;
    }

    try {
      const read = await readBoundedRequestBody(req, {
        limit: config.maxRequestBytes,
        timeoutMs: config.requestBodyTimeoutMs,
      });
      if (read.aborted || disconnected) return;
      if (read.error) {
        stats.rejected++;
        outcome = read.error.reason;
        sendJsonRpcError(res, read.error.status, {
          code: -32600,
          message:
            read.error.reason === "payload_too_large"
              ? `Payload Too Large: the request body exceeds ${config.maxRequestBytes} bytes.`
              : "Bad Request: the request body could not be read.",
          reason: read.error.reason,
        });
        return;
      }

      let parsedBody;
      try {
        parsedBody = JSON.parse(read.body.toString("utf8"));
      } catch {
        stats.rejected++;
        outcome = "parse_error";
        sendJsonRpcError(res, 400, { code: -32700, message: "Parse error: Invalid JSON", reason: "parse_error" });
        return;
      }

      // A fresh server and transport per POST. Statelessness is not a setting
      // here, it is the whole isolation story: nothing survives this function.
      mcpServer = createServer({
        apiKey: context.apiKey,
        fetchImpl: config.fetchImpl,
        capture: {
          timeoutMs: config.captureTimeoutMs,
          maxImageBytes: config.maxImageBytes,
          maxErrorBodyBytes: config.maxErrorBodyBytes,
        },
      });
      // The web-standard transport rather than the Node wrapper, because it hands
      // back a `Response` instead of writing to the socket itself. That is the
      // only place a byte budget can actually hold: the SDK produces protocol
      // errors of its own that never pass through `send`, and a refusal that
      // echoes a caller's 3000-character JSON-RPC id is over budget itself. One
      // choke point, measured before a single header is forwarded.
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcpServer.connect(transport);

      let webRequest;
      try {
        webRequest = new Request(`http://${hostValue}${req.url}`, {
          method: req.method,
          headers: Object.fromEntries([...headers].map(([name, values]) => [name, values[0]])),
          body: read.body,
        });
      } catch {
        stats.rejected++;
        outcome = "request_headers_invalid";
        sendJsonRpcError(res, 400, {
          code: -32600,
          message: "Bad Request: the request could not be represented.",
          reason: "request_headers_invalid",
        });
        return;
      }

      // In JSON mode the SDK resolves only once every response is ready, so a
      // disconnect has to win the race or this would await a reply no one wants.
      const response = await Promise.race([transport.handleRequest(webRequest, { parsedBody }), disconnect]);
      if (disconnected || !response) return;

      const written = await writeBoundedResponse(res, response, {
        budget: config.maxResponseBytes,
        requestId: jsonRpcIdOf(parsedBody),
      });
      if (written.refused) outcome = "response_too_large";
    } finally {
      res.off("close", onClose);
      await teardown();
      active.delete(slot);
      if (!res.writableEnded) res.destroy();
      // The correlation id is adapter-generated and is the only part of the
      // context that may be written down: the key is a secret and the subject
      // identifies a customer.
      //
      // Unlike startup, a logging failure here is swallowed: the request is
      // already answered, and failing a served capture because a log sink broke
      // would trade a real result for a bookkeeping problem.
      try {
        log(outcome, { correlation: context.correlationId, status: res.statusCode });
      } catch {
        /* a broken log sink must not undo a completed request */
      }
    }
  }

  /** Thrown when a stop arrives while start() is still running. Not a fault. */
  class StartCancelled extends Error {
    constructor() {
      super("site-shot uds-worker: startup cancelled by shutdown.");
      this.name = "StartCancelled";
      this.cancelled = true;
    }
  }

  /**
   * Release everything this worker owns. Idempotent, and safe to call from a
   * failed start: unlike close() it does NOT wait for a start to settle, which
   * is what lets start()'s own error path use it without deadlocking against a
   * close() that is waiting for that same start.
   */
  async function teardown() {
    const current = server;
    server = null;
    if (current) {
      const stopped = new Promise((resolve) => current.close(() => resolve()));
      // Destroy live connections rather than waiting them out: an in-flight
      // 90-second capture would otherwise hold shutdown open for 90 seconds.
      // Each destroyed response fires the close handler that cancels its capture.
      current.closeIdleConnections?.();
      current.closeAllConnections?.();
      await stopped;
    }
    if (boundPath) {
      await unlink(boundPath).catch(() => {});
      boundPath = null;
    }
    // Only our own socket, identified by the inode we published — never
    // whatever happens to sit at that path now.
    if (ownedSocket) {
      const now = await stat(config.socketPath).catch(() => null);
      if (now && now.dev === ownedSocket.dev && now.ino === ownedSocket.ino) {
        await unlink(config.socketPath).catch(() => {});
      }
      ownedSocket = null;
    }
  }

  /**
   * The startup itself. A private closure, not a method: a caller that
   * could reach it directly would bind a socket without the lifecycle
   * tracking that lets a stop wait for it.
   */
  async function doStart() {
    const parent = dirname(config.socketPath);
    const parentStat = await lstat(parent).catch(() => null);
    if (!parentStat) {
      throw new Error(`site-shot uds-worker: socket directory does not exist: ${parent}`);
    }
    if (parentStat.isSymbolicLink()) {
      throw new Error(`site-shot uds-worker: socket directory is a symlink, refusing to bind: ${parent}`);
    }
    if (!parentStat.isDirectory()) {
      throw new Error(`site-shot uds-worker: socket directory is not a directory: ${parent}`);
    }
    if (parentStat.mode & 0o002) {
      throw new Error(`site-shot uds-worker: socket directory is world-writable, refusing to bind: ${parent}`);
    }
    // Group-writable is refused for every mode, not only when a group is
    // trusted: write permission on the directory is permission to unlink our
    // socket and bind another in its place, and the adapter would then hand
    // its request context — including the customer's key — to whoever did.
    // Reaching a socket needs traverse permission on the directory, never write.
    if (parentStat.mode & 0o020) {
      throw new Error(`site-shot uds-worker: socket directory is group-writable, refusing to bind: ${parent}`);
    }
    if (typeof process.getuid === "function" && parentStat.uid !== process.getuid()) {
      throw new Error(`site-shot uds-worker: socket directory is not owned by this process: ${parent}`);
    }
    if (config.socketGroup !== null) {
      // A 0660 socket in a directory the group cannot traverse is unreachable
      // by the peer the mode was widened for — a silently useless permission.
      if (parentStat.gid !== config.socketGroup) {
        throw new Error(
          `site-shot uds-worker: socket directory group is ${parentStat.gid}, not the trusted group ` +
            `${config.socketGroup}: ${parent}`,
        );
      }
      if (!(parentStat.mode & 0o010)) {
        throw new Error(
          `site-shot uds-worker: socket directory is not traversable by the trusted group ` +
            `${config.socketGroup}: ${parent}`,
        );
      }
    }

    // Never unlink a path we did not create: a stale socket is an operator
    // decision, and an unrelated file at that path must survive us entirely.
    const existing = await lstat(config.socketPath).catch(() => null);
    if (existing) {
      throw new Error(
        `site-shot uds-worker: ${config.socketPath} already exists; remove it deliberately before starting.`,
      );
    }

    // Node's listener teardown unlinks the path it bound, unconditionally and
    // without checking what is there by then. So it never binds the published
    // path: it binds a private staging name, we hard-link that name to the
    // published one, and we drop the staging name immediately. Node is then
    // left holding a path that no longer exists, and the published path is only
    // ever removed by the inode check in close().
    const staging = `${parent}/.ss-${randomBytes(5).toString("hex")}`;
    if (Buffer.byteLength(staging) > 100) {
      throw new Error(`site-shot uds-worker: socket directory path is too long to bind safely: ${parent}`);
    }

    server = http.createServer();
    server.on("request", (req, res) => {
      handle(req, res).catch(() => {
        sendJsonRpcError(res, 500, { code: -32603, message: "Internal error.", reason: "internal_error" });
      });
    });

    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server?.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server?.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(staging);
      });
      boundPath = staging;

      // Mode and group are applied while the socket is still private, so it is
      // never reachable at the published path with the wrong permissions.
      await chmod(staging, config.socketMode);
      if (config.socketGroup !== null && typeof process.getuid === "function") {
        try {
          await chown(staging, process.getuid(), config.socketGroup);
        } catch (err) {
          throw new Error(
            `site-shot uds-worker: cannot give the socket to group ${config.socketGroup} ` +
              `(${err?.code ?? "failed"}); this process is not a member of it.`,
          );
        }
      }

      const staged = await stat(staging);
      if ((staged.mode & 0o777) !== config.socketMode) {
        throw new Error("site-shot uds-worker: socketMode could not be applied to the socket.");
      }
      if (typeof process.getuid === "function" && staged.uid !== process.getuid()) {
        throw new Error("site-shot uds-worker: socket is not owned by this process.");
      }
      if (config.socketGroup !== null && staged.gid !== config.socketGroup) {
        throw new Error(
          `site-shot uds-worker: socket group is ${staged.gid}, not the configured group ${config.socketGroup}.`,
        );
      }

      // Last point at which nothing is reachable yet. A stop that has
      // already arrived stops here, rather than publishing a socket and
      // relying on someone to come back for it.
      if (stopRequested) throw new StartCancelled();

      // Claim the inode BEFORE publishing it. A hard link is another name
      // for this same inode, so `staged` identifies what link() is about to
      // expose -- and if anything between here and the end of start() fails,
      // teardown already knows which inode is ours to remove. Claiming it
      // after link() left a window where the socket was published and
      // unowned, which is precisely the state nothing cleans up.
      ownedSocket = { dev: staged.dev, ino: staged.ino };

      // link() refuses to clobber, so a race that created something at the
      // published path in the meantime fails the start rather than winning it.
      await link(staging, config.socketPath);

      // Inside the guarded region on purpose: if the logger throws, startup
      // must unwind the listener and the published socket rather than leaving
      // a live, reachable worker behind a failed start().
      log("started", { socket: config.socketPath, mode: `0${config.socketMode.toString(8)}` });
    } catch (err) {
      // teardown, not close(): close() waits for the in-flight start, and
      // that start is this one.
      await teardown();
      throw err;
    } finally {
      // Either it is published under its real name or the start failed; either
      // way the staging name has done its job.
      await unlink(staging).catch(() => {});
      if (boundPath === staging) boundPath = null;
    }

  }

  return {
    /**
     * Start once. Both guards matter: `server` is only assigned partway
     * through doStart(), after its first await, so two calls that arrive
     * together would both pass a `server`-only check, share this worker's
     * server/boundPath/ownedSocket and leave teardown holding one of them.
     * `startPromise` is assigned synchronously here, before doStart() can
     * yield, so the second caller is refused deterministically.
     */
    async start() {
      if (server || startPromise) throw new Error("site-shot uds-worker: already started.");
      // A stop that arrived before this call is still a stop. Starting anyway
      // would publish a socket nothing is going to remove.
      if (stopRequested) throw new StartCancelled();
      startPromise = doStart();
      try {
        await startPromise;
        return this;
      } finally {
        startPromise = null;
      }
    },

    address() {
      // The published path, not the staging name Node reports.
      return server ? config.socketPath : null;
    },

    /**
     * What the listener is actually bound to, as Node reports it. A string is a
     * pipe/UDS; an object with a port would mean a TCP listener exists, which is
     * the one thing this worker must never have.
     */
    listenerAddress() {
      return server?.address() ?? null;
    },

    activeCount() {
      return active.size;
    },

    stats() {
      return { ...stats, active: active.size };
    },

    /**
     * Stop, including while starting.
     *
     * Two things make this safe to call at any moment. It marks the stop
     * first, synchronously, so a start that has not published yet unwinds
     * instead of publishing; and it then waits for any in-flight start to
     * SETTLE before releasing anything, so cleanup never races the code that
     * is still acquiring. The wait is on the start's own filesystem work, not
     * on a timer.
     *
     * Repeated stops are one stop: every caller gets the same promise and
     * returns when the single teardown is done, so a SIGINT arriving behind a
     * SIGTERM cannot exit the process while the first stop is mid-cleanup.
     */
    async close() {
      stopRequested = true;
      if (!closePromise) {
        closePromise = (async () => {
          const pending = startPromise;
          // Its failure is the start's to report, not this shutdown's.
          if (pending) await pending.catch(() => {});
          await teardown();
        })();
      }
      return closePromise;
    },

    /** Whether a stop has been asked for. The signal handlers read this. */
    get stopping() {
      return stopRequested;
    },
  };
}

// ---------------------------------------------------------------------------
// Private entrypoint
// ---------------------------------------------------------------------------

function requiredEnv(env, name) {
  const value = env[name];
  if (value === undefined || value === null || value === "") {
    throw new ConfigError(`site-shot uds-worker: ${name} must be set; this worker has no default for it.`);
  }
  return value;
}

function requiredEnvInt(env, name) {
  const raw = requiredEnv(env, name);
  if (!/^\d+$/.test(raw.trim())) {
    throw new ConfigError(`site-shot uds-worker: ${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return Number(raw.trim());
}

/**
 * Build the worker configuration from the environment.
 *
 * Note what is *not* here: `SITESHOT_API_KEY`. The key belongs to a request, and
 * this process may not hold one even if its environment offers it.
 */
export function configFromEnv(env = process.env) {
  const mode = requiredEnv(env, "SITESHOT_MCP_UDS_MODE").trim();
  if (!/^0?[0-7]{3}$/.test(mode)) {
    throw new ConfigError(`site-shot uds-worker: SITESHOT_MCP_UDS_MODE must be an octal mode, got ${JSON.stringify(mode)}.`);
  }
  const group = env.SITESHOT_MCP_UDS_GROUP;
  if (group !== undefined && group !== "" && !/^\d+$/.test(group.trim())) {
    throw new ConfigError("site-shot uds-worker: SITESHOT_MCP_UDS_GROUP must be a numeric gid.");
  }

  const config = {
    socketPath: requiredEnv(env, "SITESHOT_MCP_UDS_PATH"),
    socketMode: Number.parseInt(mode, 8),
    allowedHosts: requiredEnv(env, "SITESHOT_MCP_ALLOWED_HOSTS")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
    maxRequestBytes: requiredEnvInt(env, "SITESHOT_MCP_MAX_REQUEST_BYTES"),
    maxImageBytes: requiredEnvInt(env, "SITESHOT_MCP_MAX_IMAGE_BYTES"),
    maxResponseBytes: requiredEnvInt(env, "SITESHOT_MCP_MAX_RESPONSE_BYTES"),
    maxErrorBodyBytes: requiredEnvInt(env, "SITESHOT_MCP_MAX_ERROR_BODY_BYTES"),
    maxConcurrentRequests: requiredEnvInt(env, "SITESHOT_MCP_MAX_CONCURRENT_REQUESTS"),
    captureTimeoutMs: requiredEnvInt(env, "SITESHOT_MCP_CAPTURE_TIMEOUT_MS"),
    requestBodyTimeoutMs: requiredEnvInt(env, "SITESHOT_MCP_REQUEST_BODY_TIMEOUT_MS"),
  };
  if (group !== undefined && group !== "") config.socketGroup = Number(group.trim());

  // Validate now, at startup, rather than on the first request.
  validateConfig(config);
  return config;
}

async function main() {
  const worker = createUdsWorker(configFromEnv());

  // BEFORE start(), not after. start() publishes a reachable socket partway
  // through and then keeps going -- it still awaits an unlink of the staging
  // name before it returns -- so a supervisor that signals a worker it can
  // already reach used to hit the default action: killed by the signal, with
  // the published socket left behind for the next start to refuse.
  //
  // Registered here, the handlers cover every startup and publication phase
  // that follows, which is every phase in which this process owns anything.
  // They do not cover module import and configuration, and they do not need
  // to: nothing is bound, published or reachable yet, so a termination there
  // has nothing to clean up.
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // close() waits for an in-flight start to settle before releasing
    // anything, so this is exactly as correct mid-startup as it is later.
    await worker.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  try {
    await worker.start();
  } catch (err) {
    if (worker.stopping) {
      // We asked for this: the stop above cancelled the start, and it owns
      // the exit. A genuine startup error that happened to land in the same
      // moment is still worth one line, without unwinding the shutdown.
      if (!err?.cancelled) {
        process.stderr.write(
          `[site-shot-mcp-uds] Startup ended during shutdown: ${err?.message ?? "failed"}\n`,
        );
      }
      return;
    }
    throw err;
  }
}

// Only when run directly. Importing this module must never bind a socket.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // The message is ours; a stack here could quote configuration we do not print.
    process.stderr.write(`[site-shot-mcp-uds] Fatal: ${err?.message ?? "startup failed"}\n`);
    process.exit(1);
  });
}
