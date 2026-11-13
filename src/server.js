import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CLIENT_MAX_SIDE, TILE_MAX_HEIGHT, TILE_PIXEL_BUDGET, imageSize, tilePng } from "./image-tiles.js";

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
// Decoded size past which the remote worker does not cut a PNG into tiles (1600 x 20000 RGBA).
const BOUNDED_TILE_RAW_BYTES = 128 * 1024 * 1024;

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
// The leading bytes of the image formats the API sends. A failed image-mode request can
// answer with a PNG error card and no Content-Type at all (measured 2026-11-05: a
// strict_country miss is HTTP 404 with a 48 KB PNG), so the header alone cannot tell an
// agent-readable error from bytes that would arrive as tens of kilobytes of noise.
function looksLikeImage(buf, contentType) {
  if (contentType.startsWith("image/")) return true;
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  return buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP";
}

// Past this width one full-height tile alone is over the tile budget, and the server still returns
// that one tile (6,750 px at a 2000 px tile and 13.5M px), so the budget is stated with this bound.
const WIDEST_IN_BUDGET = Math.floor(TILE_PIXEL_BUDGET / TILE_MAX_HEIGHT);

/**
 * The MCP content for one captured image. A tall PNG goes back as tiles a client can read at full
 * resolution; any other image the client may have to downscale goes back whole, with a note
 * saying so, instead of silently arriving as unreadable text.
 */
function imageContent(buf, mimeType, tileOptions) {
  const whole = [{ type: "image", data: buf.toString("base64"), mimeType }];
  const size = imageSize(buf);
  if (!size || (size.height <= TILE_MAX_HEIGHT && size.width <= CLIENT_MAX_SIDE)) return whole;
  const dims = `${size.width} x ${size.height} px`;
  const wide =
    size.width > CLIENT_MAX_SIDE
      ? ` It is wider than ${CLIENT_MAX_SIDE} px, so clients may still scale it down; a smaller width keeps text sharper.`
      : "";
  let tiles = mimeType === "image/png" && size.height > TILE_MAX_HEIGHT ? tilePng(buf, tileOptions) : null;
  // Tiles repeat rows: neighbours overlap, and the last tile is aligned to the bottom, so a page
  // just over one tile tall comes back as almost two. Together they can outweigh the image they
  // were cut from. Where the reply has a byte budget sized for one image, tiles past that size
  // would turn a capture that fits into a refusal, so the image goes back whole instead.
  if (
    tiles &&
    tileOptions?.maxTotalBytes != null &&
    tiles.reduce((sum, t) => sum + t.data.length, 0) > tileOptions.maxTotalBytes
  ) {
    tiles = null;
  }
  if (tiles) {
    const end = tiles[tiles.length - 1].y + tiles[tiles.length - 1].height;
    // The reason given is the server's own stop, not the client's limit: a page just past the budget
    // would still fit under 25,000 tokens with one more tile.
    const left =
      end < size.height
        ? ` Rows ${end}-${size.height - 1} at the bottom are not included: this server adds only whole ` +
          `${TILE_MAX_HEIGHT} px tiles and keeps them within about 18,000 tokens` +
          (size.width > WIDEST_IN_BUDGET
            ? `, and at more than ${WIDEST_IN_BUDGET.toLocaleString("en-US")} px wide it returns one tile, `
            : " ") +
          `to stay under the 25,000 tokens Claude Code accepts from one tool call. Each further capture ` +
          `counts toward the month: format "jpeg" returns the whole page as one image the client scales ` +
          `down (layout visible, small text not), a smaller width fits more of the page into the tiles, ` +
          `and max_height captures only the top.`
        : "";
    const shape =
      tiles.length === 1
        ? `as 1 tile, at most ${TILE_MAX_HEIGHT} px tall.`
        : `as ${tiles.length} tiles, top to bottom, each at most ${TILE_MAX_HEIGHT} px tall; ` +
          `neighbouring tiles overlap by a few rows.`;
    const content = [
      {
        type: "text",
        text:
          `This capture is ${dims}, taller than AI clients show at full resolution, so it comes back ` +
          `${shape} It is still one capture.${wide}${left}`,
      },
    ];
    tiles.forEach((t, i) => {
      content.push({ type: "text", text: `Tile ${i + 1} of ${tiles.length}: rows ${t.y}-${t.y + t.height - 1} of ${size.height}.` });
      content.push({ type: "image", data: t.data.toString("base64"), mimeType: "image/png" });
    });
    return content;
  }
  return [
    {
      type: "text",
      text:
        `This capture is ${dims}. AI clients scale an image this large down before the model sees it ` +
        `(Claude refuses anything over 8000 px on a side), so small text may be unreadable.` +
        (size.height <= TILE_MAX_HEIGHT
          ? wide
          : mimeType === "image/png"
            ? ` This PNG could not be cut into tiles; cap the height with max_height for sharper text.`
            : ` For a readable full page, capture with format "png", which comes back in tiles, or cap the height with max_height.`),
    },
    ...whole,
  ];
}

