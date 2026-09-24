# Site-Shot MCP server

Give Claude, Cursor, and other AI agents the ability to **see public web pages** — take website screenshots
with [Site-Shot](https://www.site-shot.com/) over the [Model Context Protocol](https://modelcontextprotocol.io).

Real Chromium rendering · full-page capture · country proxies · automatic **ad & cookie-banner removal**
(cleaner images, fewer vision tokens).

A Site-Shot API key is required, and it takes a paid Site-Shot API plan: captures draw on that
account's existing API allowance and limits. The key comes from your
[Site-Shot dashboard](https://www.site-shot.com/dashboard/); [pricing](https://www.site-shot.com/pricing/)
lists the plans. The no-signup browser tool at <https://www.site-shot.com/> is for checking output
quality; it does not issue keys.

## Claude Code (plugin)

This repository doubles as a Claude Code plugin marketplace. The plugin runs the published
`site-shot-mcp` package over stdio and declares the API key as a required sensitive setting, so
Claude Code prompts you for it rather than asking you to paste it into this repository, a config
file, or a chat message.

### Install

```bash
claude plugin marketplace add site-shot/site-shot-mcp
claude plugin install site-shot@site-shot
```

or from inside a session:

```
/plugin marketplace add site-shot/site-shot-mcp
/plugin install site-shot@site-shot
```

Both forms resolve the marketplace from GitHub, so they work only after these manifests are
published on the repository's public default branch — not from a local branch or a fork you
have not pushed.

### Try it before that

Load the plugin directory for a single session:

```bash
claude --plugin-dir /absolute/path/to/site-shot-mcp/plugins/site-shot
```

Two things matter here. Pass an **absolute** path — `--plugin-dir` is resolved against the session's
working directory. And start that session from an ordinary project directory, **not from this
checkout**: this repo *is* the `site-shot-mcp` package, so npm resolves the name locally, finds no
linked binary, and the server dies with `sh: site-shot-mcp: command not found` before Claude Code
ever sees it. From an unrelated directory `npx` fetches the published package and starts it
normally — checked both ways: exit 127 in this checkout, clean stdio start from an empty one.

To exercise the real install path instead — marketplace resolution, manifests and the required
setting — add the checkout itself as a marketplace:

```bash
claude plugin marketplace add /absolute/path/to/site-shot-mcp
claude plugin install site-shot@site-shot
```

That installs into your user scope; undo it with `claude plugin uninstall site-shot@site-shot` and
`claude plugin marketplace remove site-shot`.

### The API key

The plugin declares `SITESHOT_API_KEY` as a required, sensitive setting. Claude Code prompts you for
the key, masks it as you type, and substitutes it into the server's environment as
`${user_config.SITESHOT_API_KEY}`. Storage of the value is Claude Code's to handle.

Installing without one is not an error — Claude Code records it as still owed
(`1 userConfig option not yet set (1 required)`). Supply it through the masked prompt:

```
/plugin configure site-shot@site-shot
```

Configure it before expecting a capture: that setting is what feeds the server its key. What Claude
Code does while it is unset — whether the server is launched at all, whether the tools are offered —
is Claude Code's own behaviour and is not something documented here from observation.

The server's side is independent of that. When run directly over stdio **without a key**, it still
starts and prints a warning on stderr. Capture tools return a clear missing-key error instead of an image.

The plugin adds one skill (`site-shot:website-screenshots`) and the two capture tools
[below](#tools). It declares no hooks, no monitors and no scheduled capture jobs; the only process
it launches is the declared stdio MCP server.

## Codex CLI (plugin)

This repository is also a Codex plugin marketplace. It installs the same plugin directory as Claude
Code does — one shared skill, the same pinned `site-shot-mcp@1.2.0` over stdio — with its own
manifest, because the two hosts wire the credential differently.

### Install

```bash
codex plugin marketplace add site-shot/site-shot-mcp
codex plugin add site-shot@site-shot
```

Exercised against Codex CLI 0.147.0 on macOS (arm64). As with Claude Code, these resolve the
marketplace from GitHub, so they work only once these manifests are on the public default branch;
before that, point `codex plugin marketplace add` at a local checkout path instead.

Installing is not the same as being configured, and neither is the same as a capture succeeding.
Installation only puts the manifests in place. The server still needs the key below, and a capture
still needs a Site-Shot plan with allowance left on it.

### The API key

Codex forwards the variable named in the plugin's descriptor:

```json
{ "command": "npx", "args": ["-y", "site-shot-mcp@1.2.0"], "env_vars": ["SITESHOT_API_KEY"] }
```

`env_vars` is an allow-list of names, not values: no key appears in this descriptor, in the command
below, or in the manual `config.toml` entry further down. You provision the key in the environment
of the session you start Codex from.

macOS defaults to zsh, where `read -p` starts a coprocess rather than printing a prompt — and a
`bash`-labelled code fence does not change the shell you paste into. Invoke bash explicitly:

```bash
bash -c 'read -r -s -p "Site-Shot API key: " SITESHOT_API_KEY && printf "\n" && export SITESHOT_API_KEY && exec codex'
```

`-s` keeps the key off the screen, nothing here puts it in argv, and the export is scoped to that
child session instead of lingering in the shell you typed from.

What this does not do is configure a Codex you start some other way. A desktop launcher or a remote
session begins from its own environment, so it will run the server without a key until you provision
one there too.

### Manual MCP setup instead

If you would rather not install the plugin, the same stdio server can be configured by hand. This is
an **alternative to** the plugin, not an addition — run both and you have two configurations of one
server. Pick one.

```toml
[mcp_servers.site-shot]
command = "npx"
args = ["-y", "site-shot-mcp@1.2.0"]
env_vars = ["SITESHOT_API_KEY"]
```

`codex mcp add site-shot -- npx -y site-shot-mcp@1.2.0` writes that entry for you; add `env_vars`
afterwards, since `codex mcp add --env KEY=VALUE` would store the key in the file in clear text.
Check it with `codex mcp get site-shot`. If you already have an entry like this and now install the
plugin, remove the manual one deliberately with `codex mcp remove site-shot` — nothing here edits
your configuration for you.

Either route, the caveat from the Claude Code section applies: unless the entry sets `cwd`, Codex
starts the server from wherever you ran Codex, so running it inside this repo hits the same
local-name collision.

## Claude Desktop & other MCP clients

1. Get a Site-Shot API key at <https://www.site-shot.com/start/>.
2. Add this to your Claude Desktop config (`claude_desktop_config.json`):

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

Every integration above runs the same local stdio server, and that package is published on npm and
in the official MCP Registry. It is **not listed** in the shared ChatGPT/Codex public plugin
directory or in Claude's remote connector directory: both of those routes take a hosted HTTPS MCP
endpoint, which Site-Shot has not deployed. Doing so is a separate decision.

## Tools

Two tools, both returning the screenshot as an MCP image. There is no saved library, no listing,
no markdown conversion and no scheduling — this server captures images and hands them back.

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

Returns the screenshot as an MCP image.

> **"API default" is not a number this package gets to state.** `width`, `height` and `wait_ms`
> are forwarded only when you pass them, so whatever applies when you don't is decided by the
> Site-Shot API and can change without a release here. Versions up to 1.1.0 printed pixel sizes
> for `width` / `height` that the API does not use — an agent that omitted them to take "the
> default" got a different viewport, with nothing in the returned image to reveal it. Pass
> explicit values whenever the size matters.

> **Country codes are ISO codes, never names.** Pass `"DE"`, not `"Germany"`. The API matches
> codes exactly and would otherwise render through a US proxy without telling you, so the server
> rejects full names before spending a render. `strict_country` (on by default) likewise turns an
> unavailable country into an error instead of a silent US screenshot — pass `false` to opt back
> into the fallback. [Supported countries →](https://www.site-shot.com/countries)

### `capture_full_page`
Same as `capture_screenshot` with full-page capture enabled.

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

## Local development

```bash
npm ci                   # exact pinned dependencies
npm test                 # syntax + smoke + plugin metadata + remote transport + stdio handshake
npm run check            # syntax check
npm run smoke            # offline capture tests (injected fetch, no API key needed)
npm run test:remote      # offline UDS transport tests (real sockets, injected fetch)
npm run test:stdio       # real stdio handshake against the local source
npm run test:plugin      # plugin/marketplace metadata tests
npm run validate:plugin  # claude plugin validate --strict (needs the claude CLI)
SITESHOT_API_KEY=yourkey npm start   # run the server on stdio
```

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
