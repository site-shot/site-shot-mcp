# Changelog

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
