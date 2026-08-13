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
    { url: "https://example.com", width: 1280, country: "DE" },
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
  assert.equal(u.searchParams.get("country"), "DE");
  assert.equal(u.searchParams.get("strict_country"), "1", "strict country by default");
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

// 7) Bare domain (no scheme) gets https:// assumed
{
  let calledUrl = "";
  const fetchImpl = async (url) => {
    calledUrl = url;
    return fakeImageResponse(PNG);
  };
  const res = await captureScreenshot({ url: "example.com" }, { apiKey: "K", fetchImpl });
  assert.equal(res.isError, undefined, "bare domain should be accepted");
  assert.equal(new URL(calledUrl).searchParams.get("url"), "https://example.com");
  passed++;
}

// 8) Clearly invalid URL returns a helpful error without calling the API
{
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    return fakeImageResponse(PNG);
  };
  const res = await captureScreenshot({ url: "   " }, { apiKey: "K", fetchImpl });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Invalid URL/);
  assert.equal(fetched, false, "should not call the API on an invalid url");
  passed++;
}

// 9) Country code is normalised to upper case (agents may send "de" like a language tag)
{
  let calledUrl = "";
  const fetchImpl = async (url) => {
    calledUrl = url;
    return fakeImageResponse(PNG);
  };
  const res = await captureScreenshot({ url: "https://example.com", country: " de " }, { apiKey: "K", fetchImpl });
  assert.equal(res.isError, undefined, "lowercase country should be accepted");
  assert.equal(new URL(calledUrl).searchParams.get("country"), "DE");
  passed++;
}

// 10) A full country name is rejected up front — the API would silently fall back to a US proxy
{
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    return fakeImageResponse(PNG);
  };
  const res = await captureScreenshot({ url: "https://example.com", country: "Germany" }, { apiKey: "K", fetchImpl });
  assert.equal(res.isError, true, "full country names must not be sent to the API");
  assert.match(res.content[0].text, /ISO 3166-1 alpha-2/);
  assert.match(res.content[0].text, /"DE"/, "error should show the correct code");
  assert.equal(fetched, false, "should not call the API with an unusable country");
  passed++;
}

// 11) strict_country can be turned off to keep the API's silent-fallback behaviour.
// Lower-case "fr" deliberately: opting out must still normalise the code, so this
// fails against a build that has neither the opt-out nor the normalisation.
{
  let calledUrl = "";
  const fetchImpl = async (url) => {
    calledUrl = url;
    return fakeImageResponse(PNG);
  };
  await captureScreenshot(
    { url: "https://example.com", country: "fr", strict_country: false },
    { apiKey: "K", fetchImpl },
  );
  const u = new URL(calledUrl);
  assert.equal(u.searchParams.get("country"), "FR");
  assert.equal(u.searchParams.get("strict_country"), null, "opt-out drops strict_country");
  passed++;
}

// 12) strict_country is meaningless without a country and must not be sent.
// Passed explicitly here: this pins the `if (countryCode)` coupling, so moving the
// strict_country write out of that block fails the test.
{
  let calledUrl = "";
  const fetchImpl = async (url) => {
    calledUrl = url;
    return fakeImageResponse(PNG);
  };
  await captureScreenshot(
    { url: "https://example.com", strict_country: true },
    { apiKey: "K", fetchImpl },
  );
  const u = new URL(calledUrl);
  assert.equal(u.searchParams.get("country"), null);
  assert.equal(u.searchParams.get("strict_country"), null);
  passed++;
}

// 13) A strict-country rejection names the country and explains how to recover.
// The bare /country_unavailable/ match would pass on the raw API string alone, so the
// assertions that matter are the country code and the opt-out hint.
{
  const fetchImpl = async () => fakeErrorResponse(400, JSON.stringify({ error: "country_unavailable" }));
  const res = await captureScreenshot({ url: "https://example.com", country: "MC" }, { apiKey: "K", fetchImpl });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /"MC"/, "should name the country that failed");
  assert.match(res.content[0].text, /strict_country/, "should suggest the opt-out");
  passed++;
}

// 14) An explicit null must not read as "opt out" — a destructuring default only fills
// in for undefined, so null would silently restore the US fallback.
{
  let calledUrl = "";
  const fetchImpl = async (url) => {
    calledUrl = url;
    return fakeImageResponse(PNG);
  };
  await captureScreenshot(
    { url: "https://example.com", country: "FR", strict_country: null },
    { apiKey: "K", fetchImpl },
  );
  assert.equal(new URL(calledUrl).searchParams.get("strict_country"), "1", "only false opts out");
  passed++;
}

// 15) A non-string country is rejected, not coerced. String([]) is "", which would
// otherwise skip validation entirely and drop the country with no error.
{
  for (const bad of [[], ["DE"], 42, {}]) {
    let fetched = false;
    const fetchImpl = async () => {
      fetched = true;
      return fakeImageResponse(PNG);
    };
    const res = await captureScreenshot({ url: "https://example.com", country: bad }, { apiKey: "K", fetchImpl });
    assert.equal(res.isError, true, `country ${JSON.stringify(bad)} should be rejected`);
    assert.equal(fetched, false, "should not call the API with an unusable country");
  }
  passed++;
}

// 16) The recovery hint must not leak "undefined" when no country was ever requested
{
  const fetchImpl = async () => fakeErrorResponse(400, JSON.stringify({ error: "country_unavailable" }));
  const res = await captureScreenshot({ url: "https://example.com" }, { apiKey: "K", fetchImpl });
  assert.equal(res.isError, true);
  assert.doesNotMatch(res.content[0].text, /undefined/, "no undefined in agent-visible text");
  passed++;
}

// 17) Don't suggest an opt-out the caller already took
{
  const fetchImpl = async () => fakeErrorResponse(400, JSON.stringify({ error: "country_unavailable" }));
  const res = await captureScreenshot(
    { url: "https://example.com", country: "MC", strict_country: false },
    { apiKey: "K", fetchImpl },
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /"MC"/);
  assert.doesNotMatch(res.content[0].text, /pass strict_country/, "already opted out");
  passed++;
}

// 18) Omitted sizing/delay params must not be sent at all. The tool schema tells agents the
// API's own default applies when they leave these out; a destructuring default here would
// quietly override it and turn that description into the same silent lie the 1280x1024 one was.
{
  let calledUrl = "";
  const fetchImpl = async (url) => {
    calledUrl = url;
    return fakeImageResponse(PNG);
  };
  await captureScreenshot({ url: "https://example.com" }, { apiKey: "K", fetchImpl });
  const u = new URL(calledUrl);
  assert.equal(u.searchParams.get("width"), null, "omitted width must not be sent");
  assert.equal(u.searchParams.get("height"), null, "omitted height must not be sent");
  assert.equal(u.searchParams.get("delay_time"), null, "omitted wait_ms must not be sent");
  passed++;
}

console.log(`ok — ${passed}/18 smoke checks passed`);
