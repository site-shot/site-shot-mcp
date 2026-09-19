---
name: website-screenshots
description: Capture a website screenshot as visual evidence with Site-Shot, including how a public page renders from a specific country. Use when asked to show, check, compare or archive what a page looks like, or how it differs by region.
---

# Website screenshots with Site-Shot

Site-Shot renders a public URL in a real Chromium browser on Site-Shot's own infrastructure and
returns the image. Reach for it when someone needs to *see* a page: a layout check, a before/after
comparison, a record of what a page showed on a given day, or how the same URL renders from another
country.

## Before the first capture

Site-Shot requires a paid API plan; captures use that account's existing API allowance and limits.
The key reaches the server as `SITESHOT_API_KEY`, and how it gets there is the host's business, not
this skill's. In Claude Code it is a required plugin setting the person fills in themselves with
`/plugin configure site-shot@site-shot`. Under Codex it is forwarded from the environment of the
session Codex was started in, which the README explains how to set up.

So there is never a reason to ask anyone for the key in conversation, to read it out of a file, or
to go hunting for one. If the setup is incomplete — the capture tools are not available, or a call
comes back saying the key is missing — stop and say which host-side step is still outstanding,
naming the right one for the host you are running in. Do not sign anyone up or buy anything on
their behalf.

## Capturing

Two tools, both returning the image straight back:

- `capture_screenshot` — the viewport by default; pass `full_page: true` for the whole scrollable
  page.
- `capture_full_page` — the same thing with full-page capture already on.

Be explicit about anything that changes what the image shows:

- `width` / `height` — pass them whenever the size matters (a mobile-width check, a layout that
  reflows). Omit them and the API's own default applies, which is not a number this skill can state.
- `country` — a two-letter ISO 3166-1 alpha-2 code (`"DE"`, not `"Germany"`). It routes the render
  through a proxy in that country and matches language, time zone and geolocation, which is what
  makes the image usable as geo evidence. `strict_country` is on by default, so a country with no
  proxy errors instead of quietly handing back a US screenshot.
- `wait_ms` — for pages that finish rendering late.

Then read the returned image and answer from what it actually shows, not from what the page is
supposed to contain.

## What it can and cannot see

The capture runs in a fresh, signed-out browser on Site-Shot's side. It sees what a first-time
visitor sees.

It cannot reach anything that depends on the person's own session — an authenticated dashboard, a
logged-in account area, `localhost`, a staging host behind a VPN or a corporate network. The remote
browser has none of their cookies and no access to the browser on their machine. For those pages,
drive their browser instead, or ask them for the screenshot. Never present a Site-Shot capture as
their signed-in view.

## Scope

Capture what was asked for. A comparison is part of the ask: "US versus Germany", "mobile versus
desktop" of the same URL, before and after a change — each variant needs its own capture, and
taking fewer leaves the question half-answered. Take the minimum the comparison requires, and stop
there.

What is not part of the ask: sweeping a site nobody pointed you at, standing repeat captures up on
a schedule, or looping on a failure. When a capture errors, report the error and let the person
decide what happens next. A re-capture earns its place when something changed or a parameter was
wrong — never as an unsolicited second roll of the dice on the same request.

## Choosing between this and a browser

When the page needs the person's own session, or they are already mid-flow in a browser on it,
that browser is the right tool.

A browser that happens to be open is not a substitute when the request is geo-specific or wants an
independent render. It shows the page from this machine's IP, locale and time zone, carrying
whatever cookies, extensions and signed-in state that profile has. `country` exists to control
exactly those, and a signed-out capture is what makes "this is what a visitor sees" checkable.
Pick whichever answers the question that was asked.
