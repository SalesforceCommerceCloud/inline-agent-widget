import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  SERVICE_ACCOUNT, WORKFLOW_PATH, checkVersionChange, main,
  prepareRelease, uploadRelease, validateAuth, validateChangelog, validateVersion, verifyCdn,
} from "../scripts/cdn-publish.mjs";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/cdn-publish.mjs");
const roots = [];
after(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(version = "1.2.3", bytes = "window.InlineAgentWidget = {};") {
  const root = await mkdtemp(join(tmpdir(), "cdn-publish-test-"));
  roots.push(root);
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ version, packages: { "": { version } } }));
  await writeFile(join(root, "dist/inline-agent-widget.umd.js"), bytes);
  await writeFile(join(root, "CHANGELOG.md"), `# Changelog\n\n## ${version} — 2026-11-11\n\n- Describe the release behavior.\n`);
  return root;
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function baseline(root, hasWorkflow = true) {
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "CDN publisher tests");
  git(root, "config", "user.email", "cdn-test@example.invalid");
  if (hasWorkflow) {
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(join(root, WORKFLOW_PATH), "name: CDN\n");
  }
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "baseline");
  return git(root, "rev-parse", "HEAD");
}

const bytes = Buffer.from("window.InlineAgentWidget = {};");
const release = {
  bytes, sha256: createHash("sha256").update(bytes).digest("hex"),
  objectUrl: "https://storage.googleapis.com/copilot-bundles/inline-agent-widget/1.2.3/inline-agent-widget.umd.js",
  cdnUrl: "https://cdn.search.cimulate.ai/inline-agent-widget/1.2.3/inline-agent-widget.umd.js",
};

for (const version of ["0.1.0", "1.2.3", "1.2.3-rc.1", "1.2.3-alpha-beta", "1.2.3+build.4", "1.2.3-rc.1+build.4"]) {
  test(`accept semantic version ${version}`, () => assert.equal(validateVersion(version), version));
}
for (const version of [null, 1, "", "01.2.3", "1.2", "v1.2.3", "1.2.3-01", "../outside", "1.2.3/foo", "1.2.3\nkey=value", "1.2.3+", "1.2.3-rc..1", "1.2.3\n", " 1.2.3"]) {
  test(`reject unsafe/invalid version ${JSON.stringify(version)}`, () => assert.throws(() => validateVersion(version), /semantic version/));
}

test("validate dedicated SA and complete provider resource", () => {
  validateAuth("projects/123456/locations/global/workloadIdentityPools/widget/providers/github", SERVICE_ACCOUNT);
});
for (const provider of [undefined, "", "projects/cimulate-build/locations/global/workloadIdentityPools/widget/providers/github", "projects/123/locations/us/workloadIdentityPools/widget/providers/github", "projects/123/locations/global/workloadIdentityPools/widget/providers/github\n"]) {
  test(`reject incomplete provider ${provider}`, () => assert.throws(() => validateAuth(provider, SERVICE_ACCOUNT), /GCP_WORKLOAD_IDENTITY_PROVIDER/));
}
test("reject missing or unexpected SA", () => {
  const provider = "projects/123/locations/global/workloadIdentityPools/widget/providers/github";
  assert.throws(() => validateAuth(provider, undefined), /GCP_SERVICE_ACCOUNT/);
  assert.throws(() => validateAuth(provider, "other@example.com"), /GCP_SERVICE_ACCOUNT/);
});

