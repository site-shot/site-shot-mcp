---
name: website-screenshots
description: Capture a website screenshot as visual evidence with Site-Shot, including how a public page renders from a specific country. Use when asked to show, check or compare what a page looks like, or how it differs by region.
---

# Website screenshots with Site-Shot

Site-Shot renders a public URL in a real Chromium browser on Site-Shot's own infrastructure and
returns the image. Reach for it when someone needs to *see* a page: a layout check, a before/after
comparison, or how the same URL renders from another country.

The image comes back into this conversation and nowhere else: Site-Shot does not save it as a file
or give a link to it. If someone wants to keep a copy, tell them that plainly rather than implying
it has been archived.

## Before the first capture

The API key needs either the free plan — 100 captures a month on a confirmed account, no card
needed — or a paid plan (from $5/mo for 2,000). Free-plan captures come from the default location or
the US; other countries need a paid plan, and a request for one is refused but still counts toward
the month. Once the free plan's 100 are spent, the API answers 403 until it renews. Captures use
that account's API allowance and limits.
The key reaches the server as `SITESHOT_API_KEY`, and how it gets there depends on how the server
was installed, not on this skill:

- With the Site-Shot plugin for Claude Code, it is a required plugin setting the person fills in
  themselves with `/plugin configure site-shot@site-shot`.
- Anywhere else (the Codex plugin, a Tessl install, a hand-written MCP config), it is the
  `SITESHOT_API_KEY` variable in the environment the agent was started from. Codex passes it on
  only when the server entry lists it as `env_vars = ["SITESHOT_API_KEY"]`; an `env` table holding
  the text `${SITESHOT_API_KEY}` reaches the server literally. Setup steps:
  https://github.com/site-shot/site-shot-mcp#codex-cli-plugin

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
- `block_ads` / `block_cookie_banners` — both on by default, so ads and cookie-consent banners are
  removed from the image. When the question is about ads, a consent banner or what a visitor has
  to click through, pass `false` for the one that matters.

A full page taller than 2000 px comes back as several image tiles, top to bottom, each labelled
with the rows it covers. Read them in order as one page; neighbouring tiles share a few rows.

Then read the returned image and answer from what it actually shows, not from what the page is
supposed to contain.

## What it can and cannot see

The capture runs in a signed-out browser on Site-Shot's side. It is not necessarily a first visit:
it may reuse cookies and local storage that earlier Site-Shot captures saved. And unless you turn it
off, ads and cookie banners are removed, so it is not exactly what a visitor's own browser shows.

It cannot reach anything that depends on the person's own session — an authenticated dashboard, a
logged-in account area, `localhost`, a staging host behind a VPN or a corporate network. The remote
browser has none of their cookies and no access to the browser on their machine. For those pages,
drive their browser instead, or ask them for the screenshot. Never present a Site-Shot capture as
their signed-in view.

## When a capture fails

The error text starts with the HTTP status. Report it, with the next step for the person:

- HTTP 401, "Invalid authentication credentials": the key is wrong. With the Claude Code plugin they
  enter it again with `/plugin configure site-shot@site-shot`; elsewhere they fix `SITESHOT_API_KEY`.
  Their key is at https://www.site-shot.com/start/.
- An error saying the key is a placeholder: the MCP client passed the text of its config instead of
  the key. The error says how to fix that for the host.
- HTTP 403: a plan problem — no captures left this month, no active plan, or a country the free plan
  does not cover. The key and plan are at https://www.site-shot.com/start/ (accounts confirmed before
  2026-10-30 switch the free plan on there), and plans at https://www.site-shot.com/pricing/.
- HTTP 429: a capture is already running on this key. Wait for it to finish.
- HTTP 404 with an error card attached: Site-Shot could not render the page. The card names the
  reason; read it before saying anything about the page itself.

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
exactly those, and an independent signed-out capture is what makes "this is what a signed-out
visitor sees" checkable.
Pick whichever answers the question that was asked.
