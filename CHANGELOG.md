# Changelog

## Unreleased

Not published. The stdio server and the released `site-shot-mcp@1.1.2` plugin
manifests are unchanged; nothing here advertises a remote endpoint, because there
isn't one.

### Fixed

- The 90-second capture deadline stopped guarding once the response *headers*
  arrived, so a render that sent one byte and then stalled held the request open
  indefinitely. The deadline now stays armed through the image or error body, and
  cleanup happens in `finally`.
- Failures echoed upstream text back to the caller: `String(err)` for a failed
  fetch, and the raw API error body otherwise. The request URL carries `userkey`,
  and fetch failure messages routinely quote the URL — so a network error could
  put a customer's API key into a tool result. Failures now report the observed
  HTTP status and a stable code (`upstream_error`, `deadline_exceeded`,
  `client_cancelled`, `upstream_unreachable`, `country_unavailable`,
  `response_too_large`, `response_unreadable`) and nothing the upstream wrote. The
  `country_unavailable` explanation is unchanged — it is built from the caller's
  own validated country code, not from body prose.
- A rejected `url` or `country` is no longer quoted back in the error message. A
  URL can carry userinfo credentials (`https://user:secret@host`), and an error
  message is copied into results, transcripts and logs far more freely than a
  request is. The messages still say what to send instead.
- A non-image response body is now read under a 64 KiB ceiling and the remainder
  cancelled, instead of being buffered whole to be classified.
- The upstream `Content-Type` was copied straight into the returned `mimeType`, so
  any `image/*` subtype the API sent became part of the MCP result — including
  `image/svg+xml`, which is active content no caller asked for, handed to whatever
  renders the result. Both tools offer png and jpeg, so those two types are now the
  only ones served; anything else is an `unsupported_image_type` error that does
  not repeat the subtype back. `image/jpg` is deliberately *not* accepted: it is a
  common alias, but nothing here has observed the API sending it, and an unverified
  alias is a guess.
- The MCP handshake reported version 1.1.1 while the package was 1.1.2. The
  handshake now reads the version from the manifest, so the two cannot drift again.

### Added

- `src/uds-worker.js`: a private, unreleased Unix-domain-socket transport for a
  future hosted Site-Shot MCP — same two tools, same capture code, no TCP port, no
  OAuth, no hosted endpoint. Fresh `McpServer` and stateless transport per POST;
  per-request key and subject supplied by the caller over the socket; every byte,
  concurrency and timeout bound must be configured explicitly. The whole HTTP
  response — status line, headers and body — is measured against the configured
  budget before a single byte is forwarded, so an over-budget result and an
  over-long protocol error are both refused rather than sent. See the README's
  "Private UDS worker" section, including what it does *not* do.
- `test/remote-transport.test.mjs`: offline acceptance over real Unix sockets with
  an injected `fetch` — isolation between two users sharing a JSON-RPC id, key
  rotation, disconnect and deadline during a streaming body, secret redaction
  across five failure shapes, exact byte boundaries, capacity, socket ownership
  and the memory profile of the configured budget.

### Changed

- `createServer()` no longer falls back to `process.env.SITESHOT_API_KEY`; the key
  is always passed in. `src/index.js` resolves the environment variable for stdio,
  and its startup behaviour is unchanged. This is what keeps a request-scoped key
  on the remote path from silently becoming a process-wide one.
- Tool handlers receive the SDK request extras and pass `extra.signal` into the
  capture, so a caller hanging up actually aborts the render fetch.
- The capture reads response bodies through the web `ReadableStream` contract.
  There is no buffer-it-all fallback: it would be a second, weaker path through
  the one function whose job is enforcing the first.
- Dependencies are pinned exactly (`@modelcontextprotocol/sdk` 1.29.0, `zod`
  3.25.76) and the lockfile root version now matches the package.

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
