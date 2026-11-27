# Embedded Widget browser checks

## Run before opening a PR

Use Node 22. From the root of this checkout, set up dependencies and Chromium once.

```sh
npm ci
npm ci --prefix e2e
(cd e2e && npx playwright install chromium)
```

From the root, run these commands on your local branch. Rebuild the UMD whenever you change widget source.

```sh
npm run build:umd
npm run test:tools --prefix e2e
npm test --prefix e2e
npm run report --prefix e2e
```

The local HTML report is `e2e/playwright-report/index.html`. Expand a test's named steps to see what ran and how long it took. Controlled failures include fixture screenshots and traces. Use `npm test --prefix e2e` for this check. A bare Playwright invocation in `e2e` can also select deployed-storefront projects.

## What the local run proves

The controlled browser tests use the UMD built from **your checkout**, desktop and mobile Chromium emulation, and a simulated agent transport. They check widget modes, starter pills and input, session readiness, fallback and recovery, and the public handoff event. They also exercise the live checks' reply correlation and send limits using local fixtures. The tooling checks verify target validation and sanitized report handling. [SFRA browser integration](https://github.com/SalesforceCommerceCloud/plugin_commerce_client/pull/137) uses a separate fixture for the actual cartridge adapter, gallery CSS and a simulated drawer.

The Actions job **Shared widget browser merge check** uses the same controlled browser and tooling commands. It skips Chromium for unrelated paths. The **widget-regression** artifact contains the detailed Playwright report. Download and extract it, then run `npx playwright show-report <extracted-directory>` from `e2e`. New artifacts are retained for 14 days.

## Deployed storefront check

`WIDGET_LIVE_TARGET` is a GitHub Actions variable containing a non-secret JSON target profile. It tells Playwright which already-deployed storefront to visit. It does not publish the widget, upload a cartridge, or deploy the PR. The test-run source SHA identifies the Playwright code. Use independent deployment evidence to associate a result with a particular storefront or widget revision.

The profile contains an `id`, HTTPS `origin`, `widgetSelector`, `placementSelector` and 2–100 `pdps` with `id`, `name` and same-origin `path`. The workflow passes it as `WIDGET_TARGET_JSON`. A separately authorized local run can use `WIDGET_TARGET_FILE` with the same fields. The built-in local default is zyss-001 / NTO. The live assertions currently use the Commerce Client drawer with the widget in saved `shopper-agent` mode. Validate the DOM and target assumptions before using another storefront.

The live job expects two results, the deployed PDP check and the chosen chat scenario. The chat scenario verifies outgoing context, HTTP acceptance, a correlated agent event and a new visible reply after the matching user question. The answer's factual accuracy is evaluated separately by Shopper Agent evals.

- On a same-repo PR, only add `run-storefront-live-health` for one authorized typed question or `run-storefront-live-pill-followup` for an authorized starter pill and follow-up in the same fresh drawer.
- Once the workflow is on `main`, manual dispatch offers the same choices and requires `live_chat=true`. A later push or rerun does not send messages. Double-check the target before opting in.
- `npm run test:deployed` visits the target without a question. `npm run test:health` sends a real question. Keep everyday local testing on the controlled commands above. Local live runner files can contain raw diagnostic data. Share only the sanitized export.

Download **widget-live-sanitized** (14 days) and open `index.html`. The report shows **required tests and stages passed**, failed, skipped, missing or unrecorded evidence, and named failure stages. The quality gate fails if a required test or stage is missing or if the observed send count differs from the selected scenario. If setup fails or the result file is malformed, the exporter writes a safe failed report. The artifact contains allowlisted statuses and timings plus `summary.json`. Live screenshots, traces, transcripts and raw network payloads are excluded.