// A key that is still a placeholder means the MCP client copied its config text through instead
// of substituting it. Codex, for one, passes "${SITESHOT_API_KEY}" in an env table literally
// (measured with Codex 0.147.0); the API would refuse it as a bad key and the agent would be told
// only "Invalid authentication credentials".
const PLACEHOLDER_KEY = /^\$\{[^}]*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$|^%[A-Za-z_][A-Za-z0-9_]*%$|^<[^>]*>$|^YOUR[_ -]?(?:SITE[_ -]?SHOT[_ -]?)?API[_ -]?KEY$/i;

// Only these shapes are quoted back: a variable name cannot be a secret. Anything else that matched
// (text in angle brackets, a ${...} around something that is not a name) may be a real key pasted
// into a template, and the message lands in the transcript and the client's logs.
const QUOTABLE_PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_.]*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$|^%[A-Za-z_][A-Za-z0-9_]*%$|^YOUR[_ -]?(?:SITE[_ -]?SHOT[_ -]?)?API[_ -]?KEY$/i;

/** The agent-facing explanation for a placeholder key, or null when the key is not one. */
export function placeholderKeyMessage(apiKey) {
  const key = String(apiKey ?? "").trim();
  if (!PLACEHOLDER_KEY.test(key)) return null;
  const received = QUOTABLE_PLACEHOLDER.test(key)
    ? `the placeholder text "${key}"`
    : key.startsWith("<")
      ? "text in angle brackets (not shown here: it may hold the key)"
      : "a ${...} reference (not shown here: it may hold the key)";
  return (
    `The Site-Shot API key this server received is ${received}, not a key: ` +
    `the MCP client did not substitute it. Put the key itself in the server's SITESHOT_API_KEY ` +
    `setting, or set SITESHOT_API_KEY in the environment the client starts from. Codex does not ` +
    `expand \${...} in an env table: replace that table with env_vars = ["SITESHOT_API_KEY"] ` +
    `(https://github.com/site-shot/site-shot-mcp#codex-cli-plugin). In Claude Code with the ` +
    `site-shot plugin, run /plugin configure site-shot@site-shot. Your key is at ` +
    `https://www.site-shot.com/start/.`
  );
}

function imageMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return "image/png";
}

// The Site-Shot API's own parameter names, which agents carry over from the API docs and SDKs. The
// tool schema used to strip any key it did not know, so { delay_time: 5000 } ran, and counted, as a
// capture with no wait at all.
const API_PARAM_HINTS = {
  delay_time: "use wait_ms",
  full_size: "use full_page: true, or the capture_full_page tool",
  no_ads: "use block_ads, on by default",
  no_cookie_popup: "use block_cookie_banners, on by default",
  userkey: "the key comes from the server's SITESHOT_API_KEY setting, never from an argument",
  api_key: "the key comes from the server's SITESHOT_API_KEY setting, never from an argument",
  key: "the key comes from the server's SITESHOT_API_KEY setting, never from an argument",
  response_type: "this server always returns the image itself",
};
// capture_full_page always captures the whole page, so it neither takes full_page nor needs full_size.
const FULL_PAGE_TOOL_HINTS = {
  full_size: "not needed: this tool always captures the full page",
  full_page: "not needed: this tool always captures the full page",
};

/** The refusal for arguments a tool does not take, naming the right one where there is one. */
function unknownArgumentsText(unknown, known, hints = API_PARAM_HINTS) {
  const lines = unknown.map((k) => k + (hints[k] ? ` (${hints[k]})` : ""));
  return (
    `Not captured: this tool does not take ${lines.join(", ")}. Its arguments are ` +
    `${known.join(", ")}. Call it again with those; nothing was sent to Site-Shot.`
  );
}

// The served schema says additionalProperties: false, so a client or model that reads it knows
// extra keys are not taken; the error map turns zod's "Unrecognized key(s)" into the refusal above.
function toolInputSchema(shape, hints) {
  const known = Object.keys(shape);
  return z
    .object(shape, {
      errorMap: (issue, ctx) =>
        issue.code === "unrecognized_keys"
          ? { message: unknownArgumentsText(issue.keys, known, hints) }
          : { message: ctx.defaultError },
    })
    .strict();
}

