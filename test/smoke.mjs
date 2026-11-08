import assert from "node:assert/strict";
import { captureScreenshot, createServer, placeholderKeyMessage } from "../src/server.js";
import { decodePng, encodePng } from "./png-helpers.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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

// 19) A spent month reaches the agent word for word, with the status. It is a 403 from Kong in
// every mode, and its message may start with either "Free API trial used up" (what the API sent
// at launch) or "Free plan used up" (after the next server deploy); a client has to accept both.
// The renewal date and the pricing link are what the agent passes on, so nothing here may match on
// one prefix and rewrite or drop the other. (A free-plan country refusal is not text in image
// mode, which this server always uses; check 26 replays the shapes it really has.)
{
  const bodies = [
    "Free plan used up: 100 captures this month. It renews on 2026-12-01 (UTC). " +
      "For more, choose a paid plan: https://www.site-shot.com/pricing/",
    "Free API trial used up: 100 captures this month. It renews on 2026-12-01 (UTC). " +
      "For more, choose a paid plan: https://www.site-shot.com/pricing/",
  ];
  for (const message of bodies) {
    for (const [body, type] of [[JSON.stringify({ message }), "application/json"], [message, "text/plain"]]) {
      const fetchImpl = async () => fakeErrorResponse(403, body, type);
      const res = await captureScreenshot({ url: "https://example.com" }, { apiKey: "K", fetchImpl });
      assert.equal(res.isError, true, `403 is an error (${type})`);
      assert.ok(res.content[0].text.includes(message), `403 body surfaced verbatim (${type}): ${message}`);
      assert.match(res.content[0].text, /HTTP 403/, "the status is kept next to the text");
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
  // The bound is what matters, not its exact value: 1.2.1 sent 48,983 characters here.
  assert.ok(text.length < 1000, `short, readable error (got ${text.length} chars)`);
  assert.doesNotMatch(text, /PNG|IHDR|\u0000/, "no image bytes in agent-visible text");
  assert.match(text, /HTTP 404/);
  assert.match(text, /"AQ"/, "names the country");
  assert.match(text, /strict_country: false/, "offers the opt-out");
  // A DNS failure is a 404 card too, so a proxy shortage is offered as what the card may say.
  assert.match(text, /If the card says country_unavailable/, "the proxy hint is conditional on the card");
  assert.equal(res.content[1]?.type, "image", "the card itself is attached, so the agent can read its reason");
  assert.equal(Buffer.from(res.content[1].data, "base64").length, card.length);
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
  // The card is what Site-Shot reported, not a diagnosis: a host that does not resolve comes back
  // as a card reading "504 Gateway Timeout", and an agent told the card names the reason reports a
  // timeout for a mistyped domain and retries, spending another capture.
  assert.doesNotMatch(text, /names the reason/, "the card is not promised to name the reason");
  assert.match(text, /shows what Site-Shot reported/);
  assert.match(text, /"504 Gateway Timeout"/, "the misleading card text a DNS failure carries is named");
  assert.match(text, /check the URL's spelling before retrying/);
  passed++;
}

// 22) An empty 404 body keeps the status and says what a Site-Shot 404 means. An agent reads a
// bare "HTTP 404" as "page not found"; here it means the render failed.
{
  const fetchImpl = async () => fakeCardResponse(404, new Uint8Array(0));
  const res = await captureScreenshot({ url: "https://no-such-host.invalid" }, { apiKey: "K", fetchImpl });
  const text = res.content[0].text;
  assert.ok(text.startsWith("Site-Shot could not capture the screenshot: HTTP 404."), text);
  assert.match(text, /could not render the page \(it is not the page's own status\)/);
  assert.match(text, /counts toward the month/, "a retry is not free");
  assert.doesNotMatch(text, /card|country|undefined/i, "no card, no country: nothing about either");
  assert.equal(res.content.length, 1, "nothing to attach");
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
  // A value that may hold a real key pasted into a template is caught but never quoted back: the
  // message goes into the transcript and, at startup, the client's logs.
  for (const key of ["<a1b2c3d4-e5f6-7890>", "${a1b2c3d4-e5f6-7890}"]) {
    let fetched = false;
    const res = await captureScreenshot(
      { url: "https://example.com" },
      { apiKey: key, fetchImpl: async () => ((fetched = true), fakeImageResponse(PNG)) },
    );
    assert.equal(res.isError, true, `${key} is caught`);
    assert.equal(fetched, false);
    assert.ok(!res.content[0].text.includes("a1b2c3d4"), `${key}: the value is not echoed`);
    assert.match(res.content[0].text, /not shown here/);
    assert.ok(!placeholderKeyMessage(key).includes("a1b2c3d4"), "nor in the startup warning");
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

// 26) A free-plan country refusal in image mode, in the two shapes it has: the API's 403 with an
// error card and no Content-Type (Request.pm send_file), and the empty 404 measured on 2026-10-30.
// Neither carries text, so the server has to name the plan or the agent never learns it.
{
  const card = new Uint8Array(2048);
  card.set(PNG, 0);
  for (const [status, bytes] of [[403, card], [404, new Uint8Array(0)]]) {
    const fetchImpl = async () => fakeCardResponse(status, bytes);
    const res = await captureScreenshot({ url: "https://example.com", country: "DE" }, { apiKey: "K", fetchImpl });
    const text = res.content[0].text;
    assert.equal(res.isError, true);
    assert.match(text, new RegExp(`HTTP ${status}`));
    assert.match(text, /free plan allows only the default location or the US/, `${status}: names the free plan's bound`);
    assert.match(text, /https:\/\/www\.site-shot\.com\/pricing\//);
    assert.match(text, /strict_country: false does not lift that/, `${status}: the opt-out is not offered as a fix`);
    assert.doesNotMatch(text, /pass strict_country: false/, `${status}: no retry advice that would be refused again`);
  }
  // US is inside the free plan, so it gets no free-plan explanation.
  const res = await captureScreenshot(
    { url: "https://example.com", country: "us" },
    { apiKey: "K", fetchImpl: async () => fakeCardResponse(403, card) },
  );
  assert.doesNotMatch(res.content[0].text, /free plan allows/);
  passed++;
}

// 27) 401 and 429 keep their status and say what to do; neither is mistaken for another error.
{
  const bad = await captureScreenshot(
    { url: "https://example.com" },
    { apiKey: "K", fetchImpl: async () => fakeErrorResponse(401, JSON.stringify({ message: "Invalid authentication credentials" })) },
  );
  const t401 = bad.content[0].text;
  assert.match(t401, /HTTP 401/);
  assert.match(t401, /Invalid authentication credentials/, "Kong's text is kept");
  assert.match(t401, /SITESHOT_API_KEY/);
  assert.match(t401, /\/plugin configure site-shot@site-shot/);
  assert.match(t401, /https:\/\/www\.site-shot\.com\/start\//);

  const busy = await captureScreenshot(
    { url: "https://example.com" },
    { apiKey: "K", fetchImpl: async () => fakeErrorResponse(429, JSON.stringify({ message: "API rate limit exceeded" })) },
  );
  assert.match(busy.content[0].text, /HTTP 429/);
  assert.match(busy.content[0].text, /one at a time/);
  assert.match(busy.content[0].text, /does not count toward the month/);
  passed++;
}

// 28) The deadline still guards the body once the headers are in. An error card comes chunked;
// before this, a body that stalled after the headers held the call open with no deadline at all.
{
  const card = new Uint8Array(64);
  card.set(PNG, 0);
  const stalled = (status, contentType) => async () => ({
    ok: status === 200,
    status,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: () => new Promise(() => {}),
  });
  for (const [status, type] of [[200, "image/png"], [404, null]]) {
    let late;
    const res = await Promise.race([
      captureScreenshot({ url: "https://example.com" }, { apiKey: "K", fetchImpl: stalled(status, type), timeoutMs: 50 }),
      new Promise((resolve) => (late = setTimeout(() => resolve("still waiting"), 2000))),
    ]);
    clearTimeout(late);
    assert.notEqual(res, "still waiting", `HTTP ${status}: the stalled body read ends at the deadline`);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /timed out/);
    assert.match(res.content[0].text, /count toward the month/, "says the capture may still count");
  }

  // A network error can quote the request URL, and the URL carries the key.
  const res = await captureScreenshot(
    { url: "https://example.com" },
    { apiKey: "SECRET-KEY-123", fetchImpl: async (url) => { throw new TypeError(`fetch failed for ${url}`); } },
  );
  assert.equal(res.isError, true);
  assert.doesNotMatch(res.content[0].text, /SECRET-KEY-123/, "the key never reaches the tool result");
  passed++;
}

// 29) A client that cancels the call (notifications/cancelled) stops the upstream request too.
{
  let upstream;
  const fetchImpl = (url, { signal }) => {
    upstream = signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ apiKey: "K", fetchImpl });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const ac = new AbortController();
  const call = client
    .callTool({ name: "capture_full_page", arguments: { url: "https://example.com" } }, undefined, { signal: ac.signal })
    .catch((e) => e);
  for (let i = 0; i < 50 && !upstream; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(upstream, "the capture reached fetch");
  ac.abort("user pressed stop");
  await call;
  for (let i = 0; i < 50 && !upstream.aborted; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(upstream.aborted, true, "the upstream request was aborted with the call");
  await client.close();
  passed++;
}

// 30) An argument the tool does not take is refused before any capture, with the name to use.
// The schema used to strip unknown keys, so the Site-Shot API's own names (delay_time, full_size,
// no_ads), which agents carry over from the API docs, ran a capture without what was asked for.
{
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    return fakeImageResponse(PNG);
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ apiKey: "K", fetchImpl });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  for (const name of ["capture_screenshot", "capture_full_page"]) {
    const res = await client.callTool({
      name,
      arguments: { url: "example.com", delay_time: 5000, full_size: 1, no_ads: 0, made_up: true },
    });
    assert.equal(res.isError, true, `${name}: unknown arguments are an error`);
    const text = res.content[0].text;
    assert.match(text, /delay_time \(use wait_ms\)/);
    assert.match(text, /no_ads \(use block_ads/);
    assert.match(text, /made_up/);
    assert.match(text, /nothing was sent to Site-Shot/);
    // Each tool names its own arguments: capture_full_page has no full_page to suggest.
    const known = /Its arguments are ([^.]*)\./.exec(text)?.[1];
    if (name === "capture_screenshot") {
      assert.match(text, /full_size \(use full_page/);
      assert.match(known, /\bfull_page\b/);
    } else {
      assert.match(text, /full_size \(not needed: this tool always captures the full page\)/);
      assert.doesNotMatch(known, /\bfull_page\b/, "capture_full_page does not offer full_page");
    }
  }
  // The served schema is what clients and models read before calling: it has to say that extra
  // keys are not taken (it said additionalProperties: true while the handler refused them).
  const { tools } = await client.listTools();
  for (const t of tools) assert.equal(t.inputSchema.additionalProperties, false, `${t.name}: no extra keys advertised`);
  assert.equal(fetched, false, "no capture was spent");
  const ok = await client.callTool({ name: "capture_screenshot", arguments: { url: "example.com", wait_ms: 500 } });
  assert.equal(ok.isError, undefined, "known arguments still capture");
  assert.equal(fetched, true);
  await client.close();
  passed++;
}

// 31) Tiles stop before the result outgrows what a client takes from one tool call, and the note
// names the rows left out. Claude Code 2.1.283 flagged ten 1280 x 2000 tiles as "[OUTPUT TRUNCATED
// - exceeded 25000 token limit]" although nothing was cut. Labels give inclusive row ranges, and a
// PNG that cannot be cut is not told to switch to png.
{
  const W = 1600;
  const H = 8000;
  const page = encodePng(W, H, (x, y) => [y & 0xff, x & 0xff, 7, 255]);
  let calls = 0;
  const res = await captureScreenshot(
    { url: "https://example.com", full_page: true },
    { apiKey: "K", fetchImpl: async () => (calls++, fakeImageResponse(new Uint8Array(page))) },
  );
  assert.equal(calls, 1);
  const images = res.content.filter((c) => c.type === "image");
  let pixels = 0;
  for (const img of images) {
    const t = decodePng(Buffer.from(img.data, "base64"));
    pixels += t.width * t.height;
  }
  assert.ok(pixels / 750 <= 20000, `tiles stay near 18k tokens (estimated ${Math.round(pixels / 750)})`);
  const labels = res.content.filter((c) => c.type === "text").slice(1).map((c) => c.text);
  assert.equal(labels[0], `Tile 1 of ${images.length}: rows 0-1999 of ${H}.`, "inclusive row range");
  const end = Number(/rows \d+-(\d+)/.exec(labels[labels.length - 1])[1]) + 1;
  assert.ok(end < H, "this page is too tall for the budget at 1600 px");
  assert.ok(res.content[0].text.includes(`Rows ${end}-${H - 1} at the bottom are not included`), "names the rows left out");
  // The stop is this server's own budget. At 1600 x 8000 a fifth tile would make about 21,300
  // tokens, still under 25,000, so "would take this result past 25,000 tokens" was false here.
  assert.match(res.content[0].text, /this server adds only whole 2000 px tiles and keeps them within about 18,000 tokens to stay under the 25,000 tokens/);
  assert.doesNotMatch(res.content[0].text, /would take this result past/);
  assert.match(res.content[0].text, /counts toward the month/);

  // An interlaced PNG goes back whole; the advice is not "use png".
  const interlaced = Buffer.from(encodePng(4, 2500, () => [1, 2, 3, 255]));
  interlaced[28] = 1; // IHDR interlace method
  const whole = await captureScreenshot(
    { url: "https://example.com", full_page: true },
    { apiKey: "K", fetchImpl: async () => fakeImageResponse(new Uint8Array(interlaced)) },
  );
  assert.deepEqual(whole.content.map((c) => c.type), ["text", "image"]);
  assert.doesNotMatch(whole.content[0].text, /format "png"/);
  assert.match(whole.content[0].text, /could not be cut into tiles/);
  passed++;
}

// 32) A capture that outlasts the client's request timeout still arrives when the client resets
// that timeout on progress: the server reports progress while the upstream request runs. The MCP
// SDK client waits 60 s by default and a heavy render can take longer.
{
  const fetchImpl = async () => {
    await new Promise((r) => setTimeout(r, 400));
    return fakeImageResponse(PNG);
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ apiKey: "K", fetchImpl, progressIntervalMs: 50 });
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const seen = [];
  for (const name of ["capture_screenshot", "capture_full_page"]) {
    const res = await client.callTool({ name, arguments: { url: "example.com" } }, undefined, {
      timeout: 200,
      resetTimeoutOnProgress: true,
      onprogress: (p) => seen.push(p),
    });
    assert.equal(res.content[0].type, "image", `${name}: the capture arrives after the 200 ms timeout`);
  }
  assert.ok(seen.length >= 4, `progress was reported while capturing (got ${seen.length})`);
  assert.match(seen[0].message, /Still capturing/);
  // Without a progressToken the call completes as before.
  const plain = await client.callTool({ name: "capture_screenshot", arguments: { url: "example.com" } });
  assert.equal(plain.content[0].type, "image");
  await client.close();
  passed++;
}

// 33) A body that breaks off mid-download (a connection reset, not the deadline or a cancel) is
// reported with its own error. It was swallowed, so a 200 image response reached the agent as
// "Site-Shot could not capture the screenshot: HTTP 200." with no reason at all.
{
  const cutOff = (message) => async () => ({
    ok: true,
    status: 200,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? "image/png" : null) },
    arrayBuffer: async () => {
      throw new TypeError(message);
    },
  });
  const res = await captureScreenshot({ url: "https://example.com" }, { apiKey: "K", fetchImpl: cutOff("terminated") });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.ok(text.startsWith("Site-Shot request failed: the response (HTTP 200) was cut off while downloading"), text);
  assert.match(text, /TypeError: terminated/, "the read error reaches the agent");
  assert.match(text, /another capture that counts toward the month/, "a retry is not free");
  assert.doesNotMatch(text, /could not capture the screenshot: HTTP 200\./);
  assert.equal(res.content.length, 1);
  // The read error can quote the request URL, which holds the key.
  const keyed = await captureScreenshot(
    { url: "https://example.com" },
    { apiKey: "SECRET-KEY-123", fetchImpl: cutOff("terminated reading https://api.site-shot.com/?userkey=SECRET-KEY-123") },
  );
  assert.doesNotMatch(keyed.content[0].text, /SECRET-KEY-123/, "the key never reaches the tool result");
  assert.match(keyed.content[0].text, /userkey=\*\*\*/);
  // A refusal that broke off keeps its own guidance: a 401 is the key, and it is not counted.
  const refused = await captureScreenshot(
    { url: "https://example.com" },
    {
      apiKey: "K",
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        headers: { get: () => null },
        arrayBuffer: async () => {
          throw new TypeError("terminated");
        },
      }),
    },
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /did not accept the API key \(HTTP 401\)/);
  assert.doesNotMatch(refused.content[0].text, /cut off while downloading|counts toward the month/);
  passed++;
}

// 34) A page wider than one tile's share of the budget still gets one tile, and the note says so
// in the singular and names the width bound: it read "comes back as 1 tiles" and blamed a 25,000
// token limit, while the tool description promised a stop at about 18,000 tokens.
{
  const W = 6800;
  const H = 2100;
  const page = encodePng(W, H, (x, y) => [y & 0xff, x & 0xff, 7, 255]);
  const res = await captureScreenshot(
    { url: "https://example.com", full_page: true },
    { apiKey: "K", fetchImpl: async () => fakeImageResponse(new Uint8Array(page)) },
  );
  assert.equal(res.content.filter((c) => c.type === "image").length, 1, "one tile at this width");
  const note = res.content[0].text;
  assert.match(note, /comes back as 1 tile, at most 2000 px tall\./);
  assert.doesNotMatch(note, /\b1 tiles\b|neighbouring tiles/);
  assert.match(note, /at more than 6,750 px wide it returns one tile/);
  assert.match(note, /Rows 2000-2099 at the bottom are not included/);
  passed++;
}

console.log(`ok — ${passed}/34 smoke checks passed`);
