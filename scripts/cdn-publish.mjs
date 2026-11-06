import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICE_ACCOUNT = "cimulate-inline-agent-widget@cimulate-build.iam.gserviceaccount.com";
export const WORKFLOW_PATH = ".github/workflows/publish-cdn.yml";
const BUNDLE_PATH = "dist/inline-agent-widget.umd.js";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateVersion(version) {
  if (typeof version !== "string" || version !== version.trim() || !VERSION.test(version)) {
    throw new Error("package.json version must be a valid semantic version.");
  }
  return version;
}

export function validateAuth(provider, serviceAccount) {
  if (typeof provider !== "string" || provider !== provider.trim() || !/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(provider ?? "")) {
    throw new Error("Set GCP_WORKLOAD_IDENTITY_PROVIDER to the full provider resource name supplied by Cimulate.");
  }
  if (serviceAccount !== SERVICE_ACCOUNT) {
    throw new Error(`Set GCP_SERVICE_ACCOUNT to ${SERVICE_ACCOUNT}.`);
  }
}

export function checkVersionChange(version, baseSha, root = process.cwd()) {
  if (!baseSha || /^0+$/.test(baseSha)) return;
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error("Invalid baseline commit SHA.");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("cat-file", "-e", `${baseSha}^{commit}`);
  const files = git("ls-tree", "--name-only", baseSha, WORKFLOW_PATH).trim();
  if (!files) return;
  const previous = JSON.parse(git("show", `${baseSha}:package.json`));
  if (previous.version === version) {
    throw new Error("CDN release inputs changed without a package.json version bump. Choose a new version before merging.");
  }
}

export async function prepareRelease(root = process.cwd(), expected = {}) {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const version = validateVersion(pkg.version);
  const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
  if (lock.version !== version || lock.packages?.[""]?.version !== version) {
    throw new Error("package-lock.json version entries must match package.json.");
  }
  const bytes = await readFile(resolve(root, BUNDLE_PATH));
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) {
    throw new Error("UMD bundle must be non-empty and no larger than 10 MiB.");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expected.version && expected.version !== version) throw new Error("Release version differs from the validated build.");
  if (expected.sha256 && expected.sha256 !== sha256) throw new Error("UMD checksum differs from the validated build.");
  const object = `inline-agent-widget/${encodeURIComponent(version)}/inline-agent-widget.umd.js`;
  return {
    version, sha256, size: bytes.length, bytes,
    objectUrl: `https://storage.googleapis.com/copilot-bundles/${object}`,
    cdnUrl: `https://cdn.search.cimulate.ai/${object}`,
  };
}

export async function uploadRelease(release, token, request = fetch) {
  if (typeof token !== "string" || !token || /\s/.test(token)) throw new Error("Missing or invalid GCP access token.");
  let response;
  try {
    response = await request(release.objectUrl, {
      method: "PUT", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/javascript",
        "Cache-Control": "public, max-age=3600",
        "x-goog-if-generation-match": "0",
      },
      body: release.bytes,
    });
  } catch {
    throw new Error("GCS upload did not return a response. Its outcome may be unknown; inspect the versioned object before retrying.");
  }
  if (response.status === 412) throw new Error("Version already exists (HTTP 412). Do not overwrite; choose a new version or investigate an earlier upload.");
  if (response.status === 401) throw new Error("GCS authentication failed (HTTP 401). Check the WIF token and retry with fresh credentials.");
  if (response.status === 403) throw new Error("GCS denied the upload (HTTP 403). Confirm the SA's prefix-scoped bucket grant and effective policy with Cimulate.");
  if (!response.ok) throw new Error(`GCS upload failed (HTTP ${response.status}). Inspect the object before retrying.`);
}

export async function verifyCdn(release, { request = fetch, attempts = 5, pause = () => new Promise((r) => setTimeout(r, 3_000)) } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await request(release.cdnUrl, { redirect: "error", signal: AbortSignal.timeout(30_000), cache: "no-store" });
    } catch {
      if (attempt === attempts) throw new Error("CDN verification could not reach the versioned URL. Upload may already have succeeded.");
    }
    if (response?.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== release.sha256) throw new Error("CDN bytes do not match the validated UMD checksum.");
      if (!/^(application|text)\/javascript(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("CDN response does not have a JavaScript Content-Type.");
      return { contentType: response.headers.get("content-type"), cacheControl: response.headers.get("cache-control") };
    }
    if (attempt === attempts) throw new Error(`CDN verification failed (HTTP ${response?.status ?? "unknown"}). Confirm prefix routing/public access; the upload may already have succeeded.`);
    await pause();
  }
}

export async function main(command, env = process.env) {
  if (command === "check-auth") {
    validateAuth(env.GCP_WORKLOAD_IDENTITY_PROVIDER, env.GCP_SERVICE_ACCOUNT);
    return;
  }
  if (!["prepare", "publish", "verify-cdn"].includes(command)) throw new Error("Usage: node scripts/cdn-publish.mjs prepare|check-auth|publish|verify-cdn");
  const release = await prepareRelease(process.cwd(), { version: env.EXPECTED_VERSION, sha256: env.EXPECTED_SHA256 });
  if (command === "prepare") {
    checkVersionChange(release.version, env.BASE_SHA);
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `version=${release.version}\nsha256=${release.sha256}\nsize=${release.size}\ncdn_url=${release.cdnUrl}\n`);
    console.log(JSON.stringify({ version: release.version, sha256: release.sha256, bytes: release.size, cdnUrl: release.cdnUrl }));
  } else if (command === "publish") {
    await uploadRelease(release, env.GCP_ACCESS_TOKEN);
    console.log(`Published ${release.cdnUrl} (SHA-256 ${release.sha256}).`);
  } else {
    const headers = await verifyCdn(release);
    console.log(`Verified CDN bytes and Content-Type for ${release.cdnUrl}.`);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `## CDN release verified\n\n- Version: ${release.version}\n- Source commit: ${env.GITHUB_SHA}\n- URL: ${release.cdnUrl}\n- Bytes: ${release.size}\n- SHA-256: ${release.sha256}\n- Content-Type: ${headers.contentType}\n- Cache-Control: ${headers.cacheControl ?? "not supplied by CDN"}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
