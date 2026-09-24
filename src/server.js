import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Read from package.json rather than repeating the number here. A literal in this file
// is a second place a release has to remember to touch, and it was already missed once:
// 1.1.2 shipped to npm while the handshake kept answering 1.1.1, so every client and
// every directory reviewer was told the wrong version by the server itself. package.json
// is always present in the published tarball, and `src/` sits one level below it both in
// the repo and in an installed node_modules copy.
const { version: PACKAGE_VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const API_BASE = "https://api.site-shot.com/";
const REQUEST_TIMEOUT_MS = 90_000; // Site-Shot renders can take up to ~70s on heavy pages.
// How much of a non-image response we are willing to look at to classify it. We
// never return this text, so the cap only bounds the read, never the meaning.
const ERROR_BODY_LIMIT_BYTES = 64 * 1024;

/** Stable, agent- and log-safe classification for everything that can go wrong. */
export const CAPTURE_ERROR_CODES = Object.freeze({
  missingApiKey: "missing_api_key",
  invalidUrl: "invalid_url",
  invalidCountry: "invalid_country",
  deadlineExceeded: "deadline_exceeded",
  clientCancelled: "client_cancelled",
  upstreamUnreachable: "upstream_unreachable",
  upstreamError: "upstream_error",
  countryUnavailable: "country_unavailable",
  responseTooLarge: "response_too_large",
  responseUnreadable: "response_unreadable",
  unsupportedImageType: "unsupported_image_type",
});

/**
 * The only MIME types a capture may come back as.
 *
 * Both tools offer exactly three formats, so these are the three types that can
 * be a legitimate answer. Copying the upstream Content-Type through instead would
 * put an arbitrary upstream string into the MCP result, and would accept
 * `image/svg+xml` — active content the caller never asked for, handed to whatever
 * renders the result. `image/jpg` is a common alias but is deliberately absent:
 * nothing here has observed the API sending it, and an unverified alias is a
 * guess. A real capture should confirm the exact types before any is added.
 * `image/webp` was confirmed that way on 2026-09-24: format=webp on example.com
 * answered HTTP 200, `Content-Type: image/webp`, body `RIFF....WEBPVP8L`.
 */
const SERVED_IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);

/**
 * A tool error carrying a stable machine-readable code.
 *
 * The code also appears in the text because that is the part an agent actually
 * reads; `_meta` is for the adapter and the logs. Neither ever carries upstream
 * body text, the request URL, or the key that URL contains.
 */
function captureError(code, text, extra = {}) {
  return {
    isError: true,
    content: [{ type: "text", text }],
    _meta: { "com.site-shot.mcp/error": { code, ...extra } },
  };
}

function abortError(reason) {
  const err = new Error(reason);
  err.name = "AbortError";
  return err;
}

/**
 * A promise that rejects when `signal` aborts, so a read can be abandoned even
 * if the underlying stream would never notice the abort by itself.
 */
function rejectOnAbort(signal) {
  let cancel = () => {};
  const promise = new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError("aborted"));
      return;
    }
    const onAbort = () => reject(abortError("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    cancel = () => signal.removeEventListener("abort", onAbort);
  });
  // The loop below may finish before the signal ever fires; without this the
  // late rejection would surface as an unhandled rejection.
  promise.catch(() => {});
  return { promise, cancel };
}

/**
 * Read a response body under a byte ceiling and a live abort signal.
 *
 * `mode` is the whole point of the function:
 *  - "reject"   — an over-sized body is a failure. Used for the image, where a
 *                 truncated buffer would be a corrupt screenshot presented as a
 *                 good one.
 *  - "truncate" — stop at the ceiling and cancel the rest. Used for a non-image
 *                 body we only inspect for a known marker and never return.
 */