test("prepare exact bytes, digest and versioned URLs", async () => {
  const result = await prepareRelease(await fixture());
  assert.equal(result.size, bytes.length);
  assert.equal(result.sha256, release.sha256);
  assert.equal(result.objectUrl, release.objectUrl);
  assert.equal(result.cdnUrl, release.cdnUrl);
});
test("encode build metadata in object URL", async () => {
  const result = await prepareRelease(await fixture("1.2.3+build.4"));
  assert.match(result.objectUrl, /1\.2\.3%2Bbuild\.4\//);
});
test("reject absent, empty and oversized artifacts", async () => {
  const root = await fixture("1.2.3", "");
  await assert.rejects(prepareRelease(root), /non-empty/);
  await writeFile(join(root, "dist/inline-agent-widget.umd.js"), Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(prepareRelease(root), /10 MiB/);
  await rm(join(root, "dist/inline-agent-widget.umd.js"));
  await assert.rejects(prepareRelease(root), /ENOENT/);
});
test("reject artifact or version changes between jobs", async () => {
  const root = await fixture();
  await assert.rejects(prepareRelease(root, { sha256: "wrong" }), /checksum/);
  await assert.rejects(prepareRelease(root, { version: "9.9.9" }), /version differs/);
  await prepareRelease(root, { version: "1.2.3", sha256: release.sha256 });
});

test("require a version bump after the workflow is introduced", async () => {
  const root = await fixture();
  const sha = await baseline(root);
  assert.throws(() => checkVersionChange("1.2.3", sha, root), /version bump/);
  checkVersionChange("1.2.4", sha, root);
});
test("allow the initial workflow release and manual retry", async () => {
  const root = await fixture();
  const sha = await baseline(root, false);
  checkVersionChange("1.2.3", sha, root);
  checkVersionChange("1.2.3", "", root);
  checkVersionChange("1.2.3", "0".repeat(40), root);
});
test("reject malformed or unavailable baseline commit", async () => {
  const root = await fixture();
  await baseline(root);
  assert.throws(() => checkVersionChange("1.2.3", "--anything", root), /baseline commit/);
  assert.throws(() => checkVersionChange("1.2.3", "f".repeat(40), root));
});

test("single authenticated PUT uses raw UMD, metadata and generation guard", async () => {
  const calls = [];
  await uploadRelease(release, "test-token", async (...args) => {
    calls.push(args);
    return new Response(null, { status: 200 });
  });
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, release.objectUrl);
  assert.equal(options.method, "PUT");
  assert.equal(options.redirect, "error");
  assert.deepEqual(options.headers, {
    Authorization: "Bearer test-token", "Content-Type": "text/javascript",
    "Cache-Control": "public, max-age=3600", "x-goog-if-generation-match": "0",
  });
  assert.equal(options.body, release.bytes);
});
for (const token of [undefined, "", "   ", "token\ninjected", " token "]) {
  test(`reject invalid token ${JSON.stringify(token)} before network access`, async () => {
    await assert.rejects(uploadRelease(release, token, () => assert.fail("network called")), /access token/);
  });
}
for (const [status, message] of [[401, /authentication failed/], [403, /prefix-scoped/], [412, /Version already exists/], [429, /HTTP 429/], [500, /HTTP 500/]]) {
  test(`fail closed on GCS HTTP ${status}`, async () => {
    let count = 0;
    await assert.rejects(uploadRelease(release, "test-token", async () => {
      count++;
      return new Response("do not log this body", { status });
    }), message);
    assert.equal(count, 1);
  });
}
test("do not leak token or retry ambiguous upload", async () => {
  let count = 0;
  await assert.rejects(uploadRelease(release, "sensitive-token", async () => {
    count++;
    throw new Error("sensitive-token");
  }), (error) => /outcome may be unknown/.test(error.message) && !error.message.includes("sensitive-token"));
  assert.equal(count, 1);
});

test("verify CDN hash and JavaScript headers without Authorization", async () => {
  const headers = await verifyCdn(release, { request: async (url, options) => {
    assert.equal(url, release.cdnUrl);
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, "error");
    return new Response(bytes, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
  } });
  assert.equal(headers.cacheControl, "public, max-age=3600");
});
test("retry CDN propagation failures with bounded attempts", async () => {
  let calls = 0;
  let pauses = 0;
  await verifyCdn(release, { attempts: 3, pause: async () => { pauses++; }, request: async () => {
    if (++calls < 3) return new Response(null, { status: 404 });
    return new Response(bytes, { headers: { "Content-Type": "text/javascript" } });
  } });
  assert.equal(calls, 3);
  assert.equal(pauses, 2);
});
test("recover from a transient CDN connection error", async () => {
  let calls = 0;
  await verifyCdn(release, { attempts: 2, pause: async () => {}, request: async () => {
    if (++calls === 1) throw new Error("connection reset");
    return new Response(bytes, { headers: { "Content-Type": "text/javascript" } });
  } });
});
test("fail on exhausted CDN retries, wrong bytes or HTML response", async () => {
  await assert.rejects(verifyCdn(release, { attempts: 1, request: async () => new Response(null, { status: 403 }) }), /routing\/public access/);
  await assert.rejects(verifyCdn(release, { attempts: 1, request: async () => { throw new Error("offline"); } }), /could not reach/);
  await assert.rejects(verifyCdn(release, { request: async () => new Response("wrong") }), /checksum/);
  await assert.rejects(verifyCdn(release, { request: async () => new Response(bytes, { headers: { "Content-Type": "text/html" } }) }), /JavaScript Content-Type/);
});

test("CLI prepare writes safe GitHub outputs without credentials", async () => {
  const root = await fixture();
  const output = join(root, "outputs");
  const result = spawnSync(process.execPath, [script, "prepare"], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, BASE_SHA: "", GITHUB_OUTPUT: output, GCP_ACCESS_TOKEN: "do-not-print", EXPECTED_VERSION: "", EXPECTED_SHA256: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  const outputs = await readFile(output, "utf8");
  assert.match(outputs, /version=1\.2\.3\nsha256=[a-f0-9]{64}\n/);
  assert.ok(!result.stdout.includes("do-not-print"));
  assert.ok(!outputs.includes("do-not-print"));
});
test("CLI check-auth rejects missing configuration with nonzero exit", () => {
  const result = spawnSync(process.execPath, [script, "check-auth"], {
    encoding: "utf8", env: { ...process.env, GCP_WORKLOAD_IDENTITY_PROVIDER: "", GCP_SERVICE_ACCOUNT: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GCP_WORKLOAD_IDENTITY_PROVIDER/);
});
test("CLI rejects unsupported commands", async () => {
  await assert.rejects(main("overwrite"), /Usage/);
  await main("check-auth", { GCP_WORKLOAD_IDENTITY_PROVIDER: "projects/123/locations/global/workloadIdentityPools/widget/providers/github", GCP_SERVICE_ACCOUNT: SERVICE_ACCOUNT });
});

test("CLI publish and CDN verification run end-to-end with an injected transport", async () => {
  const root = await fixture();
  const transport = join(root, "mock-fetch.mjs");
  const summary = join(root, "summary.md");
  await writeFile(transport, `
    import { readFile } from 'node:fs/promises';
    globalThis.fetch = async (url, options) => {
      if (options.method === 'PUT') {
        if (options.headers['x-goog-if-generation-match'] !== '0') throw new Error('missing precondition');
        return new Response(null, { status: 200 });
      }
      if (options.headers?.Authorization) throw new Error('credentials sent to CDN');
      return new Response(await readFile('dist/inline-agent-widget.umd.js'), {
        headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=3600' },
      });
    };
  `);
  const env = {
    ...process.env, BASE_SHA: "", GITHUB_SHA: "a".repeat(40), GITHUB_OUTPUT: "",
    GITHUB_STEP_SUMMARY: summary, GCP_ACCESS_TOKEN: "never-print-token",
    EXPECTED_VERSION: "1.2.3", EXPECTED_SHA256: release.sha256,
  };
  for (const command of ["publish", "verify-cdn"]) {
    const result = spawnSync(process.execPath, ["--import", transport, script, command], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(env.GCP_ACCESS_TOKEN));
  }
  const text = await readFile(summary, "utf8");
  assert.match(text, /CDN release verified/);
  assert.match(text, new RegExp(release.sha256));
  assert.match(text, /max-age=3600/);
  assert.ok(!text.includes(env.GCP_ACCESS_TOKEN));
});


test("reject inconsistent lockfile versions", async () => {
  const root = await fixture();
  for (const lock of [
    { version: "1.2.4", packages: { "": { version: "1.2.3" } } },
    { version: "1.2.3", packages: { "": { version: "1.2.4" } } },
    { version: "1.2.3" },
  ]) {
    await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
    await assert.rejects(prepareRelease(root), /version entries must match/);
  }
});

for (const heading of ["1.2.3 — 2026-11-11", "1.2.3 - 2026-11-11"]) {
  test(`accept changelog entry ${heading}`, async () => {
    const root = await fixture();
    await writeFile(join(root, "CHANGELOG.md"), `# Changelog\n\n## ${heading}\n\n- Fix the widget.\n\n## 1.2.2 — 2026-11-10\n\n- Previous release.\n`);
    await validateChangelog("1.2.3", root);
  });
}
for (const text of [
  "# Changelog\n",
  "## 1.2.2 — 2026-11-11\n\n- Wrong release.\n",
  "## 1.2.3\n\n- Missing date.\n",
  "## 1.2.3 — 2026-11-11\n\n## 1.2.2 — 2026-11-10\n\n- Older notes cannot satisfy the new entry.\n",
  "## 1.2.3 — 2026-11-11\n\n- \n",
  "## 1.2.2 — 2026-11-10\n\n- Older release.\n\n## 1.2.3 — 2026-11-11\n\n- New release must be first.\n",
  "```md\n## 1.2.3 — 2026-11-11\n\n- Example only.\n```\n",
]) {
  test(`reject incomplete or mismatched changelog ${JSON.stringify(text)}`, async () => {
    const root = await fixture();
    await writeFile(join(root, "CHANGELOG.md"), text);
    await assert.rejects(prepareRelease(root), /CHANGELOG.md/);
  });
}
test("reject a missing changelog before publication", async () => {
  const root = await fixture();
  await rm(join(root, "CHANGELOG.md"));
  await assert.rejects(prepareRelease(root), /ENOENT/);
});