function unknownArgumentsError(args) {
  const known = [...Object.keys(baseInputShape), "full_page"];
  const unknown = Object.keys(args ?? {}).filter((k) => !known.includes(k));
  if (unknown.length === 0) return null;
  return { isError: true, content: [{ type: "text", text: unknownArgumentsText(unknown, known) }] };
}

export async function captureScreenshot(args, opts) {
  const {
    apiKey,
    fetchImpl,
    signal,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxImageBytes,
    maxErrorBodyBytes = ERROR_BODY_LIMIT_BYTES,
  } = opts;
  const callerSignal = signal;
  // The remote worker passes byte ceilings; stdio passes none. With ceilings the response is read
  // under them and no upstream text or error image is ever returned (the transport's contract).
  // Without them the released stdio behaviour applies: the API's own words and its error card.
  const bounded = opts.bounded === true || opts.maxImageBytes != null || opts.maxErrorBodyBytes != null;

  const unknown = unknownArgumentsError(args);
  if (unknown) return unknown;
  const placeholder = placeholderKeyMessage(apiKey);
  if (placeholder) return { isError: true, content: [{ type: "text", text: placeholder }] };
  if (!apiKey) {
    return captureError(
      CAPTURE_ERROR_CODES.missingApiKey,
      "Missing Site-Shot API key. Set the SITESHOT_API_KEY environment variable " +
        "(get a key at https://www.site-shot.com/start/).",
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

  if (bounded) {
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
        // The worker shares one memory cap between two captures and the adapter, so it decodes less
        // than stdio will, and its reply budget is sized for one image of at most maxImageBytes, so
        // the tiles together may not weigh more than that. A PNG past either bound goes back whole,
        // with the note that says so.
        return {
          content: imageContent(read.bytes, mimeType, {
            maxRawBytes: BOUNDED_TILE_RAW_BYTES,
            maxTotalBytes: maxImageBytes,
          }),
        };
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

  // One deadline for the whole exchange, body included: fetch resolves as soon as the headers
  // arrive, and an error card comes chunked, so a deadline cleared at that point stopped guarding
  // the part that can stall. A client's notifications/cancelled aborts the same way, so a
  // cancelled call does not keep the upstream request running.
  const controller = new AbortController();
  let stopped = null;
  const stop = (why) => {
    if (stopped) return;
    stopped = why;
    controller.abort();
  };
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  const onCancel = () => stop("cancelled");
  if (signal?.aborted) onCancel();
  else signal?.addEventListener?.("abort", onCancel, { once: true });
  const aborted = new Promise((_, reject) => {
    const fail = () => reject(new Error("aborted"));
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => {});
  const guard = (promise) => Promise.race([promise, aborted]);

  let res;
  let body = null;
  let readError = null;
  try {
    res = await guard(fetchImpl(endpoint, { signal: controller.signal }));
    try {
      body = await guard(
        typeof res.arrayBuffer === "function"
          ? res.arrayBuffer().then((b) => Buffer.from(b))
          : res.text().then((t) => Buffer.from(t, "utf8")),
      );
    } catch (err) {
      if (stopped) throw err;
      readError = err;
    }
  } catch (err) {
    let reason;
    if (stopped === "cancelled") reason = "the client cancelled the call";
    else if (stopped === "timeout" || err?.name === "AbortError") {
      reason =
        `timed out after ${Math.round(timeoutMs / 1000)} s. The capture may still finish on Site-Shot's ` +
        `side and count toward the month; heavy pages can take longer, and trying again is another capture`;
    } else reason = String(err).split(apiKey).join("***"); // a fetch error may quote the URL, which holds the key
    return { isError: true, content: [{ type: "text", text: `Site-Shot request failed: ${reason}.` }] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onCancel);
  }

  // A body that broke off mid-download (a connection reset) leaves nothing to show, and its error is
  // the only reason there is: without it a 200 image response read as a bare "HTTP 200." failure.
  // Only for a 2xx: a 401, 429 or 404 that broke off still goes to its own branch below, which knows
  // what to do next (and that a refused key or a busy slot is not counted).
  if (readError && res.ok) {
    const reason = String(readError).split(apiKey).join("***");
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `Site-Shot request failed: the response (HTTP ${res.status}) was cut off while downloading ` +
            `(${reason}). Trying again is another capture that counts toward the month.`,
        },
      ],
    };
  }

  const contentType = (res.headers?.get?.("content-type") || "").toLowerCase();

  // Success path: the API returns the image bytes directly.
  if (res.ok && contentType.startsWith("image/") && body) {
    const mimeType = (contentType.split(";")[0] || (format === "jpeg" ? "image/jpeg" : "image/png")).trim();
    if (!SERVED_IMAGE_TYPES.includes(mimeType)) {
      // The subtype is upstream-controlled text, so it is not repeated back.
      return captureError(
        CAPTURE_ERROR_CODES.unsupportedImageType,
        `Site-Shot could not return the screenshot (${CAPTURE_ERROR_CODES.unsupportedImageType}): the API ` +
          `answered with an image type this server does not serve. Only PNG, JPEG and WebP are returned — ` +
          `request format: "png", "jpeg" or "webp".`,
      );
    }
    return { content: imageContent(body, mimeType) };
  }

  // Error path. The status is the one thing every failure carries, so it leads every message, and
  // each common one says what to do next. Text the API sent goes through word for word; an image
  // body is never decoded into text (a 48 KB error card once reached the agent as ~47,000
  // characters of PNG) but is attached as an image, because the card is all Site-Shot says about
  // the failure: a DNS failure and a country with no proxy are both a 404 card in image mode. The
  // card is what the API reported, not a diagnosis: a host that does not resolve can come back as a
  // card reading "504 Gateway Timeout", so the text never tells the agent the card has the reason.
  let apiText = "";
  let card = null;
  try {
    if (!body) throw new Error("no body");
    if (looksLikeImage(body, contentType)) {
      card = body;
    } else {
      const text = body.toString("utf8").trim();
      try {
        const json = JSON.parse(text);
        apiText = String(json.error || json.message || text);
      } catch {
        apiText = text;
      }
      // An HTML error page from a proxy in front of the API says nothing an agent can use.
      if (/^<(?:!doctype|html)/i.test(apiText)) apiText = "";
      if (apiText.length > 500) apiText = `${apiText.slice(0, 500)}...`;
    }
  } catch {
    /* status only */
  }
  const status = res.status;
  const said = apiText ? `: ${apiText}${/[.!?]$/.test(apiText) ? "" : "."}` : ".";
  const noReason = !apiText;
  let text;
  if (status === 401) {
    text =
      `Site-Shot did not accept the API key (HTTP 401)${said} Check the SITESHOT_API_KEY this ` +
      `server was given; in Claude Code with the site-shot plugin, enter it again with ` +
      `/plugin configure site-shot@site-shot. Your key is at https://www.site-shot.com/start/.`;
  } else if (status === 403) {
    text = `Site-Shot refused the capture (HTTP 403)${said}`;
    if (noReason) {
      text +=
        ` A 403 means a plan problem: no captures left this month, no active plan on this key, or a ` +
        `request the plan does not cover. The key and its plan are at https://www.site-shot.com/start/; ` +
        `plans at https://www.site-shot.com/pricing/.`;
    }
  } else if (status === 429) {
    text =
      `Site-Shot refused the capture (HTTP 429)${said} Too many captures at once on this key (the ` +
      `free plan runs one at a time): wait for the running capture to finish, then try again. A ` +
      `request refused with 429 does not count toward the month.`;
  } else {
    text = `Site-Shot could not capture the screenshot: HTTP ${status}`;
    if (card) text += " (the API answered with an error image, not a screenshot)";
    text += said;
    if (status === 404 && noReason) {
      text +=
        ` A 404 here means Site-Shot could not render the page (it is not the page's own status): the ` +
        `host may not resolve, or the page timed out or blocked the render.` +
        (card
          ? ` The attached error card shows what Site-Shot reported; for a host that does not resolve ` +
            `it can read "504 Gateway Timeout", so check the URL's spelling before retrying.`
          : "") +
        ` A retry is another capture that counts toward the month.`;
    } else if (status >= 500 && noReason) {
      text += ` That is a server-side error at Site-Shot; trying again in a minute usually works.`;
    }
  }

  // Gated on countryCode: without it an unrelated error carrying this marker would interpolate
  // `undefined` into text an agent reads back to a user.
  if (countryCode && /country_unavailable/i.test(apiText)) {
    text +=
      ` No proxy is available for country "${countryCode}". Pick another country ` +
      `(https://www.site-shot.com/countries)`;
    // Suggesting the opt-out to a caller who already passed it would just be noise.
    text += strictCountry ? `, or pass strict_country: false to render through a US proxy instead.` : `.`;
  } else if (countryCode && noReason && (status === 403 || status === 404)) {
    // In image mode a free-plan country refusal arrives with no text at all (a 403 card, or an
    // empty 404), so the plan has to be named here or the agent never learns it.
    if (countryCode !== "US") {
      text +=
        ` If this key is on the free plan, that alone explains it: the free plan allows only the ` +
        `default location or the US, "${countryCode}" needs a paid plan ` +
        `(https://www.site-shot.com/pricing/), and strict_country: false does not lift that.`;
    }
    // One possible cause, not the cause: a DNS failure is a 404 card too, so this is conditional
    // on what the card says, which the agent can read and this server cannot.
    if (strictCountry && card && status === 404) {
      text +=
        ` If the card says country_unavailable, no proxy is available for "${countryCode}" right ` +
        `now: pick another country, retry later, or pass strict_country: false to render through a ` +
        `US proxy.`;
    }
  }

  const content = [{ type: "text", text }];
  // Bounded so a misbehaving upstream cannot push megabytes into the agent's context as an "error".
  if (card && card.length <= 1024 * 1024) {
    content.push({ type: "image", data: card.toString("base64"), mimeType: imageMime(card) });
  }
  return { isError: true, content };
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
        'Auto-sets IP, language, time zone and geolocation. On the Site-Shot free plan only the ' +
        'default location (no country) or "US" works; other countries need a paid plan. Site-Shot ' +
        'refuses them with an error instead of an image, and the refused request still counts ' +
        'toward the month\'s captures. ' +
        'Full list: https://www.site-shot.com/countries',
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

// A capture can take longer than the 60 s an MCP SDK client waits by default. When the caller sent a
// progressToken, a progress notification every so often lets a client that resets its timeout on
// progress keep waiting; the deadline itself is unchanged.
const PROGRESS_INTERVAL_MS = 15_000;

function withProgress(extra, intervalMs, run) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || typeof extra.sendNotification !== "function") return run();
  let progress = 0;
  const timer = setInterval(() => {
    progress++;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, message: `Still capturing (${Math.round((progress * intervalMs) / 1000)} s)` },
      })
      .catch(() => {});
  }, intervalMs);
  return run().finally(() => clearInterval(timer));
}

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
 * @param {number} [opts.progressIntervalMs] how often a running capture reports progress — injectable for tests.
 */