async function readBoundedBody(res, { limit, signal, mode }) {
  // A body that is not a readable stream cannot be bounded or aborted. There is
  // deliberately no buffer-the-whole-thing fallback: it would be a second, weaker
  // path through the one function whose entire job is enforcing the first.
  if (!res.body || typeof res.body.getReader !== "function") {
    throw new TypeError("capture response has no readable body stream");
  }
  {
    const reader = res.body.getReader();
    const abort = signal ? rejectOnAbort(signal) : null;
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = abort ? await Promise.race([reader.read(), abort.promise]) : await reader.read();
        if (done) break;
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (limit != null && total + chunk.byteLength > limit) {
          if (mode === "truncate") {
            chunks.push(chunk.subarray(0, limit - total));
            total = limit;
            await reader.cancel().catch(() => {});
            return { bytes: Buffer.concat(chunks, total), truncated: true };
          }
          await reader.cancel().catch(() => {});
          return { overLimit: true, total: total + chunk.byteLength };
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      return { bytes: Buffer.concat(chunks, total), truncated: false };
    } catch (err) {
      // An abort must actually stop the upstream transfer, not just stop us
      // looking at it: cancel the reader before the failure propagates.
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      abort?.cancel();
      try {
        reader.releaseLock();
      } catch {
        /* already released by cancel() */
      }
    }
  }
}

/**
 * Map friendly tool params to Site-Shot API query params and capture a screenshot.
 * Returns an MCP tool result ({ content, isError?, _meta? }).
 *
 * @param {object} args Tool arguments.
 * @param {object} opts
 * @param {string} opts.apiKey       The key for *this* call. Never read from the environment here.
 * @param {function} opts.fetchImpl  fetch implementation.
 * @param {AbortSignal} [opts.signal] Caller cancellation (the SDK request signal on the remote path).
 * @param {number} [opts.timeoutMs]  Overall capture deadline, armed until the body is fully consumed.
 * @param {number} [opts.maxImageBytes] Hard ceiling on returned image bytes. Omitted = unbounded (stdio).
 * @param {number} [opts.maxErrorBodyBytes] Ceiling on the non-image body we inspect to classify a failure.
 */
