# Changelog

## 1.2.2 — 2026-11-08

### Fixed

- A key that is still a placeholder (`${SITESHOT_API_KEY}`, `$SITESHOT_API_KEY`, `YOUR_API_KEY`)
  is caught before any request, at startup on stderr and in the tool result, with the fix: put the
  key itself in the server's setting or the client's environment; under Codex, replace an `env`
  table with `env_vars = ["SITESHOT_API_KEY"]`, because Codex passes `${...}` through literally
  (measured with Codex 0.147.0). Before, the API refused the text as a key and the agent saw only
  "Invalid authentication credentials". Only a variable name or `YOUR_API_KEY` is quoted back; a
  value in angle brackets, or a `${...}` around something that is not a name, may be a real key
  pasted into a template, so it is caught without being echoed into the transcript or the logs.
- A full-page capture is readable again. It came back as one image as tall as the page (1024 x
  10381 px for the Site-Shot homepage, up to 20,000 px by default); Claude refuses images over
  8000 px on a side and scales a long edge over about 2000 px down, so Claude Code showed that page
  at 197 x 2000 and the model could not read its text. A PNG taller than 2000 px now comes back
  as tiles, top to bottom, each at most 2000 px tall and overlapping by a few rows, cut from the
  one capture the API returned (no extra capture, no new dependency). A tall jpeg or webp, which
  the server cannot cut, comes back whole with a note that clients may scale it down. Tiles are
  full-resolution images (about 2,700 tokens per 1024 x 2000 tile), so they stop at about 18,000
  tokens, under the 25,000 Claude Code takes from one tool call: at 1024 px wide that is the top
  11,760 rows, and the note names the rows left out and how to see them (each way is another
  capture). Ten 1280 px tiles drew a false "[OUTPUT TRUNCATED - exceeded 25000 token limit]" in
  Claude Code 2.1.283. Tile labels give inclusive row ranges (0-1999).
- A failed capture no longer reaches the agent as image bytes. In image mode the API can answer a
  failure with an error-card PNG and no Content-Type — a `strict_country` request whose country
  has no proxy right now is HTTP 404 with a 48 KB card (measured 2026-11-05). The error path read
  that body as text, so the agent got about 47,000 characters of decoded PNG and no country hint;
  `strict_country` is on by default whenever `country` is set. Image bodies are now never decoded
  into text: the card goes back as an image next to the error text, because it is the only thing
  that names the reason (`proxy_navigation_failed` for a host that does not resolve,
  `country_unavailable` for a country with no proxy).
