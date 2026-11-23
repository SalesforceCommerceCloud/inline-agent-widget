# Shared widget browser checks

Node 22 and Playwright 1.58.2 with its matching Chromium are pinned for this suite.

```sh
npm ci
npm run build:umd
npm ci --prefix e2e
cd e2e
npx playwright install chromium
npm run test:tools
npm test
```

The desktop/mobile contracts use the production UMD built from this checkout, a controlled SCRT2 transport and captured public handoff events. They import no SFRA cartridge code. SFRA gallery placement and drawer-host adapter cases remain in plugin_commerce_client PR #137.

## Deployed targets

`npm run test:deployed` reads two reference PDPs without sending a question. `npm run test:health` sends one anonymous question in a fresh context, with no retries, and checks the saved shopper-agent mode. It never changes BM configuration. Welcome text cannot count as the answer. A successful outgoing HTTP request proves acceptance only; a matching user echo followed by a nonempty agent event and visible response are also required. Answer accuracy is outside this suite.

The default profile is zyss-001 / NTO. `WIDGET_TARGET_FILE` accepts a JSON profile containing `id`, HTTPS `origin`, `widgetSelector`, `placementSelector`, and two `pdps` entries (`id`, `name`, same-origin `path`). This supports other storefront hosts without copying the suite. Drawer checks currently expect the shared Commerce Client DOM. No PWA or SF Next target has been validated or enabled. Do not run other targets without authorization.

## Actions

PRs run controlled regression only. To request one live proof before merge, apply `run-zyss-live-health` to a same-repository PR. Only the label-add event triggers live chat; later pushes do not. After the workflow reaches main, manual dispatch with `live_chat=true` is available. There is no schedule and no S3/UIP publishing in this phase.

The live job disables screenshots, traces and video. It uploads only the allowlisted status/stage summary and corresponding HTML; it never uploads the full Playwright report, transcripts, browser storage or raw network payloads. GitHub artifact access follows repository visibility; this summary deliberately contains no chat content. Controlled fixture reports may contain synthetic data. Source commit and observed deployed asset versions are distinct; a passing fixture does not prove deployment.

Each live attempt is single-shot. Investigate a failure before authorizing another question. The prior local monitor remains paused until an explicit handover decision.
