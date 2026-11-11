# inline-agent-widget

A bare-minimum, embeddable **inline** widget for **Salesforce Agentforce** (SCRT2 — Messaging for In-App and Web). It renders an always-visible block (not a floating popup): a text input on top and, below it, the agent's answer to your most recent question. It streams the reply token-by-token and displays it as **sanitized markdown**. The whole UI lives inside a **Shadow DOM**, so host-page styles can't leak in and the widget's styles can't leak out.

- 🟢 Always-visible inline block — a text input on top, the current answer below. Asking a new question replaces the previous answer (single-answer, no transcript).
- 🔒 Shadow-DOM isolated. Markdown is sanitized (`rehype-sanitize`); no raw HTML injection.
- 🔌 Anonymous SCRT2 session — no API key or secret in the browser.
- ♻️ Basic resilience — SSE auto-reconnect with exponential backoff + token auto-refresh on 401.
- 📦 Ships two ways: a self-contained UMD `<script>` (React bundled) and an ESM module (React as a peer).

> The Salesforce SCRT2 client under `src/sdk/` is a trimmed, self-contained copy carrying only the pieces this widget needs — no separate SDK dependency.

## Published CDN bundle

The first published UMD release is **0.1.0**, available from the Cimulate CDN:

```text
https://cdn.search.cimulate.ai/inline-agent-widget/0.1.0/inline-agent-widget.umd.js
```

Use this versioned URL for script-tag integrations in **SFRA, PWA Kit and SF Next**.
React is included in the UMD, so these consumers need no npm installation and no
copy of `inline-agent-widget.umd.js` in their cartridge or Managed Runtime bundle.
The storefront still supplies its loader, configuration, product context and any
Shopper Agent handoff adapter.

