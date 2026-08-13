# Changelog

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
