import assert from "node:assert/strict";
import { captureScreenshot, createServer } from "../src/server.js";
import { decodePng, encodePng } from "./png-helpers.mjs";

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

// The production shape of an image-mode failure: no Content-Type, an error-card PNG body.
function fakeCardResponse(status, bytes) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    // A real Response has both; the 1.2.1 error path read text() and so decoded the card.
    text: async () => Buffer.from(bytes).toString("utf8"),
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

// 19) The free plan's refusals reach the agent word for word. A spent month is a 403 from Kong in
// every mode, and its message may start with either "Free API trial used up" (what the API sends
// today) or "Free plan used up" (what it will send after the next server deploy); a client has to
// accept both. A country refused on the free plan is a 403 here because this server asks for the
// image, not response_type=json; its text after "Geotargeting needs a paid plan" will change. The
// renewal date and the pricing link are what the agent passes on, so nothing here may match on one
// prefix and rewrite or drop the other.
{
  const bodies = [
    "Free plan used up: 100 captures this month. It renews on 2026-12-01 (UTC). " +
      "For more, choose a paid plan: https://www.site-shot.com/pricing/",
    "Free API trial used up: 100 captures this month. It renews on 2026-12-01 (UTC). " +
      "For more, choose a paid plan: https://www.site-shot.com/pricing/",
    "Geotargeting needs a paid plan: https://www.site-shot.com/pricing/",
  ];
  for (const message of bodies) {
    for (const [body, type] of [[JSON.stringify({ error: message }), "application/json"], [message, "text/plain"]]) {
      const fetchImpl = async () => fakeErrorResponse(403, body, type);
      const res = await captureScreenshot({ url: "https://example.com" }, { apiKey: "K", fetchImpl });
      assert.equal(res.isError, true, `403 is an error (${type})`);
      assert.ok(res.content[0].text.includes(message), `403 body surfaced verbatim (${type}): ${message}`);
    }
  }
  passed++;
}

// 20) A strict_country miss in image mode — HTTP 404, no Content-Type, a PNG error card —
// must reach the agent as a sentence, not as the card's bytes decoded into text.
{
  const card = new Uint8Array(48939);
  card.set(PNG, 0);
  const fetchImpl = async () => fakeCardResponse(404, card);
  const res = await captureScreenshot({ url: "https://example.com", country: "AQ" }, { apiKey: "K", fetchImpl });
  const text = res.content[0].text;
  assert.equal(res.isError, true);
  assert.ok(text.length < 600, `short, readable error (got ${text.length} chars)`);
  assert.doesNotMatch(text, /PNG|IHDR|\u0000/, "no image bytes in agent-visible text");
  assert.match(text, /HTTP 404/);
  assert.match(text, /"AQ"/, "names the country");
  assert.match(text, /strict_country: false/, "offers the opt-out");
  passed++;
}

// 21) The same card without a country carries no country advice and no "undefined".
{
  const card = new Uint8Array(64);
  card.set(PNG, 0);
  const fetchImpl = async () => fakeCardResponse(404, card);
  const res = await captureScreenshot({ url: "https://example.com" }, { apiKey: "K", fetchImpl });
  const text = res.content[0].text;
  assert.match(text, /HTTP 404 \(the API answered with an error image/);
  assert.doesNotMatch(text, /country|undefined/i);
  passed++;
}

// 22) An empty 404 body (an unresolvable host, measured) keeps the bare status.
{
  const fetchImpl = async () => fakeCardResponse(404, new Uint8Array(0));
  const res = await captureScreenshot({ url: "https://no-such-host.invalid" }, { apiKey: "K", fetchImpl });
  assert.equal(res.content[0].text, "Site-Shot could not capture the screenshot: HTTP 404");
  passed++;
}

// 23) A full page taller than clients show at full resolution comes back as PNG tiles, each at most
// 2000 px tall, top to bottom, that together hold every row of the one capture pixel for pixel.
// Measured 2026-11-08: the Site-Shot homepage is 1024 x 10381; as one image Claude Code showed it
// at 197 x 2000 and the model could not read its text.
{
  const W = 9;
  const H = 4321;
  const pixel = (x, y) => [(x * 37 + y) & 0xff, (y * 13) & 0xff, (x ^ y) & 0xff, 255 - (y & 0x7f)];
  const page = encodePng(W, H, pixel);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return fakeImageResponse(new Uint8Array(page));
  };
  const res = await captureScreenshot({ url: "https://example.com", full_page: true }, { apiKey: "K", fetchImpl });
  assert.equal(res.isError, undefined);
  assert.equal(calls, 1, "one capture, however many tiles");
  const images = res.content.filter((c) => c.type === "image");
  assert.ok(images.length >= 3, `a ${H} px page needs at least three 2000 px tiles (got ${images.length})`);
  assert.equal(res.content[0].type, "text", "a note says the image comes in tiles");
  assert.match(res.content[0].text, new RegExp(`${W} x ${H} px`));
  assert.match(res.content[0].text, new RegExp(`${images.length} tiles`));
  let covered = 0;
  for (const [i, img] of images.entries()) {
    assert.equal(img.mimeType, "image/png");
    const tile = decodePng(Buffer.from(img.data, "base64"));
    assert.equal(tile.width, W, "tiles keep the full width");
    assert.ok(tile.height <= 2000, `tile ${i + 1} is at most 2000 px tall (got ${tile.height})`);
    const label = res.content[res.content.indexOf(img) - 1].text;
    const top = Number(/rows (\d+)-/.exec(label)?.[1]);
    assert.ok(top <= covered, `tile ${i + 1} starts at or above the last row already covered`);
    for (let y = 0; y < tile.height; y++) {
      const want = Buffer.alloc(W * 4);
      for (let x = 0; x < W; x++) Buffer.from(pixel(x, top + y)).copy(want, x * 4);
      if (!tile.rows[y].equals(want)) assert.fail(`tile ${i + 1} row ${y} differs from page row ${top + y}`);
    }
    covered = top + tile.height;
  }
  assert.equal(covered, H, "the last tile ends on the page's last row");
  passed++;
}