The [first publishing run](https://github.com/SalesforceCommerceCloud/inline-agent-widget/actions/runs/42988414724)
validated the public CDN bytes against the built artifact. See
[CDN publishing](docs/cdn-publishing.md) for WIF/IAM setup, release validation,
manual verification and recovery.

## npm / ESM integration

The CDN workflow publishes only the UMD to GCS; it does **not** publish an npm
package. The ESM and `mount()` examples below describe the package integration
when the package is available to your build. For a script-tag integration, use
the published CDN bundle above.

React 18 is a **peer dependency** for the ESM/npm path (so your app dedupes to a single React). The UMD/CDN bundle has React bundled in and needs no peer.

## Usage

### 1. CDN / `<script>` (no build step, non-React pages)

The UMD bundle registers the `<inline-agent-widget>` custom element automatically. Just drop the tag on the page.

```html
<script defer src="https://cdn.search.cimulate.ai/inline-agent-widget/0.1.0/inline-agent-widget.umd.js"></script>

<inline-agent-widget
  scrt2-url="https://YOUR_INSTANCE.salesforce-scrt.com"
  org-id="00DXXXXXXXXXXXXXXX"
  es-developer-name="YOUR_ES_DEVELOPER_NAME"
></inline-agent-widget>
```

Keep the version in the URL. Published objects cannot be overwritten, and this
pipeline provides no mutable `/latest/` alias. To upgrade or roll back, select
another published versioned URL and apply the storefront's normal configuration
and deployment process. Do not load both a bundled copy and the CDN copy on the
same page.

Allow `https://cdn.search.cimulate.ai` in the storefront's `script-src` CSP, while
retaining the SCRT2 connection and other directives required by your integration.
The script URL alone does not configure the agent or implement drawer handoff.

### Storefront loaders

All three storefronts can load the same UMD URL. Their configuration and loader
changes are maintained in the respective storefront repositories:

| Storefront | Where the script URL is configured |
| --- | --- |
| SF Next | `commerce.embeddedAgent.scriptSourceUrl`, supplied inside the `PUBLIC__app__commerce__embeddedAgent` JSON environment variable. The existing loader supports the published CDN URL. |
| PWA Kit | The embedded widget's server-rendered script and client-navigation loader must both use the CDN URL. Existing bundled-UMD integrations need a loader update first. |
| SFRA | The inline widget ISML template must use the CDN URL instead of `URLUtils.staticURL(...)`. Existing cartridge integrations need a loader update first. |

`scriptSourceUrl` is a **storefront loader setting**, not an attribute understood
by `<inline-agent-widget>`. Changing an arbitrary JSON field cannot switch a
loader that still hard-codes a bundled asset. CDN publication and storefront
adoption are separate steps. The floating **Cimulate Widget** has its own bundle
and configuration; this URL is for the inline widget only.

### 2. ESM / bundler

Importing the package runs the custom-element registration as a side effect:

```js
import "inline-agent-widget";
```

```html
<inline-agent-widget
  scrt2-url="https://YOUR_INSTANCE.salesforce-scrt.com"
  org-id="00DXXXXXXXXXXXXXXX"
  es-developer-name="YOUR_ES_DEVELOPER_NAME"
></inline-agent-widget>
```

### 3. Imperative `mount()`

For when you'd rather not use the custom element (e.g. rendering into a specific node):

```js
import { mount } from "inline-agent-widget";

const handle = mount({
  elementId: "chat-root", // or: element: document.querySelector("#chat-root")
  scrt2Url: "https://YOUR_INSTANCE.salesforce-scrt.com",
  orgId: "00DXXXXXXXXXXXXXXX",
  esDeveloperName: "YOUR_ES_DEVELOPER_NAME",
  placeholder: "Ask a question…",
});

// later:
handle.unmount();
```

If `elementId` isn't in the DOM yet, `mount()` waits for it via a `MutationObserver` (up to `timeout` ms, default 5000).

## Attributes (custom element)

| Attribute | Required | Description |
|---|---|---|
| `scrt2-url` | ✅ | SCRT2 instance base URL, e.g. `https://xyz.salesforce-scrt.com`. |
| `org-id` | ✅ | Salesforce Organization ID. |
| `es-developer-name` | ✅ | Embedded Service deployment developer name. |
| `capabilities-version` | | Capabilities version sent with the token request (default `1`). |
| `placeholder` | | Placeholder text for the input (default `Type a message…`). |
| `product-id-param` | | PDP product context (never shown). Query-string parameter to read the product id from, e.g. `pid`. See [Product context (PDP)](#product-context-pdp). |
| `product-id-pattern` | | PDP product context (never shown). Regex matched against the URL path; capture group 1 is the product id, e.g. `/product/([^/?#]+)`. See [Product context (PDP)](#product-context-pdp). |
| `pdp-questions` | | JSON-encoded array of opener questions to render as tappable pills above the input (e.g. `'["Is this waterproof?","Battery life?"]'`). Capped at 5, deduped and trimmed; malformed input is ignored. Pills auto-hide after the shopper's first question and re-appear on SPA-navigation between PDPs when the host swaps the list. |
| `enable-logging` | | Present ⇒ enables `[Agentforce]` debug logging in the console. |
| `persist-session` | | Present ⇒ persist the anonymous session so the conversation survives page navigation / reload / restart (default **off**), until the token's own JWT `exp`. **Read the security note below before enabling.** |

These three required values are the same **non-secret** identifiers Salesforce's own embedded messaging snippet uses for anonymous sessions. Connection attributes are read at mount; treat them as set-once.

The `mount()` API takes the camelCase equivalents (`scrt2Url`, `orgId`, `esDeveloperName`, `capabilitiesVersion`, `placeholder`, `productIdParam`, `productIdPattern`, `pdpQuestions`, `enableLogging`, `persistSession`). `pdpQuestions` is a `string[]` (already parsed) rather than a JSON string.

## Product context (PDP)

When the widget sits on a Product Detail Page, it can automatically tell the agent which product the shopper is looking at — so they can ask "is this waterproof?" without naming it. Set one of the URL-extraction attributes and, on every send, the widget derives the product id from the page URL and prepends a single line to the message **sent** to the agent:

```text
Viewing product details for: <productId>

<the shopper's message>
```

That line is **never shown in the widget UI** — the widget has no transcript and never renders the outgoing text, so it travels only in the request body. If no id can be resolved (neither attribute set, no match on the current URL, or not on a PDP), the message is sent unchanged.

- **SFRA** (`Product-Show?pid=…`): `product-id-param="pid"`.
- **PWA Kit** (`/product/{id}` path route): `product-id-pattern="/product/([^/?#]+)"`.

`product-id-param` reads a URL query-string parameter; `product-id-pattern` is a regex matched against the path (`location.pathname`) whose **first capture group** is the id, and is used when the param is absent or doesn't match. The id is resolved fresh on each send, so single-page client-side navigation between products is handled without a re-mount.

## Theming

Override the CSS custom properties on the element. Custom properties pierce the shadow boundary, so this works from ordinary page CSS:

```css
inline-agent-widget {
  --iaw-accent: #6b21a8;
  --iaw-accent-fg: #ffffff;
  --iaw-max-height: 600px;
  --iaw-max-width: 420px;
  --iaw-radius: 16px;
}
```

| Property | Default | |
|---|---|---|
| `--iaw-font` | system UI stack | Font family. |
| `--iaw-bg` / `--iaw-fg` | `#ffffff` / `#1a1a1a` | Surface + text. |
| `--iaw-border` | `#e2e2e6` | Borders. |
| `--iaw-radius` | `12px` | Corner radius. |
| `--iaw-accent` / `--iaw-accent-fg` | `#0b5cff` / `#fff` | Send button. |
| `--iaw-muted` | `#6b7280` | Secondary text / typing dots. |
| `--iaw-error` | `#b42318` | Error text. |
| `--iaw-max-height` | `480px` | Max height of the response region before it scrolls. |
| `--iaw-max-width` | `100%` | Widget max width. |

## Security

Agent output is rendered with `react-markdown` + `remark-gfm` + **`rehype-sanitize`**. Raw HTML and unsafe URIs (e.g. `javascript:`) are stripped — this widget deliberately does **not** use `rehype-raw`.

### Session persistence (`persist-session`)

By default the session lives **only in memory**, so each full page load starts a fresh anonymous conversation. Enabling `persist-session` stores the session in **`localStorage`** so the conversation continues across page navigation, reload, and browser restart (and is shared across tabs of the same origin).

What's stored is the **minimum**: the access token, the conversation id, and the last SSE event id — **never any message/transcript text**. The token is **anonymous and unauthenticated** (the same class of credential the page already sends on every request), so if it leaks the blast radius is *this messaging conversation only* — it grants no access to a Salesforce login, CRM data, or any account.

Reuse is bounded by the token's **own JWT `exp`** (set by the server at mint, typically a few hours): a stored session is rehydrated only while its token is unexpired, and once expired it can't be reused (a fresh token is a new anonymous UID and would 403 on the existing conversation).

Mitigations that are always on when persistence is enabled:

- **Token-expiry bound**: `loadSession` refuses and clears a stored session whose JWT `exp` has passed, so a dead token is never reused and doesn't linger at a well-known key.
- **Minimal, self-cleaning storage**: only the token + conversation id + last event id are stored (never transcript text); an expired / malformed entry is proactively removed on load, and the session is cleared when the conversation ends or the SDK reports a non-recoverable `SESSION_EXPIRED`.

**Residual risk — read before enabling on shared/kiosk devices.** `localStorage` is readable by any same-origin script (so an XSS or a compromised analytics/tag script on the host page could exfiltrate the token), and it persists across users of the same machine and is shared across tabs. Because reuse is bounded only by the token's `exp`, a stored session is resumable **for the full token lifetime** (potentially hours) — so on a **shared or public computer**, a walk-up user could resume the previous user's conversation until the token expires. For those deployments, prefer leaving `persist-session` **off**. (A per-tab, cleared-on-close `sessionStorage` variant would remove the shared-machine and cross-tab exposure at the cost of cross-tab/restart continuity — file an issue if you need it.) Note the shadow root is `mode: "open"`, which is a style-isolation boundary, **not** a JavaScript security boundary.

## How it works

> 📐 For the full architecture — module map, sequence diagrams (message flow + session persistence), and the connection state machine — see **[`docs/architecture.md`](./docs/architecture.md)**.

- The custom element attaches an open shadow root, injects the stylesheet as an inlined string (no `<style>` is added to `document.head`), and mounts a React 18 root inside the shadow tree.
- **The session is established lazily on the first send** — nothing hits the network on mount. When the user sends their first message it opens an anonymous SCRT2 session: `POST …/access-token` → open the SSE stream (`GET /eventrouter/v1/sse` with `Authorization` + `X-Org-Id`) → `POST …/conversation`, then sends the message. Later messages reuse the live session.
- Asking a question clears the previous answer and `POST`s a `StaticContentMessage`. The agent's reply arrives as `CONVERSATION_STREAMING_TOKEN` events (rendered live in the response region) and a final `CONVERSATION_MESSAGE` event whose content is authoritative and replaces the streamed preview.
- If the SSE stream drops, it auto-reconnects with exponential backoff, reusing the token. Once the token expires it emits a non-recoverable `SESSION_EXPIRED` error; call `connect()` again (re-mount) to start a fresh session.
- With `persist-session` on, the first send instead tries to **rehydrate** a stored session — `client.restore()` re-opens the SSE stream with the saved token and adopts the saved conversation id, skipping the token mint and conversation creation entirely (same anonymous UID → same conversation). A returning user sees no fresh greeting because the conversation already exists. If nothing valid is stored, it falls back to the normal fresh handshake and persists the result.

## Development

```bash
npm install
npm run dev        # serve demo/index.html with HMR
npm run build      # ESM (dist/index.mjs) + UMD (dist/inline-agent-widget.umd.js) + dist/index.d.ts
npm run preview    # build, then serve the demo against the built bundle
npm run typecheck  # tsc --noEmit
npm test           # vitest run (vendored SDK smoke tests + token parsing)
```

Point `demo/index.html` at a real SCRT2 instance/org/ES-name to exercise the full flow. The committed values are placeholders — never commit a real org.

## Publishing a new CDN version

1. Make the widget changes and choose a new semantic version. For a patch release:

   ```bash
   npm version patch --no-git-tag-version --ignore-scripts
   npm ci
   npm test
   npm run build:umd
   node scripts/cdn-publish.mjs prepare
   ```

   Commit both `package.json` and `package-lock.json` version changes with the
   source changes. Build the release from the source you intend to publish.
2. Open a PR to `main`. The CDN workflow validates release-input changes without
   cloud credentials. After merge, it downloads the validated UMD, authenticates
   through GitHub OIDC/WIF and uploads the versioned object with create-only
   permissions. No service-account JSON key is required.
3. Confirm **Publish widget to CDN** succeeds. Its summary provides the public
   URL, source commit, size and SHA-256 after checking the CDN response bytes and
   JavaScript Content-Type. A successful local build alone is not a publication.
4. Update each storefront's pinned URL and verify in the browser Network panel
   that the expected CDN script loads. Test the configured widget mode, including
   the host's handoff adapter when using `shopper-agent` mode.

Only release-input changes trigger automatic CDN publication. A README-only
change does not publish another bundle or need a version bump. To recheck the
current main version without uploading, use **Actions → Publish widget to CDN →
Run workflow → main**, with **verify_only** enabled. If main has moved beyond the
release, use the original run's artifact and checksum instead.

An HTTP 412 during upload means the version already exists. Do not overwrite it
or treat that response as proof that the existing bytes match. Follow the
[recovery instructions](docs/cdn-publishing.md#failures-retries-and-rollback).

## License

MIT. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
