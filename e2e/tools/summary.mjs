import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const healthSteps = {
    WIDGET_RENDER: 'Load PDP and render the widget',
    CONFIGURATION: 'Verify the saved shopper-agent mode',
    HANDOFF_SUBMITTED: 'Submit one question through the widget',
    DRAWER_OPEN: 'Open the shopper-agent drawer',
    QUESTION_CONTEXT_SENT: 'Transmit one question with PDP context',
    MESSAGE_ACCEPTED: 'Receive HTTP acceptance',
    AGENT_REPLY_RECEIVED: 'Receive a correlated agent reply',
    REPLY_RENDERED: 'Render the agent response',
    HANDSHAKE_CONTEXT_LABELS_VERIFIED: 'Verify welcome order, named context and single delivery'
};
const pillFollowupSteps = {
    WIDGET_RENDER: healthSteps.WIDGET_RENDER,
    CONFIGURATION: healthSteps.CONFIGURATION,
    PILL_SUBMITTED: 'Click a PDP starter pill',
    DRAWER_OPEN: healthSteps.DRAWER_OPEN,
    PILL_CONTEXT_SENT: 'Send the pill question with PDP context',
    PILL_MESSAGE_ACCEPTED: 'Receive HTTP acceptance for the pill question',
    PILL_AGENT_REPLY_RECEIVED: 'Receive a reply after the pill question',
    PILL_REPLY_RENDERED: 'Render the pill reply in the drawer',
    HANDSHAKE_CONTEXT_LABELS_VERIFIED: 'Verify welcome order and named PDP context',
    FOLLOWUP_SUBMITTED: 'Submit a follow-up in the same drawer',
    FOLLOWUP_CONTEXT_SENT: 'Send follow-up with PDP context in the same conversation',
    FOLLOWUP_MESSAGE_ACCEPTED: 'Receive HTTP acceptance for the follow-up',
    FOLLOWUP_AGENT_REPLY_RECEIVED: 'Receive a new reply after the follow-up',
    FOLLOWUP_REPLY_RENDERED: 'Render the new follow-up reply',
    TWO_MESSAGE_SESSION_VERIFIED: 'Verify exactly two messages in the original PDP session'
};
function layoutSteps(count) {
    const steps = {};
    for (let index = 1; index <= count; index++) {
        steps[`PDP_${index}_RENDER`] = `Reference PDP ${index}: render widget`;
        steps[`PDP_${index}_METADATA_LAYOUT`] = `Reference PDP ${index}: questions, metadata and placement`;
    }
    return steps;
}
const projects = {
    'storefront-readonly': { name: 'Deployed PDP rendering and placement' },
    'storefront-health': { name: 'Fresh-session handoff and agent availability', steps: healthSteps },
    'storefront-pill-followup': { name: 'Starter pill and same-session follow-up', steps: pillFollowupSteps }
};
const chatProjects = { typed: 'storefront-health', 'pill-followup': 'storefront-pill-followup' };
const failureCodes = new Set([
    'PDP_HTTP',
    'TARGET',
    'STARTER_QUESTIONS',
    'PLACEMENT',
    'MESSAGE_SENT',
    'CONTEXT_TRANSMISSION',
    'AGENT_REPLY',
    'COLD_HANDSHAKE',
    'DELIVERY',
    'SAME_SESSION',
    'CONTEXT_ACCEPTANCE',
    ...Object.keys(healthSteps),
    ...Object.keys(pillFollowupSteps)
]);
const completedStages = new Set([
    ...Object.keys(healthSteps),
    ...Object.keys(pillFollowupSteps),
    'METADATA_QUESTIONS_PLACEMENT'
]);
const statuses = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
const duration = (value) => (Number.isFinite(value) && value >= 0 && value <= 3600000 ? Math.round(value) : null);
function attachment(result, name) {
    const body = result?.attachments?.find((item) => item.name === name)?.body;
    if (typeof body !== 'string' || body.length > 100000) return {};
    try {
        return JSON.parse(Buffer.from(body, 'base64').toString('utf8')) || {};
    } catch {
        return {};
    }
}
function flatten(steps = []) {
    return steps.flatMap((step) => [step, ...flatten(step.steps)]);
}
export function summarize(report, source = 'unknown', run = {}) {
    report = report && typeof report === 'object' && !Array.isArray(report) ? report : { errors: [{}] };
    const metadata = report.config?.metadata;
    const referenceCount = metadata?.referencePdpCount;
    const readOnlySteps = layoutSteps(
        Number.isInteger(referenceCount) && referenceCount >= 2 ? Math.min(referenceCount, 100) : 2
    );
    const tests = [];
    const visit = (suites = []) => {
        for (const suite of suites) {
            for (const spec of suite.specs || []) {
                for (const test of spec.tests || []) {
                    const project = Object.hasOwn(projects, test.projectName) ? test.projectName : 'unknown';
                    const definition = projects[project] || { name: 'Unrecognized live check', steps: {} };
                    const result = test.results?.at(-1);
                    const status = statuses.has(result?.status) ? result.status : 'interrupted';
                    const rawSteps = flatten(result?.steps);
                    const labels = project === 'storefront-readonly' ? readOnlySteps : definition.steps;
                    const steps = Object.entries(labels).map(([id, name]) => {
                        const step = rawSteps.find((item) => item.title === id);
                        return {
                            id,
                            name,
                            status: step
                                ? step.error
                                    ? 'failed'
                                    : 'passed'
                                : rawSteps.length
                                  ? 'not-run'
                                  : 'not-recorded',
                            durationMs: step ? duration(step.duration) : null
                        };
                    });
                    const codedFailure = result?.error?.message?.match(/\b([A-Z_0-9]+):/)?.[1];
                    const failureStage =
                        status === 'passed' || status === 'skipped'
                            ? null
                            : failureCodes.has(codedFailure)
                              ? codedFailure
                              : steps.find((step) => step.status === 'failed')?.id || 'UNKNOWN';
                    const evidence = attachment(result, 'sanitized-stages');
                    const count = attachment(result, 'sanitized-health').requestCount;
                    const config = evidence.config || {};
                    tests.push({
                        project,
                        name: definition.name,
                        status,
                        durationMs: duration(result?.duration),
                        steps,
                        failureStage,
                        stages: Array.isArray(evidence.stages)
                            ? evidence.stages
                                  .map((s) => (typeof s === 'string' ? s.split(':')[0] : ''))
                                  .filter((s) => completedStages.has(s) || Object.hasOwn(readOnlySteps, s))
                            : [],
                        requestCount: Number.isInteger(count) && count >= 0 && count <= 100 ? count : null,
                        mode: ['inline', 'hybrid', 'shopper-agent'].includes(config.mode) ? config.mode : 'unknown',
                        preWarm: typeof config.preWarm === 'boolean' ? config.preWarm : null
                    });
                }
            }
            visit(suite.suites);
        }
    };
    visit(report.suites);
    const start = typeof report.stats?.startTime === 'string' ? Date.parse(report.stats.startTime) : NaN;
    const counts = { passed: 0, failed: 0, skipped: 0 };
    for (const test of tests)
        counts[test.status === 'passed' ? 'passed' : test.status === 'skipped' ? 'skipped' : 'failed']++;
    const runId = /^\d{1,20}$/.test(run.id || '') ? run.id : null;
    const attempt = /^\d{1,6}$/.test(run.attempt || '') ? run.attempt : null;
    const expected = ['storefront-readonly', chatProjects[run.scenario]];
    const missingProjects =
        run.scenario !== undefined &&
        (!Object.hasOwn(chatProjects, run.scenario) ||
            tests.length !== expected.length ||
            expected.some((project) => !tests.some((test) => test.project === project)));
    const runnerFailed = !!report.errors?.length || missingProjects;
    return {
        schemaVersion: 2,
        source: /^(?:[a-f0-9]{7,40}|local)$/.test(source) ? source : 'unknown',
        target:
            typeof metadata?.target === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(metadata.target)
                ? metadata.target
                : 'configured-storefront',
        at: Number.isFinite(start) ? new Date(start).toISOString() : null,
        durationMs: duration(report.stats?.duration),
        runId,
        attempt,
        runUrl: runId ? `https://github.com/SalesforceCommerceCloud/inline-agent-widget/actions/runs/${runId}` : null,
        counts,
        runnerFailed,
        tests,
        passed:
            tests.length > 0 && !runnerFailed && tests.every((t) => t.status === 'passed' && t.project !== 'unknown')
    };
}
const escape = (value) =>
    String(value ?? 'Not available').replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );
const elapsed = (ms) => (ms === null ? 'Not available' : `${(ms / 1000).toFixed(2)} s`);
export function renderHtml(data) {
    const checks = data.tests
        .map(
            (
                test
            ) => `<section><h2>${escape(test.name)}</h2><p><strong>${escape(test.status)}</strong> · ${escape(elapsed(test.durationMs))} · ${escape(test.project)}</p>
        <dl><dt>Failure stage</dt><dd>${escape(test.failureStage || (test.status === 'passed' ? 'None' : 'Not classified'))}</dd><dt>Questions observed</dt><dd>${escape(test.requestCount)}</dd><dt>Saved mode / pre-warm</dt><dd>${escape(test.mode)} / ${escape(test.preWarm === null ? null : String(test.preWarm))}</dd></dl>
        <table><thead><tr><th>Check</th><th>Status</th><th>Duration</th></tr></thead><tbody>${test.steps.map((step) => `<tr><td>${escape(step.name)}</td><td>${escape(step.status)}</td><td>${escape(elapsed(step.durationMs))}</td></tr>`).join('')}</tbody></table>
        ${test.failureStage ? '<p>Inspect the failed stage before authorizing another attempt. No automatic live-chat retries.</p>' : ''}</section>`
        )
        .join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Embedded widget live checks</title><style>
        body{font:16px system-ui,sans-serif;color:#203449;background:#f4f7fb;margin:0}main{max-width:1050px;margin:auto;padding:30px}h1{font-size:30px}h2{font-size:21px}section,.overview{background:white;border:1px solid #d6deea;border-radius:12px;padding:22px;margin:20px 0}.metrics{display:flex;gap:24px;flex-wrap:wrap}dt{font-weight:600}dd{margin:3px 0 12px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #e5eaf1}th{background:#f4f7fb}.notice{border-left:5px solid #bd8c25;padding-left:14px}code{overflow-wrap:anywhere}a{color:#075da5}@media(max-width:600px){main{padding:12px}section{padding:12px}th,td{padding:9px 4px}}
        </style></head><body><main><h1>Embedded widget live checks</h1><p>Functionality and availability. Agent answer accuracy is not evaluated.</p>
        <div class="overview"><h2>${data.passed ? 'Passed' : 'Not passed'}</h2><div class="metrics"><span>Passed: ${data.counts.passed}</span><span>Failed: ${data.counts.failed}</span><span>Skipped: ${data.counts.skipped}</span><span>Total: ${escape(elapsed(data.durationMs))}</span></div>
        <p>Target: ${escape(data.target)} · Started: ${escape(data.at)}</p><p>Source: <code>${escape(data.source)}</code></p>
        ${data.runUrl ? `<p><a href="${escape(data.runUrl)}">GitHub Actions run ${escape(data.runId)}</a> · Attempt ${escape(data.attempt)}</p>` : ''}</div>
        ${data.runnerFailed ? '<p class="notice">Runner or report-generation failure. Test results may be incomplete; raw errors are intentionally excluded.</p>' : ''}
        ${checks || '<p class="notice">No test results were recorded. This is not a successful health check.</p>'}
        <p class="notice">Safe report: fixed check names, timings, statuses and allowlisted configuration only. No transcripts, raw errors, request bodies, tokens, browser storage, screenshots or traces. “Not run” stages were not reached. “Not recorded” means step evidence is unavailable, including older reports without named steps.</p></main></body></html>`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    let report;
    try {
        report = JSON.parse(await readFile('test-results/results.json', 'utf8'));
        if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Invalid report');
    } catch {
        report = { errors: [{}] };
        process.exitCode = 1;
    }
    const data = summarize(report, process.env.GITHUB_SHA || 'local', {
        id: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
        scenario: process.env.LIVE_SCENARIO
    });
    if (!data.passed) process.exitCode = 1;
    await mkdir('sanitized-report', { recursive: true });
    await writeFile('sanitized-report/summary.json', JSON.stringify(data, null, 2));
    await writeFile('sanitized-report/index.html', renderHtml(data));
    if (process.env.GITHUB_STEP_SUMMARY) {
        await writeFile(
            process.env.GITHUB_STEP_SUMMARY,
            `## Embedded widget live checks\n\n${data.passed ? 'Passed' : 'Not passed'}: ${data.counts.passed} passed, ${data.counts.failed} failed, ${data.counts.skipped} skipped.\n\nDownload **widget-live-sanitized** for named stages, timings and failure classification. No chat content is included.\n`,
            { flag: 'a' }
        );
    }
}