export function createServer(opts = {}) {
  const { apiKey, capture = {} } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const progressIntervalMs = opts.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const remote = Object.keys(capture).length > 0;

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
        "automatic ad & cookie-banner removal (cleaner image for the model to read).",
      inputSchema: toolInputSchema({
        ...baseInputShape,
        full_page: z
          .boolean()
          .optional()
          .describe(
            "Capture the entire scrollable page instead of just the viewport. Default: false. A PNG " +
              "taller than 2000 px comes back as several image tiles, top to bottom (still one capture).",
          ),
      }),
    },
    // `extra.signal` is the SDK's per-request cancellation. Passing it through is
    // what lets a caller hanging up actually stop the render fetch mid-body.
    // Progress notifications are a stdio aid; the remote worker answers one JSON reply.
    (args, extra) => {
      const run = () => captureScreenshot(args, { apiKey, fetchImpl, signal: extra?.signal, ...capture });
      return remote ? run() : withProgress(extra, progressIntervalMs, run);
    },
  );

  server.registerTool(
    "capture_full_page",
    {
      title: "Capture full-page website screenshot",
      description:
        "Take a full-page (entire scrollable height) screenshot of a web page with Site-Shot and return " +
        "it as an image. Convenience wrapper around capture_screenshot with full-page capture enabled. " +
        "A PNG taller than 2000 px comes back as several image tiles, top to bottom, so text stays " +
        "readable (still one capture); a tall jpeg or webp comes back whole and clients may scale it down. " +
        "Tiles are full-resolution images, about 2,700 tokens per 1024 x 2000 tile, and stop at about " +
        "18,000 tokens (a page wider than 6,750 px gets one tile, which can be more); the note names " +
        "any rows left out at the bottom.",
      inputSchema: toolInputSchema(baseInputShape, { ...API_PARAM_HINTS, ...FULL_PAGE_TOOL_HINTS }),
    },
    (args, extra) => {
      const run = () =>
        captureScreenshot({ ...args, full_page: true }, { apiKey, fetchImpl, signal: extra?.signal, ...capture });
      return remote ? run() : withProgress(extra, progressIntervalMs, run);
    },
  );

  return server;
}