- Every failure states its HTTP status and what to do next. A 401 says the key was not accepted,
  where to set it (`SITESHOT_API_KEY`; in Claude Code `/plugin configure site-shot@site-shot`) and
  where the key is (https://www.site-shot.com/start/); 1.2.1 said only "Invalid authentication
  credentials". A 403 keeps the API's text word for word and, when there is none, says it is a plan
  problem. A 429 says the key runs too many captures at once and that the refusal does not count.
  A 404 says it is Site-Shot's capture-failed status, not the page's, and that a retry counts
  toward the month; an HTML error page from a proxy is no longer passed through.
- A free-plan country refusal is explained. In image mode it carries no text (a 403 card, or an
  empty 404), so 1.2.1 showed only the status, and its changelog's "reach the agent word for word"
  held only for JSON mode. With a country other than US, a 403 or 404 without text now says that
  the free plan allows only the default location or the US and that `strict_country: false` does
  not lift it. The `strict_country: false` advice for a 404 card is offered only for the case where
  the card says `country_unavailable`: a host that does not resolve is a 404 card too.

- The 90-second deadline now covers the whole exchange. It was cleared as soon as the response
  headers arrived, so a body that stalled afterwards (error cards come chunked) was read with no
  deadline. A client's cancellation (`notifications/cancelled`) now aborts the upstream request
  instead of leaving it running. The timeout message says the capture may still finish on
  Site-Shot's side and count toward the month, and a network error no longer echoes text that
  could quote the request URL with the key in it. When a call carries a `progressToken`, the
  server sends a progress notification every 15 s while the capture runs, so an MCP SDK client
  that resets its timeout on progress (its default timeout is 60 s) keeps waiting for a slow
  render. The 90-second deadline is unchanged.

- An argument a tool does not take is refused before any capture, with the name to use:
  `delay_time` -> `wait_ms`, `full_size` -> `full_page`, `no_ads` -> `block_ads`,
  `no_cookie_popup` -> `block_cookie_banners`. The schema used to drop unknown keys silently, so a
  call with the Site-Shot API's own names ran, and counted, as a capture without the wait or the
  full page that was asked for. The served schemas keep `additionalProperties: false`, so clients
  and models still read that extra keys are not taken, and each tool lists its own arguments.

### Changed

- The tool description, the README and the MCPB listing no longer promise "fewer vision tokens"
  from ad and banner removal. Vision models are billed by image size, and the website already
  says removal does not by itself lower that cost; the claim now reads "cleaner image for the model
  to read". The MCPB listing also says "public web pages" instead of "any web page".

- The `website-screenshots` skill (Claude Code and Codex plugins) no longer says a capture is "a
  fresh, signed-out browser" that "sees what a first-time visitor sees": ads and cookie banners are
  removed by default, and a capture may reuse cookies that earlier captures saved. It now says so,
  and says to pass `block_ads` / `block_cookie_banners` `false` when the question is about ads or
  consent. It no longer offers to "archive" a page: the image is not saved anywhere, and the skill
  says to tell the person that. A new "When a capture fails" section maps 401, a placeholder key,
  403, 429 and a 404 error card to the person's next step. The setup paragraph covers installs
  without the Claude Code plugin (Codex, Tessl, hand-written configs) and links the setup steps.
- The Claude Code key prompt links https://www.site-shot.com/start/ instead of the dashboard, which
  sends a signed-out newcomer to the login page.
- Codex plugin: the starter prompt "Show me how this page renders from Germany." is replaced by
  "Show me example.com at a 390 px mobile width." (the free plan refuses Germany and still counts
  the capture), and every prompt names its URL. The listing gains the Site-Shot logo and the
  privacy policy and terms URLs.

- README: a three-step quick start comes first (key at https://www.site-shot.com/start/, the
  client snippet, a first prompt). The Claude Code install block now ends with
  `/plugin configure site-shot@site-shot`, and the README states the observed behaviour instead of
  a hedge: a command-line install does not ask for the key, and until it is set Claude Code lists
  no server and offers no tools. Stale "works only once published" caveats are gone (both
  marketplaces install from GitHub). New "Updating" steps for Claude Code and Codex, and a
  persistent key option for Codex next to the one-shot prompt. The dashboard link is replaced by
  /start/. Checkout testing and release steps moved to DEVELOPMENT.md.

### Added

- `plugins/site-shot-tessl/`: the Tessl Registry plugin (the shared `website-screenshots` skill plus
  the pinned `site-shot-mcp` server), moved into this repo from a hand copy kept elsewhere.
  `npm run sync:tessl` regenerates its skill, license, version and pin from this repo, and
  `npm run test:plugin` fails when they drift. Tessl does not support `env_vars`, so the server
  entry keeps `"SITESHOT_API_KEY": "${SITESHOT_API_KEY}"`: Claude Code expands it, Codex does not;
  the listing description says what to change for Codex, and the server now names the placeholder
  when it arrives unexpanded. Not published; `"private": true` until the owner publishes it.

### Tests

- Smoke checks 20–22 replay the measured shapes: a 404 card with no Content-Type (with and
  without a country) and an empty 404 body. Check 20 fails on 1.2.1 with a 48,983-character
  message. Check 19 no longer fakes the geo refusal as a text 403, a shape image mode never sends;
  check 26 replays the two real ones, and check 27 covers 401 and 429. Checks 23-25 cover tiles
  and placeholder keys; check 28 a body that stalls after the headers, check 29 a cancelled call
  over a real MCP session, check 30 arguments the tools do not take (and that the served schemas
  still say `additionalProperties: false`), check 31 the tile budget and its note, check 32
  progress notifications that outlast a 200 ms client timeout.

## 1.2.1 — 2026-10-31

Documentation and metadata only — no request the server makes has changed, and no tool,
parameter or default has. What changed is what the key prompts and the tool schema tell a person
or an agent about the key.

### Changed

- The API key comes with the free plan. Since 2026-10-30 a confirmed Site-Shot account's API key
  includes 100 API captures a month, no card needed, renewed every month; paid plans start at
  $5/mo for 2,000. 1.2.0 said the key takes a paid plan. The README, the skill, the Claude Code key
  prompt, the Codex listing, the Claude Code marketplace entry, and the MCPB and MCP Registry key
  descriptions now name the free plan instead. The README also says that accounts confirmed
  before 2026-10-30 switch the free plan on with one button on https://www.site-shot.com/start/,
  and that an account that has had a paid plan before does not get it.
- The `country` description states the free plan's location bound: on the free plan only the
  default location (no country) or `"US"` works, and Site-Shot refuses any other country with an
  error instead of an image; the refused request still counts toward the month's captures. An
  agent reads that before it calls, not after it has spent a capture.
- The missing-key error and the startup warning point at https://www.site-shot.com/start/, which
  shows a signed-in user's key already filled in, instead of /pricing/, which sells plans and shows
  no key.

### Tests

- `test/plugin-metadata.test.mjs` requires the key prompts, the Codex listing and the skill to name
  the free plan (100 captures a month, confirmed account, no card) with its location bound, and
  checks the README and every listing for the old name and for words that would promise more than
  the free plan gives.
- `test/integration.mjs` asserts the served `country` description states the free plan's location
  bound, that a refused request still counts, and that it names no status code for the refusal.
- Smoke check 19 pins that the API's refusals for a spent free plan and for geotargeting reach the
  agent word for word. For a spent month the API may use either wording, "Free API trial used up"
  (what it sends today) or "Free plan used up"; both are checked.

## 1.2.0 — 2026-09-24

### Added

- `format` accepts `"webp"`: lossless, about 35% smaller than png on the median page; limited to 16,383 px per side.

## 1.1.3

### Fixed

- The server told every client the wrong version of itself. `serverInfo.version`
  was a literal in `src/server.js` that a release had to remember to update
  separately, and 1.1.2 went to npm while the handshake kept answering `1.1.1`.
  That is the version a client reports and a directory reviewer reads, so the
  package misrepresented itself everywhere it was installed. The version is now
  read from `package.json`, so there is no second place to update, and a test
  asserts over a real MCP session that the handshake, the MCPB manifest and the
  MCP Registry entry all state the package's own version.

No request the server makes, no tool, no schema and no default has changed.

## 1.1.2

Documentation only — no behavior change.

### Added

- README: "Why call this server instead of the agent's own browser?" — when an
  agent should delegate the capture and when it should drive its own browser,
  linking the full comparison
  (https://www.site-shot.com/blog/ai-agent-vs-screenshot-api/).

## 1.1.1

Documentation only — no request the server makes has changed. What changed is
what the tool schema tells an agent, which is the part agents act on.

### Fixed

- The `width` and `height` descriptions advertised a default viewport of
  1280x1024, and the package never sent either value: both are forwarded only
  when the caller passes them, so the API's own default applied instead. An
  agent that omitted `width` to take the advertised default got a different
  viewport, with nothing in the returned image to show it. 1280x1024 was never
  an API default — it is the free browser tool's form prefill. Checked against
  the API in August 2026, the real default is 1024x768.
- Neither description names a pixel size now. The number belongs to the API and
  can change without a release here, so restating it only sets up the next
  silent drift; they say the API's default applies and to pass a value when the
  size matters. The README table said 1280 / 1024 too, and now says the same.
- `wait_ms` now states that omitting it is not a zero-wait capture, so an agent
  doesn't add a delay the API already applies. It still names no number, which
  is what kept it correct: the public docs page states a delay default the
  renderer contradicts.
- The `capture_full_page` description in `manifest.json` promised captures "up
  to 20,000 px tall". 20,000 is the height cap this package requests, not a
  height the API guarantees, and it is wrong outright whenever the caller passes
  a smaller `max_height`. It now reads as the cap it is.

### Tests

- `test/integration.mjs` asserts the served schema's `width`, `height` and
  `wait_ms` descriptions contain no digits at all, so any future attempt to
  restate an upstream default fails CI. Verified against 1.1.0, where it fails
  on `width`.
- Smoke check 18 pins that omitting `width` / `height` / `wait_ms` sends no
  corresponding query parameter — the behaviour the descriptions now promise. It
  passes against 1.1.0 as well; it is a regression guard, not a differential
  test.

## 1.1.0

Minor, not patch: two changes turn calls that previously returned an image into
errors. The images were wrong — captured through a US proxy while the caller
believed otherwise — but callers pinning no version will see the change.

### Changed

- `country` now takes a two-letter ISO 3166-1 alpha-2 code and nothing else.
  The API matches codes exactly, so `"Germany"` was never recognised — it
  silently rendered through a US proxy, which is invisible in the returned
  image. Values that aren't two letters are now rejected before the request,
  with an error naming the right code. Lower case is accepted and normalised
  (`"de"` becomes `"DE"`).
- `strict_country` defaults to `true`, so a country with no proxy available
  fails with `country_unavailable` instead of quietly falling back to a US
  proxy. Pass `strict_country: false` to restore the old behaviour.

### Fixed

- The README and the `country` tool description used `"Germany"` as their
  example, which is exactly the value the API does not accept.

### Migration

Replace country names with codes: `country: "Germany"` becomes
`country: "DE"`. The full list is at <https://www.site-shot.com/countries>.
If you would rather have an image from the wrong country than an error, add
`strict_country: false`.

## 1.0.1

- Accept bare domains in `url`, so `example.com` works without a scheme.

## 1.0.0

- Initial release: `capture_screenshot` and `capture_full_page` over the
  Site-Shot API, with ad and cookie-banner removal on by default.
