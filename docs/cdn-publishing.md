# Publish the widget to the Cimulate CDN

Work item: [W-24457426](https://gus.lightning.force.com/lightning/r/ADM_Work__c/a07EE00002mwO1CYAU/view).

The canonical source stays in `SalesforceCommerceCloud/inline-agent-widget`. The
workflow `.github/workflows/publish-cdn.yml` tests and builds a UMD, then publishes
an immutable version to:

```text
https://cdn.search.cimulate.ai/inline-agent-widget/<package.json version>/inline-agent-widget.umd.js
```

This workflow does not publish to npm or maintain `/latest/`. Existing npm/ESM
usage is separate. Storefronts explicitly select the versioned CDN script URL.

## One-time setup owned by Cimulate

John created this service account:

```text
cimulate-inline-agent-widget@cimulate-build.iam.gserviceaccount.com
```

Before merging/enabling publication, John must provide the full Workload Identity
Federation (WIF) provider resource name and confirm both IAM bindings below. The
workflow can be developed and validated before those are configured.

1. Configure or reuse a GitHub OIDC provider, with issuer
   `https://token.actions.githubusercontent.com`. Enable the participating APIs
   required for STS and IAM Service Account Credentials. The pool's project can
   differ from the service account's project.
2. Restrict trust to this repository, this workflow and `main`. The IDs below were
   retrieved from GitHub when this workflow was implemented:

   ```text
   assertion.repository_id == '1346453771' &&
   assertion.repository_owner_id == '1315434' &&
   assertion.repository == 'SalesforceCommerceCloud/inline-agent-widget' &&
   assertion.ref == 'refs/heads/main' &&
   assertion.workflow_ref == 'SalesforceCommerceCloud/inline-agent-widget/.github/workflows/publish-cdn.yml@refs/heads/main' &&
   (assertion.event_name == 'push' || assertion.event_name == 'workflow_dispatch')
   ```

   Map `google.subject` from `assertion.sub`, and map `attribute.repository_id`
   from `assertion.repository_id` for the binding below. Configure the provider's
   audience for the auth action's provider resource name. Use equality for the
   main-branch workflow reference, not `startsWith`.
3. Grant the corresponding federated principal set
   `roles/iam.workloadIdentityUser` **on the service account**:

   ```text
   principalSet://iam.googleapis.com/projects/<POOL_PROJECT_NUMBER>/locations/global/workloadIdentityPools/<POOL>/attribute.repository_id/1346453771
   ```

   All providers in a reused pool need to be considered: a different trusted
   issuer/provider must not be able to map arbitrary tokens to the same attribute.
4. Grant the SA `roles/storage.objectCreator` **on bucket `copilot-bundles`**, with
   an IAM condition:

   ```text
   resource.name.startsWith('projects/_/buckets/copilot-bundles/objects/inline-agent-widget/')
   ```

   Check that no other grants broaden the SA's write access. Extra read/list or
   admin permissions are not needed for the direct HTTP PUT in this workflow.
5. Confirm the existing CDN serves objects under `inline-agent-widget/` publicly,
   with a JavaScript Content-Type. The publishing SA does not change bucket
   public-access settings, CDN configuration, or object ACLs.

## GitHub repository variables

A repository administrator sets Settings → Secrets and variables → Actions →
Variables:

| Variable | Value |
| --- | --- |
| `GCP_SERVICE_ACCOUNT` | `cimulate-inline-agent-widget@cimulate-build.iam.gserviceaccount.com` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/<POOL>/providers/<PROVIDER>` |

These are identifiers, not secrets. Do not create or store a service-account JSON
key. The publishing job obtains a 10-minute OAuth access token through GitHub
OIDC → GCP STS → SA impersonation. It writes no credentials file, and the token
is available only to the upload step. The public CDN check sends no credentials.

## Release flow

1. Change the widget, add the newest dated release entry in `CHANGELOG.md`, and
   bump `package.json` to the matching semantic version. Update the
   root version entries in `package-lock.json` consistently, for example with
   `npm version patch --no-git-tag-version --ignore-scripts`.
2. Open a PR against `main`. Validation uses Node 22, installs locked dependencies,
   runs publisher and widget tests and builds the UMD. For release-input changes,
   it checks version/lockfile consistency, requires the first changelog heading
   `## <version> — YYYY-MM-DD` to match with a non-empty release-note bullet, and
   records SHA-256/size. Documentation-only PRs still report this check without
   requiring a version bump.
   Pull requests never run the cloud-authentication or publishing job.
3. Merge after the prerequisite setup is confirmed. A push to `main` affecting
   release inputs triggers publication. Inputs include `src`, changelog, package/lock files,
   Vite/TypeScript configs, the publisher script/tests and this workflow.
   README and other non-release documentation changes do not publish. Changelog
   changes are release inputs and require a version bump.
4. The publishing job downloads the validated artifact and checks its version and
   checksum. It validates the repo variables before attempting WIF authentication.
5. The Node HTTP client makes one XML API PUT to:

   ```text
   https://storage.googleapis.com/copilot-bundles/inline-agent-widget/<version>/inline-agent-widget.umd.js
   ```

   It sets `Content-Type: text/javascript`, `Cache-Control: public, max-age=3600`,
   and `x-goog-if-generation-match: 0`. No gcloud/gsutil destination preflight or
   long-lived key is involved. The bundle must be non-empty and at most 10 MiB.
6. The workflow verifies the bytes and Content-Type at the public CDN URL. It
   retries transient availability checks up to five times, with three seconds
   between attempts. The Actions summary records the URL, source commit, size,
   SHA-256 and observed response headers.
7. Configure SFRA, PWA Kit or SF Next to load that versioned URL; check their
   trusted-host/CSP requirements and perform a real widget interaction.

The first merge introducing this workflow may publish the existing package
version because there is no earlier workflow release baseline. Subsequent push/PR
runs require a version change relative to the event baseline. A manual dispatch
can retry an unpublished version but never bypasses the GCS generation guard.
All publishing jobs use the same concurrency group with cancellation disabled.
GitHub can replace a pending job with a newer pending job; this is not a durable
queue promising publication of every intermediate merge.

## Required merge check

Require `Validate CDN release` on `main` through branch protection or a ruleset.
The PR trigger deliberately has no path filter: a required check must report a
result on documentation-only PRs too. The workflow detects release-input changes
against the PR merge base before deciding whether to require a version bump,
validate the changelog and retain a publishing artifact. Keep the push filter
and this detection list aligned when adding release inputs.

## Failures, retries and rollback

| Failure | Meaning / action |
| --- | --- |
| Missing provider or unexpected SA | Repository variables are missing/wrong. Obtain the exact provider from John; retain the agreed SA |
| WIF fails | Confirm provider audience, exact repo/workflow/ref claims, SA binding and API enablement. IAM changes may take time to propagate |
| Changelog check fails | Add a matching newest dated release heading and a non-empty release-note bullet; commit CHANGELOG.md with the package versions |
| Version bump check fails | Update package and lockfile versions before merging release-input changes |
| Upload 401 | Token is invalid/expired; investigate auth and obtain fresh credentials |
| Upload 403 | Confirm effective bucket IAM and prefix condition. Authorization can fail before a duplicate precondition is evaluated |
| Upload 412 | That version is already present. Do not overwrite or assume its bytes match; inspect the prior release |
| Network error or 5xx during PUT | Upload outcome may be uncertain. There is no automatic write retry; inspect the object/CDN first |
| CDN verification fails | The upload may already have succeeded. Check routing, public access, negative caches, returned bytes and headers |
| CDN SHA-256 mismatch | Do not ship this version to consumers. Investigate the artifact or CDN response |

To recheck a successful upload without attempting another write, run Actions →
Publish widget to CDN → Run workflow, select **main** and enable **verify_only**.
It builds the current main version and compares its checksum with the CDN; it
skips WIF authentication and uploading. Use this while main still identifies the
release you want to check. If main has moved, retrieve the original release
artifact/checksum from its Actions run and inspect that URL instead.

For a full retry after an authentication or permission failure, rerun the failed
job only after checking that no object was created. If the earlier upload did
succeed, use verify-only. There is deliberately no automatic overwrite or
silent-success treatment of HTTP 412.

Rollback is a consumer configuration change to an earlier verified versioned
URL. Publishing a replacement at a previously released URL is disallowed. A
faulty release requires a new package version. Create-only IAM supplies a second
barrier if the HTTP precondition were accidentally removed.

## Local validation

```bash
npm ci
node --test --experimental-test-coverage --test-coverage-include=scripts/cdn-publish.mjs tests/cdn-publish.test.mjs
npm test
npm run build:umd
node scripts/cdn-publish.mjs prepare
```

Publisher tests use an injected HTTP transport and never contact GCP or upload a
real object. `prepare` reads local package/artifact bytes; it needs no credentials.
Existing repository CI separately enforces the widget's coverage thresholds.

## References

- [Agreed setup and John's November 3 reply](https://salesforce-internal.slack.com/archives/C0CA0MFQ849/p1793661109104199)
- [WIF for deployment pipelines](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
- [Google auth action](https://github.com/google-github-actions/auth)
- [Cloud Storage XML API upload](https://docs.cloud.google.com/storage/docs/xml-api/put-object-upload)
- [Generation preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)
