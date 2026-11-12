# Changelog

The release version comes from `package.json`. Keep the newest dated entry first.

## 0.1.1 — 2026-11-11

- Require a dated changelog entry matching the package version before CDN publication.
- Run CDN validation on every pull request so the required check can complete for documentation-only changes without requiring a release version bump.

## 0.1.0 — 2026-11-11

- Publish the first versioned inline widget UMD through GitHub OIDC/WIF to the Cimulate CDN, with create-only uploads and public SHA-256 verification.
