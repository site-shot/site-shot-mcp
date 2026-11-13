# Site-Shot MCP server

Give Claude, Cursor, and other AI agents the ability to **see public web pages** — take website screenshots
with [Site-Shot](https://www.site-shot.com/) over the [Model Context Protocol](https://modelcontextprotocol.io).

Real Chromium rendering · full-page capture · country proxies · automatic **ad & cookie-banner removal**
(cleaner images for the model to read).

## Quick start

1. **Get an API key** at <https://www.site-shot.com/start/>. A confirmed account's key comes with the
   free plan: 100 API captures a month, no card needed.
2. **Add the server to your agent** — pick your client below:
   [Claude Code](#claude-code-plugin) · [Codex CLI](#codex-cli-plugin) ·
   [Claude Desktop, Cursor and other clients](#claude-desktop--other-mcp-clients).
3. **Ask:** *"Take a screenshot of example.com."* The agent calls the server and shows you the image.

### About the key

The free plan renews every month; once its 100 captures are spent, the API answers 403 until it
renews. Free-plan captures come from the default location or the US; other countries need a paid
plan, and a request for one is refused but still counts toward the month. Paid plans start at $5/mo
for 2,000 captures ([pricing](https://www.site-shot.com/pricing/)). Accounts confirmed before
2026-10-30 switch the free plan on with one button on <https://www.site-shot.com/start/>; an account
that has had a paid plan before does not get it. Captures draw on that account's API allowance and
limits. The no-signup browser tool at <https://www.site-shot.com/> is for checking output quality;
it does not issue keys.

## Claude Code (plugin)

This repository is a Claude Code plugin marketplace. The plugin runs the published `site-shot-mcp`
package over stdio and declares the API key as a required sensitive setting, which Claude Code
collects in a masked prompt rather than asking you to paste it into a config file or a chat message.

### Install

```bash
claude plugin marketplace add site-shot/site-shot-mcp
claude plugin install site-shot@site-shot
```

Then, in a Claude Code session, enter the key:

```
/plugin configure site-shot@site-shot
```

From inside a session the first two steps are `/plugin marketplace add site-shot/site-shot-mcp` and
`/plugin install site-shot@site-shot`.

### The API key

The plugin declares `SITESHOT_API_KEY` as a required, sensitive setting. `/plugin configure` asks
for it, masks it as you type, and Claude Code substitutes it into the server's environment as
`${user_config.SITESHOT_API_KEY}`. Storage of the value is Claude Code's to handle.

Installing from the command line does not ask for the key: the install prints
`1 userConfig option not yet set (1 required)` and names `/plugin configure`. Configure it before
expecting a capture. Until the key is set, Claude Code does not list the server (`claude mcp list`
shows no site-shot entry) and the capture tools do not appear (observed with Claude Code 2.1.283).
Run `/plugin configure site-shot@site-shot` again to replace a wrong key.

The server's own behaviour is separate. When run directly over stdio **without a key**, it still
starts and prints a warning on stderr, and the capture tools return a clear missing-key error
instead of an image.

The plugin adds one skill (`site-shot:website-screenshots`) and the two capture tools
[below](#tools). It declares no hooks, no monitors and no scheduled capture jobs; the only process
it launches is the declared stdio MCP server.

### Updating

The plugin pins an exact `site-shot-mcp` release (now `site-shot-mcp@1.2.3`), so a new server
version reaches you through a plugin update:

```bash
claude plugin marketplace update site-shot
claude plugin update site-shot@site-shot
```

Restart Claude Code afterwards.

## Codex CLI (plugin)

This repository is also a Codex plugin marketplace. It installs the same plugin directory as Claude
Code does — one shared skill, the same pinned `site-shot-mcp@1.2.3` over stdio — with its own
manifest, because the two hosts wire the credential differently.

### Install

```bash
codex plugin marketplace add site-shot/site-shot-mcp
codex plugin add site-shot@site-shot
```

Exercised against Codex CLI 0.147.0 on macOS (arm64). Installing is not the same as being
configured, and neither is the same as a capture succeeding: the server still needs the key below,
and a capture still needs allowance left on that key's account, from the free plan or a paid plan.

### The API key

Codex forwards the variable named in the plugin's descriptor:

```json
{ "command": "npx", "args": ["-y", "site-shot-mcp@1.2.3"], "env_vars": ["SITESHOT_API_KEY"] }
```

`env_vars` is an allow-list of names, not values: no key appears in this descriptor, in the commands
below, or in the manual `config.toml` entry further down. You provision the key in the environment
Codex starts from, in one of two ways.

**For one session (most private).** macOS defaults to zsh, where `read -p` starts a coprocess rather
than printing a prompt, so invoke bash explicitly:

```bash
bash -c 'read -r -s -p "Site-Shot API key: " SITESHOT_API_KEY && printf "\n" && export SITESHOT_API_KEY && exec codex'
```

`-s` keeps the key off the screen, nothing here puts it in argv, and the export is scoped to that
child session instead of lingering in the shell you typed from. You type the key at each launch.

**For every session.** Keep the key in a file only you can read, and export it from your shell
profile (`~/.zshrc` or `~/.bashrc`):

```bash
mkdir -p ~/.config/site-shot && chmod 700 ~/.config/site-shot
# put the key in ~/.config/site-shot/api-key with your editor, then:
chmod 600 ~/.config/site-shot/api-key
```

```bash
# in ~/.zshrc or ~/.bashrc
export SITESHOT_API_KEY="$(cat ~/.config/site-shot/api-key)"
```

The trade-off: every program started from those shells can read the variable. A Codex started from
a desktop launcher or a remote session does not read your shell profile, so it runs the server
without a key; start Codex from a terminal instead. If the key ever arrives as the literal text
`${SITESHOT_API_KEY}`, the server says so: that is an `env` table Codex did not expand, and
`env_vars` is the fix.

### Updating

```bash
codex plugin marketplace upgrade site-shot
codex plugin add site-shot@site-shot
```

The first command refreshes the marketplace from GitHub; the second installs the plugin version it
now lists (the plugin pins an exact `site-shot-mcp` release).

### Manual MCP setup instead

If you would rather not install the plugin, the same stdio server can be configured by hand. This is
an **alternative to** the plugin, not an addition — run both and you have two configurations of one
server. Pick one.

```toml
[mcp_servers.site-shot]
command = "npx"
args = ["-y", "site-shot-mcp@1.2.3"]
env_vars = ["SITESHOT_API_KEY"]
```

`codex mcp add site-shot -- npx -y site-shot-mcp@1.2.3` writes that entry for you; add `env_vars`
afterwards, since `codex mcp add --env KEY=VALUE` would store the key in the file in clear text.
Check it with `codex mcp get site-shot`. If you already have an entry like this and now install the
plugin, remove the manual one deliberately with `codex mcp remove site-shot` — nothing here edits
your configuration for you.

## Gemini CLI (extension)

```bash
gemini extensions install https://github.com/site-shot/site-shot-mcp
```

Gemini CLI asks for your Site-Shot API key during the install (get one at
<https://www.site-shot.com/start/>) and stores it as a sensitive setting; change it later with
`gemini extensions config site-shot`. The extension runs `npx -y site-shot-mcp@1.2.3`, and
`gemini extensions update site-shot` moves it to the next release. `gemini mcp list` shows the server
as `Connected` once it starts.

## Claude Desktop & other MCP clients

1. Get a Site-Shot API key at <https://www.site-shot.com/start/>.
2. Add this to your Claude Desktop config (`claude_desktop_config.json`), with your key in place of
   `YOUR_API_KEY`:

```json
{
  "mcpServers": {
    "site-shot": {
      "command": "npx",
      "args": ["-y", "site-shot-mcp"],
      "env": { "SITESHOT_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

3. Restart Claude Desktop. Ask it to *"take a full-page screenshot of https://news.ycombinator.com"* and
   it will call the server and show you the image.

Works the same way in any MCP client (Cursor, Cline, VS Code, LangChain, CrewAI) — point the client at
`npx -y site-shot-mcp` with `SITESHOT_API_KEY` in the environment.

Already running the server in one of those clients? `npx skills add site-shot/site-shot-mcp` adds the
`website-screenshots` skill, which tells the agent when to reach for the two tools and how to read
their errors. The skill needs the server: on its own it can only tell the agent that setup is
incomplete.

Every integration above runs the same local stdio server, published on npm and in the official MCP Registry. Hosted HTTPS MCP is a separate deployment and client-compatibility path, not something these plugin install commands configure. Publication here does not imply listing in the shared ChatGPT/Codex public plugin directory or Claude's remote connector directory.

## Tools

Two tools, both returning the screenshot as MCP image content, sometimes with text items around
it (see below). There is no saved library, no listing, no markdown conversion and no scheduling —
this server captures images and hands them back.

### `capture_screenshot`
Screenshot a web page (viewport by default).

| Param | Type | Default | Notes |
|---|---|---|---|
| `url` | string (required) | — | Page to capture |
| `full_page` | boolean | `false` | Capture the whole scrollable page |
| `width` / `height` | number | API default | Viewport / device size |
| `format` | `"png"` \| `"jpeg"` \| `"webp"` | `png` | Image format. `webp` is lossless, about 35% smaller than `png` on the median page, max 16,383 px per side |
| `block_ads` | boolean | `true` | Remove ads |
| `block_cookie_banners` | boolean | `true` | Remove cookie-consent popups |
| `country` | string | — | Proxy country as a two-letter [ISO 3166-1 alpha-2](https://www.site-shot.com/countries) code, e.g. `"DE"` (auto IP/lang/tz/geo) |
| `strict_country` | boolean | `true` | Error out if the country has no proxy, instead of falling back to the US |
| `language` / `time_zone` / `geolocation` | string | — | Manual overrides |
| `wait_ms` | number | API default | Extra wait before capture (SPAs/animations) |
| `max_height` | number | 20000 (full page) | Cap captured height |

Returns the screenshot as an MCP image. A capture over 2000 px on a side comes back with a text
note first: a PNG taller than 2000 px is the note followed by a text label and an image for each
tile, top to bottom; any other image that large is the note followed by the whole image. Code that
reads `content[0]` as the image should take the items with `type: "image"`, in order, instead.

> **"API default" is not a number this package gets to state.** `width`, `height` and `wait_ms`
> are forwarded only when you pass them, so whatever applies when you don't is decided by the
> Site-Shot API and can change without a release here. Pass explicit values whenever the size
> matters.

> **Country codes are ISO codes, never names.** Pass `"DE"`, not `"Germany"`. The API matches
> codes exactly and would otherwise render through a US proxy without telling you, so the server
> rejects full names before spending a render. `strict_country` (on by default) likewise turns an
> unavailable country into an error instead of a silent US screenshot — pass `false` to opt back
> into the fallback. [Supported countries →](https://www.site-shot.com/countries)

An argument the tools do not take is refused before any capture, with the name to use: the
Site-Shot API's own names such as `delay_time`, `full_size` or `no_ads` map to `wait_ms`,
`full_page` and `block_ads` here.

Every failure the API answers names its HTTP status. A 401 or a 429 also says what to do next (a
401 points to where the key is set), and so does a 403, 404 or 5xx when the API sent no text of its
own. When the API answers with an error card instead of a screenshot, the card is attached as an
image. It shows what Site-Shot reported, which is not always the cause: for a host that does not
resolve it can read "504 Gateway Timeout", so check the URL's spelling before retrying. Every retry
is another capture that counts toward the month.

### `capture_full_page`
Same as `capture_screenshot` with full-page capture enabled.

A PNG taller than 2000 px comes back as several image tiles, top to bottom, each at most 2000 px
tall, with a short text label per tile. AI clients scale large images down before the model sees
them (Claude refuses anything over 8000 px on a side), so one 10,000 px image would arrive with its
text unreadable. The tiles are cut from the one capture, so they need no extra capture. Each tile
is a full-resolution image the model reads, so a tall page uses far more context than one scaled-down
image: about 2,700 tokens for a 1024 x 2000 tile. Tiles stop at about 18,000 tokens in all (six tiles,
the top 11,760 rows, at 1024 px wide), under the 25,000 Claude Code takes from one tool call; a page
wider than 6,750 px gets one tile, which can be more. The note names any rows left out at the
bottom. A tall `jpeg` or `webp` comes back whole, with a note.

## Why call this server instead of the agent's own browser?

If your agent drives a browser, it can screenshot pages itself — and for pages that must be signed
into or stepped through a flow, that is the right tool. For public URLs, delegating the capture to
this server is usually better engineering: every capture runs the same pipeline (no re-planning
between runs), can be taken from a specific country with matching locale and time zone
(`country` + `strict_country`), is scored by an image classifier with an escalating retry ladder
behind it before being returned, and costs a fraction of a cent instead of a browser session plus
vision tokens per look. The full comparison, both directions honestly argued:
[AI agent vs. screenshot API — who should capture the page](https://www.site-shot.com/blog/ai-agent-vs-screenshot-api/).

## Configuration

| Env var | Required | Description |
|---|---|---|
| `SITESHOT_API_KEY` | yes | Your Site-Shot API key (used as `userkey`). |

The server is a thin wrapper over the existing Site-Shot HTTP API (`https://api.site-shot.com/`) — no
separate backend.

## Development

Running the tests, trying the plugin from a checkout, and the release steps are in
[DEVELOPMENT.md](DEVELOPMENT.md).

On this branch `npm ci && npm test` also runs the remote transport tests (`npm run test:remote`,
real Unix sockets, injected fetch) and the stdio handshake (`npm run test:stdio`).

No test reaches the network or needs a key: `fetch` is injected everywhere and the
socket tests run against real Unix-domain sockets in a temporary directory.

### Private UDS worker (development only)

`src/uds-worker.js` is an **unreleased, private** transport for a future hosted
Site-Shot MCP. It is not part of the published npm package's supported surface, it
is not a remote endpoint, and there is no hosted server to point a client at. The
stdio server above is the only supported way to use this package today.

What it is: one Unix-domain socket serving `POST /mcp` with the same two tools and
the same capture code as stdio. It binds no TCP port. Each POST gets a fresh
`McpServer` and a stateless `WebStandardStreamableHTTPServerTransport` — the SDK's
web-standard class, chosen because it returns a `Response` the worker can measure
against its output budget instead of writing straight to the socket. Nothing — key,
subject, cancellation — is shared between two requests.

**It is not an authentication boundary.** Filesystem access to the socket is the
entire trust model: the worker believes the request context it reads there because
only a permitted local peer can open that socket. A future Django adapter is what
terminates OAuth, validates the token and synthesises that context from server
state. That adapter does not exist yet, so nothing here is reachable from the
internet and no OAuth claim is made.

Per request, the adapter sends exactly three headers, each once:

| Header | Meaning |
|---|---|
| `x-siteshot-subject` | Stable subject id for the account |
| `x-siteshot-api-key` | That account's current Site-Shot API key, for this request only |
| `x-siteshot-correlation-id` | Adapter-generated id; the only context value the worker logs |

`Authorization`, `Cookie`, `Origin`, `Mcp-Session-Id` and `X-Forwarded-*` are
rejected outright — a public credential arriving here means something is
forwarding a public request verbatim. `GET` (SSE streaming), `DELETE` and any
other path are refused explicitly rather than downgraded. The worker never reads
`SITESHOT_API_KEY`; a key in its environment stays unused.

Every bound is required, with no defaults — the package will not invent a budget
on an operator's behalf, and startup fails if one is missing:

| Variable | Meaning |
|---|---|
| `SITESHOT_MCP_UDS_PATH` | Absolute socket path, in a directory this process owns and that is not group- or world-writable |
| `SITESHOT_MCP_UDS_MODE` | Octal socket mode; `0600` local, `0660` with a shared group |
| `SITESHOT_MCP_UDS_GROUP` | Numeric gid — **required** when the mode grants group access, and verified after binding |
| `SITESHOT_MCP_ALLOWED_HOSTS` | Comma-separated `Host` allow-list |
| `SITESHOT_MCP_MAX_REQUEST_BYTES` | Ceiling on the incoming JSON-RPC body |
| `SITESHOT_MCP_MAX_IMAGE_BYTES` | Ceiling on the captured image bytes |
| `SITESHOT_MCP_MAX_RESPONSE_BYTES` | Ceiling on the **whole HTTP response** — status line, headers and body. Base64 adds a third on top of the image, plus the JSON-RPC envelope. Must fit `tools/list` with both schemas (~6 KiB), or every listing is refused |
| `SITESHOT_MCP_MAX_ERROR_BODY_BYTES` | How much of a non-image response is read to classify it |
| `SITESHOT_MCP_MAX_CONCURRENT_REQUESTS` | Active requests; there is no queue, an over-limit request is refused |
| `SITESHOT_MCP_CAPTURE_TIMEOUT_MS` | Overall capture deadline |
| `SITESHOT_MCP_REQUEST_BODY_TIMEOUT_MS` | Deadline for receiving the request body |

Cancellation, stated precisely: the capture deadline stays armed until the image
or error body has been fully consumed, and a caller that disconnects aborts the
render fetch and the body read. A **separate** `notifications/cancelled` POST
cannot cancel an earlier request — each POST is its own SDK `Protocol` instance
and its cancellation map is instance-local. The worker acknowledges such a
notification at the protocol level and nothing more. The only real cancellation is
hanging up the original connection, or the deadline.

Failures are classified, never quoted: the request URL contains `userkey`, so no
upstream body, exception text, stack or URL is returned or logged. Nor is anything
the caller sent — a rejected URL can carry credentials. Results carry a stable code
in the message text and in `_meta`; the full set is `missing_api_key`,
`invalid_url`, `invalid_country`, `deadline_exceeded`, `client_cancelled`,
`upstream_unreachable`, `upstream_error`, `country_unavailable`,
`response_too_large`, `response_unreadable` and `unsupported_image_type`.

Only `image/png`, `image/jpeg` and `image/webp` are served — the three formats the
tools offer. Any other type the API answers with is an `unsupported_image_type`
error rather than a screenshot, and the subtype is not repeated back.

## Requirements

Node.js ≥ 18 (uses the built-in `fetch`).

## License

MIT
