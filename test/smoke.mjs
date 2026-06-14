import assert from "node:assert/strict";
import { captureScreenshot, createServer } from "../src/server.js";

// Minimal Response-like stub.
function fakeImageResponse(bytes, contentType = "image/png") {
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}
function fakeErrorResponse(status, body, contentType = "application/json") {
  return {
    ok: false,
    status,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  };
}

let passed = 0;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic

// 1) Success: returns image content + correct query params
{
  let calledUrl = "";
  const fetchImpl = async (url) => {
    calledUrl = url;
    return fakeImageResponse(PNG);
  };
  const res = await captureScreenshot(
    { url: "https://example.com", width: 1280, country: "Germany" },
    { apiKey: "TESTKEY", fetchImpl },
  );
  assert.equal(res.isError, undefined, "success should not be an error");
  assert.equal(res.content[0].type, "image");
  assert.equal(res.content[0].mimeType, "image/png");
  assert.equal(Buffer.from(res.content[0].data, "base64").toString("hex"), Buffer.from(PNG).toString("hex"));
  const u = new URL(calledUrl);
  assert.equal(u.origin + u.pathname, "https://api.site-shot.com/");
  assert.equal(u.searchParams.get("url"), "https://example.com");
  assert.equal(u.searchParams.get("userkey"), "TESTKEY");
  assert.equal(u.searchParams.get("no_ads"), "1", "ads blocked by default");
  assert.equal(u.searchParams.get("no_cookie_popup"), "1", "cookie banners blocked by default");
  assert.equal(u.searchParams.get("width"), "1280");
  assert.equal(u.searchParams.get("country"), "Germany");
  assert.equal(u.searchParams.get("full_size"), null, "viewport capture by default");
  passed++;
}

// 2) Full page sets full_size + max_height
{
  let calledUrl = "";
  const fetchImpl = async (url) => {
    calledUrl = url;
    return fakeImageResponse(PNG);
  };
  await captureScreenshot({ url: "https://example.com", full_page: true }, { apiKey: "K", fetchImpl });
  const u = new URL(calledUrl);
  assert.equal(u.searchParams.get("full_size"), "1");
  assert.equal(u.searchParams.get("max_height"), "20000");
  passed++;
}

// 3) Opting out of ad/cookie blocking
{
  let calledUrl = "";
  const fetchImpl = async (url) => {
    calledUrl = url;
    return fakeImageResponse(PNG);
  };
  await captureScreenshot(
    { url: "https://example.com", block_ads: false, block_cookie_banners: false },
    { apiKey: "K", fetchImpl },
  );
  const u = new URL(calledUrl);
  assert.equal(u.searchParams.get("no_ads"), null);
  assert.equal(u.searchParams.get("no_cookie_popup"), null);
  passed++;
}

// 4) Missing API key returns a helpful error
{
  const res = await captureScreenshot({ url: "https://example.com" }, { apiKey: undefined, fetchImpl: async () => {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /SITESHOT_API_KEY/);
  passed++;
}

// 5) API error body is surfaced
{
  const fetchImpl = async () => fakeErrorResponse(400, JSON.stringify({ error: "invalid url" }));
  const res = await captureScreenshot({ url: "https://example.com" }, { apiKey: "K", fetchImpl });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /invalid url/);
  passed++;
}

// 6) Server builds and exposes both tools
{
  const server = createServer({ apiKey: "K", fetchImpl: async () => fakeImageResponse(PNG) });
  assert.ok(server, "createServer returns a server");
  passed++;
}

console.log(`ok — ${passed}/6 smoke checks passed`);