export async function captureScreenshot(args, opts) {
  const {
    apiKey,
    fetchImpl,
    signal: callerSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxImageBytes,
    maxErrorBodyBytes = ERROR_BODY_LIMIT_BYTES,
  } = opts;

  if (!apiKey) {
    return captureError(
      CAPTURE_ERROR_CODES.missingApiKey,
      "Missing Site-Shot API key. Set the SITESHOT_API_KEY environment variable " +
        "(get a key at https://www.site-shot.com/pricing/).",
    );
  }

  const {
    url: rawUrl,
    full_page = false,
    width,
    height,
    format = "png",
    block_ads = true,
    block_cookie_banners = true,
    country,
    strict_country,
    language,
    time_zone,
    geolocation,
    wait_ms,
    max_height,
  } = args;

  // Accept bare domains like "example.com" by assuming https://, so agents
  // don't have to remember the scheme.
  const trimmed = String(rawUrl ?? "").trim();
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    new URL(url);
  } catch {
    // The rejected value is deliberately not quoted back: a URL can carry
    // userinfo credentials ("https://user:secret@host"), and an error message is
    // copied into results, transcripts and logs far more freely than a request is.
    return captureError(
      CAPTURE_ERROR_CODES.invalidUrl,
      `Invalid URL (${CAPTURE_ERROR_CODES.invalidUrl}): pass a web page URL such as https://example.com — a bare ` +
        `domain like example.com also works. The value you sent is not repeated here, because a URL can contain ` +
        `credentials; check the url argument.`,
    );
  }

  // Not `strict_country = true` in the destructuring: a default only fills in for
  // undefined, so an explicit null would read as falsy and silently drop us back to
  // the US-fallback this whole branch exists to prevent. Only false opts out.
  const strictCountry = strict_country !== false;

  // Site-Shot matches the country code exactly. Anything it doesn't recognise — a full
  // name like "Germany" — silently renders through a US proxy, which the caller can't
  // spot in the returned image, so reject unusable values before spending a render.
  //
  // typeof, never String(): String([]) is "", so coercing here would skip the whole
  // branch for a non-string and drop the caller's country with no error at all.
  let countryCode;
  const rawCountry = typeof country === "string" ? country.trim() : country;
  if (rawCountry != null && rawCountry !== "") {
    if (typeof rawCountry !== "string" || !/^[A-Za-z]{2}$/.test(rawCountry)) {
      // Same rule as the URL above: say what is wrong and what to send instead,
      // and describe the rejected value by type rather than quoting it back.
      return captureError(
        CAPTURE_ERROR_CODES.invalidCountry,
        `Invalid country (${CAPTURE_ERROR_CODES.invalidCountry}): received a ${typeof country} value that is not a ` +
          `two-letter ISO 3166-1 alpha-2 code — "DE" for Germany, "FR" for France, "JP" for Japan. Full country ` +
          `names are not accepted. Full list: https://www.site-shot.com/countries`,
      );
    }
    countryCode = rawCountry.toUpperCase();
  }

  const params = new URLSearchParams();
  params.set("url", url);
  params.set("userkey", apiKey);
  params.set("format", format);

  if (full_page) {
    params.set("full_size", "1");
    params.set("max_height", String(max_height ?? 20000));
  } else if (max_height != null) {
    params.set("max_height", String(max_height));
  }
  if (width != null) params.set("width", String(width));
  if (height != null) params.set("height", String(height));
  if (block_ads) params.set("no_ads", "1");
  if (block_cookie_banners) params.set("no_cookie_popup", "1");
  if (countryCode) {
    params.set("country", countryCode);
    // Fail loudly rather than returning a US screenshot the caller believes is local.
    if (strictCountry) params.set("strict_country", "1");
  }
  if (language) params.set("language", language);
  if (time_zone) params.set("time_zone", time_zone);
  if (geolocation) params.set("geolocation", geolocation);
  if (wait_ms != null) params.set("delay_time", String(wait_ms));

  // This string contains the key. It must never reach a result, a log or an
  // exception message — which is why nothing below ever interpolates an error.
  const endpoint = `${API_BASE}?${params.toString()}`;

  // One controller for the whole capture. The deadline stays armed through the
  // image or error body, not just the headers: a render that streams one byte
  // and stalls used to hold the request open forever.
  const controller = new AbortController();
  let abortCause = null; // "deadline" | "cancelled", whichever fires first.
  const abortWith = (cause) => {
    if (abortCause) return;
    abortCause = cause;
    controller.abort(abortError(cause));
  };

  const onCallerAbort = () => abortWith("cancelled");
  if (callerSignal) {
    if (callerSignal.aborted) abortWith("cancelled");
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => abortWith("deadline"), timeoutMs);

  /** Turn any thrown failure into a safe, distinguishable classification. */
  const classifyFailure = () => {
    if (abortCause === "deadline") {
      return captureError(
        CAPTURE_ERROR_CODES.deadlineExceeded,
        `Site-Shot could not capture the screenshot (${CAPTURE_ERROR_CODES.deadlineExceeded}): the capture ` +
          `did not complete within ${Math.round(timeoutMs / 1000)}s. The render may still have been started.`,
      );
    }
    if (abortCause === "cancelled") {
      return captureError(
        CAPTURE_ERROR_CODES.clientCancelled,
        `Site-Shot capture cancelled (${CAPTURE_ERROR_CODES.clientCancelled}): the caller disconnected or ` +
          `cancelled before the capture finished. The render may still have been started.`,
      );
    }
    return captureError(
      CAPTURE_ERROR_CODES.upstreamUnreachable,
      `Site-Shot could not capture the screenshot (${CAPTURE_ERROR_CODES.upstreamUnreachable}): the Site-Shot ` +
        `API could not be reached.`,
    );
  };

  try {
    let res;
    try {
      res = await fetchImpl(endpoint, { signal: controller.signal });
    } catch {
      // Deliberately not String(err): a fetch failure message routinely quotes
      // the request URL, and the request URL carries `userkey`.
      return classifyFailure();
    }

    const contentType = (res.headers?.get?.("content-type") || "").toLowerCase();

    // Success path: the API returns the image bytes directly.
    if (res.ok && contentType.startsWith("image/")) {
      const mimeType = contentType.split(";")[0].trim();
      if (!SERVED_IMAGE_TYPES.includes(mimeType)) {
        // The subtype is not repeated back: it is upstream-controlled text, and
        // this is exactly the path where it would be copied into a result.
        return captureError(
          CAPTURE_ERROR_CODES.unsupportedImageType,
          `Site-Shot could not return the screenshot (${CAPTURE_ERROR_CODES.unsupportedImageType}): the API ` +
            `answered with an image type this server does not serve. Only PNG, JPEG and WebP are returned — ` +
            `request format: "png", "jpeg" or "webp".`,
        );
      }
      let read;
      try {
        read = await readBoundedBody(res, { limit: maxImageBytes, signal: controller.signal, mode: "reject" });
      } catch {
        if (abortCause) return classifyFailure();
        // An interrupted image read is a failure, never a shorter screenshot.
        return captureError(
          CAPTURE_ERROR_CODES.responseUnreadable,
          `Site-Shot could not capture the screenshot (${CAPTURE_ERROR_CODES.responseUnreadable}): the image ` +
            `response ended before it was complete.`,
        );
      }
      if (read.overLimit) {
        return captureError(
          CAPTURE_ERROR_CODES.responseTooLarge,
          `Site-Shot could not return the screenshot (${CAPTURE_ERROR_CODES.responseTooLarge}): the image is ` +
            `larger than this server's ${maxImageBytes}-byte limit. Capture a smaller region — lower ` +
            `max_height, or use jpeg instead of png.`,
          { limitBytes: maxImageBytes },
        );
      }
      return { content: [{ type: "image", data: read.bytes.toString("base64"), mimeType }] };
    }

    // Error path. The body is read only to recognise the one marker we have a
    // safe meaning for; none of it is ever returned or logged.
    const status = typeof res.status === "number" ? res.status : 0;
    let countryUnavailable = false;
    try {
      const read = await readBoundedBody(res, {
        limit: maxErrorBodyBytes,
        signal: controller.signal,
        mode: "truncate",
      });
      countryUnavailable = /country_unavailable/i.test(read.bytes.toString("utf8"));
    } catch {
      if (abortCause) return classifyFailure();
      return captureError(
        CAPTURE_ERROR_CODES.responseUnreadable,
        `Site-Shot could not capture the screenshot (${CAPTURE_ERROR_CODES.responseUnreadable}): the API ` +
          `returned HTTP ${status} and the response could not be read.`,
        { httpStatus: status },
      );
    }

    // Gated on countryCode, not on the body alone: without it an unrelated error carrying
    // this marker would interpolate `undefined` into text an agent reads back to a user.
    if (countryCode && countryUnavailable) {
      let text =
        `Site-Shot could not capture the screenshot (${CAPTURE_ERROR_CODES.countryUnavailable}): no proxy is ` +
        `available for country "${countryCode}". Pick another country ` +
        `(https://www.site-shot.com/countries)`;
      // Suggesting the opt-out to a caller who already passed it would just be noise.
      text += strictCountry
        ? `, or pass strict_country: false to render through a US proxy instead.`
        : `.`;
      return captureError(CAPTURE_ERROR_CODES.countryUnavailable, text, { httpStatus: status });
    }

    return captureError(
      CAPTURE_ERROR_CODES.upstreamError,
      `Site-Shot could not capture the screenshot (${CAPTURE_ERROR_CODES.upstreamError}): the API returned ` +
        `HTTP ${status}.`,
      { httpStatus: status },
    );
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

// Shared input schema (zod raw shape) for both tools.
const baseInputShape = {
  url: z
    .string()
    .min(1)
    .describe("The URL of the web page to capture. A bare domain like example.com is accepted (https:// is assumed)."),
  // No pixel default is named in these two descriptions on purpose. width and height are sent
  // only when the caller passes them, so the value that applies when they don't is the API's to
  // change without an npm release — while this string is read by agents as fact. Through 1.1.0
  // it named a size the API does not use, so an agent that omitted width to take "the default"
  // silently got a different viewport, with nothing in the returned image to show it.
  width: z
    .number()
    .int()
    .min(100)
    .max(8000)
    .optional()
    .describe(
      "Viewport width in pixels. If omitted, the Site-Shot API's own default applies — pass a " +
        "value whenever the exact size matters.",
    ),
  height: z
    .number()
    .int()
    .min(100)
    .max(20000)
    .optional()
    .describe(
      "Viewport height in pixels. If omitted, the Site-Shot API's own default applies — pass a " +
        "value whenever the exact size matters.",
    ),
  format: z.enum(["png", "jpeg", "webp"]).optional().describe(
    "Image format. Default: png. png and webp are lossless; webp is typically about 35% smaller than png. " +
      "jpeg is lossy and smallest on photo-heavy pages. WebP cannot exceed 16,383 px on a side: " +
      "a taller full-page capture comes back cut at 16,383 px from the top.",
  ),
  block_ads: z.boolean().optional().describe("Remove ads for a cleaner screenshot. Default: true."),
  block_cookie_banners: z
    .boolean()
    .optional()
    .describe("Remove cookie-consent banners/popups. Default: true."),
  country: z
    .string()
    .optional()
    .describe(
      'Render through a proxy in this country, given as a two-letter ISO 3166-1 alpha-2 code — ' +
        '"DE" for Germany, "FR" for France, "JP" for Japan. Full country names are not accepted. ' +
        'Auto-sets IP, language, time zone and geolocation. Full list: https://www.site-shot.com/countries',
    ),
  strict_country: z
    .boolean()
    .optional()
    .describe(
      "Error out when the requested country has no proxy available, instead of silently " +
        "falling back to a US proxy. Only applies when country is set. Default: true.",
    ),
  language: z.string().optional().describe('Override browser language, e.g. "de".'),
  time_zone: z.string().optional().describe('Override time zone, e.g. "Europe/Berlin".'),
  geolocation: z.string().optional().describe('Override geolocation as "lat,lng".'),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(30000)
    .optional()
    // Same rule as width/height: the API's delay is its own to change, so no number here. The
    // second sentence still earns its place — omitting this is not a zero-wait capture, and an
    // agent that assumes it is will pass a needlessly large value to "add" a wait it already has.
    .describe(
      "Milliseconds to wait after load before capturing (for SPAs/animations). If omitted, the " +
        "Site-Shot API applies its own delay — leaving this out is not a zero-wait capture.",
    ),
  max_height: z
    .number()
    .int()
    .min(100)
    .max(20000)
    .optional()
    .describe("Cap the captured height in pixels (max 20000)."),
};

/**
 * Build the Site-Shot MCP server.
 *
 * The key is always passed in, never read from the environment here. Resolving
 * `SITESHOT_API_KEY` is the stdio entrypoint's job: on the remote path the key
 * belongs to one request, and a factory that could quietly fall back to a
 * process-wide key would be one missing header away from capturing on the wrong
 * account.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiKey] Site-Shot API key for every call this server serves.
 * @param {function} [opts.fetchImpl] fetch implementation (defaults to global fetch) — injectable for tests.
 * @param {object} [opts.capture] Per-call capture limits: { timeoutMs, maxImageBytes, maxErrorBodyBytes }.
 */
export function createServer(opts = {}) {
  const { apiKey, capture = {} } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  const server = new McpServer({
    name: "site-shot",
    version: PACKAGE_VERSION,
  });

  server.registerTool(
    "capture_screenshot",
    {
      title: "Capture website screenshot",
      description:
        "Take a screenshot of a web page with Site-Shot and return it as an image. Renders in a real " +
        "Chromium browser. Supports viewport/device sizing, full-page capture, country proxies, and " +
        "automatic ad & cookie-banner removal (cleaner image, fewer vision tokens).",
      inputSchema: {
        ...baseInputShape,
        full_page: z
          .boolean()
          .optional()
          .describe("Capture the entire scrollable page instead of just the viewport. Default: false."),
      },
    },
    // `extra.signal` is the SDK's per-request cancellation. Passing it through is
    // what lets a caller hanging up actually stop the render fetch mid-body.
    (args, extra) => captureScreenshot(args, { apiKey, fetchImpl, signal: extra?.signal, ...capture }),
  );

  server.registerTool(
    "capture_full_page",
    {
      title: "Capture full-page website screenshot",
      description:
        "Take a full-page (entire scrollable height) screenshot of a web page with Site-Shot and return " +
        "it as an image. Convenience wrapper around capture_screenshot with full-page capture enabled.",
      inputSchema: baseInputShape,
    },
    (args, extra) =>
      captureScreenshot({ ...args, full_page: true }, { apiKey, fetchImpl, signal: extra?.signal, ...capture }),
  );

  return server;
}