// 24) An image that fits stays one image with no note, and a tall image the server cannot cut
// (here a JPEG) goes back whole with a note that it may be scaled down.
{
  const small = encodePng(4, 2000, () => [1, 2, 3, 255]);
  let res = await captureScreenshot({ url: "https://example.com" }, { apiKey: "K", fetchImpl: async () => fakeImageResponse(new Uint8Array(small)) });
  assert.deepEqual(res.content.map((c) => c.type), ["image"], "a 2000 px image is not cut");

  // SOI, then a baseline SOF0 frame header for a 1024 x 9000 image.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x23, 0x28, 0x04, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
  res = await captureScreenshot(
    { url: "https://example.com", full_page: true, format: "jpeg" },
    { apiKey: "K", fetchImpl: async () => fakeImageResponse(jpeg, "image/jpeg") },
  );
  assert.deepEqual(res.content.map((c) => c.type), ["text", "image"]);
  assert.match(res.content[0].text, /1024 x 9000 px/);
  assert.match(res.content[0].text, /format "png"/, "names the format that comes back readable");
  assert.equal(res.content[1].mimeType, "image/jpeg");
  passed++;
}

// 25) A key that is still a placeholder is caught before any capture, with the fix spelled out.
// Codex hands "${SITESHOT_API_KEY}" from an env table to the server literally (measured, Codex
// 0.147.0, as a Tessl install writes it); before this the agent saw only "Invalid authentication
// credentials" and a capture attempt went to the API.
{
  for (const key of ["${SITESHOT_API_KEY}", "${user_config.SITESHOT_API_KEY}", "$SITESHOT_API_KEY", "YOUR_API_KEY"]) {
    let fetched = false;
    const fetchImpl = async () => {
      fetched = true;
      return fakeErrorResponse(401, JSON.stringify({ message: "Invalid authentication credentials" }));
    };
    const res = await captureScreenshot({ url: "https://example.com" }, { apiKey: key, fetchImpl });
    assert.equal(res.isError, true, `${key} is not a key`);
    assert.equal(fetched, false, `${key}: no request is sent with a placeholder key`);
    const text = res.content[0].text;
    assert.ok(text.includes(`"${key}"`), "names what the server received");
    assert.match(text, /did not substitute/);
    assert.ok(text.includes('env_vars = ["SITESHOT_API_KEY"]'), "gives the Codex fix");
    assert.match(text, /https:\/\/www\.site-shot\.com\/start\//);
  }
  // A real key that merely contains a dollar sign or braces is still sent.
  let fetched = 0;
  const fetchImpl = async () => {
    fetched++;
    return fakeImageResponse(PNG);
  };
  for (const key of ["abc$def", "a1b2c3d4-e5f6"]) {
    await captureScreenshot({ url: "https://example.com" }, { apiKey: key, fetchImpl });
  }
  assert.equal(fetched, 2, "keys that are not placeholders reach the API");
  passed++;
}

console.log(`ok — ${passed}/25 smoke checks passed`);
