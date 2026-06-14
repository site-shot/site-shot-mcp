import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const API_BASE = "https://api.site-shot.com/";
const REQUEST_TIMEOUT_MS = 90_000; // Site-Shot renders can take up to ~70s on heavy pages.

/**
 * Map friendly tool params to Site-Shot API query params and capture a screenshot.
 * Returns an MCP tool result ({ content, isError? }).
 */
export async function captureScreenshot(args, { apiKey, fetchImpl }) {
  if (!apiKey) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            "Missing Site-Shot API key. Set the SITESHOT_API_KEY environment variable " +
            "(get a key at https://www.site-shot.com/pricing/).",
        },
      ],
    };
  }

  const {
    url,
    full_page = false,
    width,
    height,
    format = "png",
    block_ads = true,
    block_cookie_banners = true,
    country,
    language,
    time_zone,
    geolocation,
    wait_ms,
    max_height,
  } = args;

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
  if (country) params.set("country", country);
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
    return {
      content: [{ type: "image", data: buf.toString("base64"), mimeType }],
    };
  }

  // Error path: surface whatever the API said (often a JSON or text error body).
  let detail = `HTTP ${res.status}`;
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = json.error || json.message || text || detail;
    } catch {
      detail = text || detail;
    }
  } catch {
    /* keep status-only detail */
  }
  return {
    isError: true,
    content: [{ type: "text", text: `Site-Shot could not capture the screenshot: ${detail}` }],
  };
}

// Shared input schema (zod raw shape) for both tools.
const baseInputShape = {
  url: z.string().url().describe("The URL of the web page to capture."),
  width: z.number().int().min(100).max(8000).optional().describe("Viewport width in pixels (default 1280)."),
  height: z.number().int().min(100).max(20000).optional().describe("Viewport height in pixels (default 1024)."),
  format: z.enum(["png", "jpeg"]).optional().describe("Image format. Default: png."),
  block_ads: z.boolean().optional().describe("Remove ads for a cleaner screenshot. Default: true."),
  block_cookie_banners: z
    .boolean()
    .optional()
    .describe("Remove cookie-consent banners/popups. Default: true."),
  country: z
    .string()
    .optional()
    .describe('Render through a proxy in this country, e.g. "Germany" (auto-sets IP, language, time zone, geolocation).'),
  language: z.string().optional().describe('Override browser language, e.g. "de".'),
  time_zone: z.string().optional().describe('Override time zone, e.g. "Europe/Berlin".'),
  geolocation: z.string().optional().describe('Override geolocation as "lat,lng".'),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(30000)
    .optional()
    .describe("Milliseconds to wait after load before capturing (for SPAs/animations)."),
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
    version: "1.0.0",
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
    (args) => captureScreenshot(args, { apiKey, fetchImpl }),
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
    (args) => captureScreenshot({ ...args, full_page: true }, { apiKey, fetchImpl }),
  );

  return server;
}
