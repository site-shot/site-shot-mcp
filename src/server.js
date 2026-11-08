import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CLIENT_MAX_SIDE, TILE_MAX_HEIGHT, imageSize, tilePng } from "./image-tiles.js";

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

/**
 * Map friendly tool params to Site-Shot API query params and capture a screenshot.
 * Returns an MCP tool result ({ content, isError? }).
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

/**
 * The MCP content for one captured image. A tall PNG goes back as tiles a client can read at full
 * resolution; any other image the client may have to downscale goes back whole, with a note
 * saying so, instead of silently arriving as unreadable text.
 */
function imageContent(buf, mimeType) {
  const whole = [{ type: "image", data: buf.toString("base64"), mimeType }];
  const size = imageSize(buf);
  if (!size || (size.height <= TILE_MAX_HEIGHT && size.width <= CLIENT_MAX_SIDE)) return whole;
  const dims = `${size.width} x ${size.height} px`;
  const wide =
    size.width > CLIENT_MAX_SIDE
      ? ` It is wider than ${CLIENT_MAX_SIDE} px, so clients may still scale it down; a smaller width keeps text sharper.`
      : "";
  const tiles = mimeType === "image/png" && size.height > TILE_MAX_HEIGHT ? tilePng(buf) : null;
  if (tiles) {
    const content = [
      {
        type: "text",
        text:
          `This capture is ${dims}, taller than AI clients show at full resolution, so it comes back ` +
          `as ${tiles.length} tiles, top to bottom, each at most ${TILE_MAX_HEIGHT} px tall; ` +
          `neighbouring tiles overlap by a few rows. It is still one capture.${wide}`,
      },
    ];
    tiles.forEach((t, i) => {
      content.push({ type: "text", text: `Tile ${i + 1} of ${tiles.length}: rows ${t.y}-${t.y + t.height} of ${size.height}.` });
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
        (size.height > TILE_MAX_HEIGHT
          ? ` For a readable full page, capture with format "png", which comes back in tiles, or cap the height with max_height.`
          : wide),
    },
    ...whole,
  ];
}

// A key that is still a placeholder means the MCP client copied its config text through instead
// of substituting it. Codex, for one, passes "${SITESHOT_API_KEY}" in an env table literally
// (measured with Codex 0.147.0); the API would refuse it as a bad key and the agent would be told
// only "Invalid authentication credentials".
const PLACEHOLDER_KEY = /^\$\{[^}]*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$|^%[A-Za-z_][A-Za-z0-9_]*%$|^<[^>]*>$|^YOUR[_ -]?(?:SITE[_ -]?SHOT[_ -]?)?API[_ -]?KEY$/i;

/** The agent-facing explanation for a placeholder key, or null when the key is not one. */
export function placeholderKeyMessage(apiKey) {
  const key = String(apiKey ?? "").trim();
  if (!PLACEHOLDER_KEY.test(key)) return null;
  return (
    `The Site-Shot API key this server received is the placeholder text "${key}", not a key: ` +
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

export async function captureScreenshot(args, { apiKey, fetchImpl }) {
  const placeholder = placeholderKeyMessage(apiKey);
  if (placeholder) return { isError: true, content: [{ type: "text", text: placeholder }] };
  if (!apiKey) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            "Missing Site-Shot API key. Set the SITESHOT_API_KEY environment variable " +
            "(get a key at https://www.site-shot.com/start/).",
        },
      ],
    };
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
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Invalid URL: "${rawUrl}". Pass a web page URL such as https://example.com (a bare domain like example.com also works).`,
        },
      ],
    };
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
      const shown = typeof rawCountry === "string" ? `"${rawCountry}"` : `a ${typeof country} value`;
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Invalid country: ${shown}. Use a two-letter ISO 3166-1 alpha-2 code — ` +
              `"DE" for Germany, "FR" for France, "JP" for Japan. Full country names are not ` +
              `accepted. Full list: https://www.site-shot.com/countries`,
          },
        ],
      };
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

  const endpoint = `${API_BASE}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(endpoint, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const reason = err?.name === "AbortError" ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : String(err);
    return { isError: true, content: [{ type: "text", text: `Site-Shot request failed: ${reason}` }] };
  }
  clearTimeout(timer);

  const contentType = (res.headers?.get?.("content-type") || "").toLowerCase();

  // Success path: the API returns the image bytes directly.
  if (res.ok && contentType.startsWith("image/")) {
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeType = contentType.split(";")[0] || (format === "jpeg" ? "image/jpeg" : "image/png");
    return { content: imageContent(buf, mimeType) };
  }

  // Error path. The status is the one thing every failure carries, so it leads every message, and
  // each common one says what to do next. Text the API sent goes through word for word; an image
  // body is never decoded into text (a 48 KB error card once reached the agent as ~47,000
  // characters of PNG) but is attached as an image, because the card is the only carrier of the
  // reason: a DNS failure and a country with no proxy are both a 404 card in image mode.
  let apiText = "";
  let card = null;
  try {
    const body =
      typeof res.arrayBuffer === "function"
        ? Buffer.from(await res.arrayBuffer())
        : Buffer.from(await res.text(), "utf8");
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
        (card ? ` The attached error card names the reason.` : "") +
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
        ` Country "${countryCode}": the free plan allows only the default location or the US, so a ` +
        `free-plan key is refused here; other countries need a paid plan ` +
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

/**
 * Build the Site-Shot MCP server.
 * @param {object} [opts]
 * @param {string} [opts.apiKey] Site-Shot API key (defaults to process.env.SITESHOT_API_KEY).
 * @param {function} [opts.fetchImpl] fetch implementation (defaults to global fetch) — injectable for tests.
 */
export function createServer(opts = {}) {
  const apiKey = opts.apiKey ?? process.env.SITESHOT_API_KEY;
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
          .describe(
            "Capture the entire scrollable page instead of just the viewport. Default: false. A PNG " +
              "taller than 2000 px comes back as several image tiles, top to bottom (still one capture).",
          ),
      },
    },
    (args) => captureScreenshot(args, { apiKey, fetchImpl }),
  );

  server.registerTool(
    "capture_full_page",
    {
      title: "Capture full-page website screenshot",
      description:
        "Take a full-page (entire scrollable height) screenshot of a web page with Site-Shot and return " +
        "it as an image. Convenience wrapper around capture_screenshot with full-page capture enabled. " +
        "A PNG taller than 2000 px comes back as several image tiles, top to bottom, so text stays " +
        "readable (still one capture); a tall jpeg or webp comes back whole and clients may scale it down.",
      inputSchema: baseInputShape,
    },
    (args) => captureScreenshot({ ...args, full_page: true }, { apiKey, fetchImpl }),
  );

  return server;
}
