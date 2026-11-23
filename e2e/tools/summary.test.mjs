import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { summarize, renderHtml } from './summary.mjs';
import { validateTarget, loadTarget, targets } from '../targets.mjs';
const attachment = (name, value) => ({ name, body: Buffer.from(JSON.stringify(value)).toString('base64') });
function report(result = {}, overrides = {}) {
    return {
        stats: { startTime: '2026-11-23T09:54:00Z', duration: 12500 },
        config: { metadata: { target: 'zyss-001' } },
        suites: [
            {
                specs: [
                    {
                        title: 'not copied',
                        tests: [
                            {
                                projectName: 'storefront-health',
                                results: [{ status: 'passed', duration: 12000, ...result }]
                            }
                        ]
                    }
                ]
            }
        ],
        ...overrides
    };
}
test('named phases retain measured durations and mark subsequent checks not run after failure', () => {
    const data = summarize(
        report({
            status: 'failed',
            steps: [
                { title: 'WIDGET_RENDER', duration: 100 },
                {
                    title: 'DRAWER_OPEN',

                    duration: 800,
                    error: { message: 'private selector and token' }
                }
            ]
        }),
        'abcdef1234567',
        { id: '1234', attempt: '1' }
    );
    assert.equal(data.tests[0].name, 'Fresh-session handoff and agent availability');
    assert.equal(data.tests[0].failureStage, 'DRAWER_OPEN');
    assert.equal(data.tests[0].steps[0].durationMs, 100);
    assert.equal(data.tests[0].steps.find((s) => s.id === 'DRAWER_OPEN').status, 'failed');
    assert.equal(data.tests[0].steps.find((s) => s.id === 'MESSAGE_ACCEPTED').status, 'not-run');
    assert.deepEqual(data.counts, { passed: 0, failed: 1, skipped: 0 });
    assert.equal(data.at, '2026-11-23T09:54:00.000Z');
    assert.equal(data.runUrl, 'https://github.com/SalesforceCommerceCloud/inline-agent-widget/actions/runs/1234');
    const html = renderHtml(data);
    assert.match(html, /Open the shopper-agent drawer/);
    assert.match(html, /0.80 s/);
    assert.match(html, /Not passed/);
});
test('only allowlisted names, configuration and failure codes can leave a raw live report', () => {
    const secret = '<script>secret-token</script>';
    const raw = report({
        status: 'failed',
        error: { message: 'MESSAGE_SENT: ' + secret },
        steps: [
            { title: secret, duration: 99, error: { message: secret } },
            { title: 'DRAWER_OPEN', duration: 12 }
        ],
        attachments: [
            attachment('sanitized-stages', {
                stages: ['WIDGET_RENDER', 'WIDGET_RENDER:' + secret, secret],
                config: { mode: 'shopper-agent', preWarm: true, productName: secret },
                assets: [secret]
            }),
            attachment('sanitized-health', { requestCount: 1, entries: [secret] })
        ]
    });
    raw.suites[0].specs[0].title = secret;
    raw.config.metadata.target = secret;
    const data = summarize(raw, secret, { id: secret, attempt: secret });
    assert.equal(data.passed, false);
    assert.equal(data.tests[0].failureStage, 'MESSAGE_SENT');
    assert.equal(data.tests[0].requestCount, 1);
    assert.equal(data.tests[0].mode, 'shopper-agent');
    assert.equal(data.tests[0].preWarm, true);
    assert.deepEqual(data.tests[0].stages, ['WIDGET_RENDER', 'WIDGET_RENDER']);
    assert.equal(data.source, 'unknown');
    assert.equal(data.runUrl, null);
    assert.equal(JSON.stringify(data).includes('secret-token'), false);
    assert.equal(renderHtml(data).includes('secret-token'), false);
    assert.equal(renderHtml(data).includes('<script'), false);
});
test('malformed evidence and invalid numeric fields do not copy raw values or break reporting', () => {
    const data = summarize(
        report({
            duration: -1,
            attachments: [
                { name: 'sanitized-stages', body: 'not-json' },
                attachment('sanitized-health', { requestCount: 'secret' })
            ],
            steps: [{ title: 'WIDGET_RENDER', duration: 1e99 }]
        })
    );
    assert.equal(data.tests[0].durationMs, null);
    assert.equal(data.tests[0].steps[0].durationMs, null);
    assert.equal(data.tests[0].requestCount, null);
    assert.deepEqual(data.tests[0].stages, []);
});
test('missing, skipped, interrupted and runner-failed results never count as healthy', () => {
    assert.equal(summarize({}).passed, false);
    assert.equal(summarize(report({}, { errors: [{ message: 'private runner error' }] })).passed, false);
    for (const status of ['skipped', 'timedOut', 'interrupted'])
        assert.equal(summarize(report({ status })).passed, false);
    const unknown = report();
    unknown.suites[0].specs[0].tests[0].projectName = 'private-project';
    assert.equal(summarize(unknown).passed, false);
    assert.equal(summarize(unknown).tests[0].project, 'unknown');
    const absent = report();
    absent.suites[0].specs[0].tests[0].results = [];
    assert.equal(summarize(absent).tests[0].status, 'interrupted');
    assert.match(renderHtml(summarize({})), /No test results were recorded/);
});
test('nested readonly results show both reference PDPs without exposing product identities', () => {
    const raw = report({ steps: [{ title: 'PDP_1_RENDER', duration: 10 }] });
    raw.suites[0].specs[0].tests[0].projectName = 'storefront-readonly';
    raw.suites = [{ suites: raw.suites }];
    const data = summarize(raw);
    assert.equal(data.tests[0].steps.length, 4);
    assert.equal(data.tests[0].steps[0].name, 'Reference PDP 1: render widget');
    assert.equal(data.tests[0].steps[3].status, 'not-run');
});
test('HTML escapes any display values and uses no external assets', () => {
    const data = summarize(report());
    data.source = '<img src=x onerror="alert(1)">';
    const html = renderHtml(data);
    assert.match(html, /&lt;img/);
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('<script'), false);
    assert.equal(html.includes('<link'), false);
});
test('CLI produces a useful failure artifact when Playwright JSON is missing or malformed', async () => {
    await mkdir('test-results', { recursive: true });
    const cwd = await mkdtemp(resolve('test-results/report-unit-'));
    try {
        for (const input of [null, 'not json', 'null']) {
            if (input !== null) {
                await mkdir(join(cwd, 'test-results'), { recursive: true });
                await writeFile(join(cwd, 'test-results/results.json'), input);
            }
            const result = spawnSync(process.execPath, [resolve('tools/summary.mjs')], {
                cwd,
                env: { ...process.env, GITHUB_STEP_SUMMARY: join(cwd, 'job-summary.md') }
            });
            assert.equal(result.status, 1);
            const data = JSON.parse(await readFile(join(cwd, 'sanitized-report/summary.json'), 'utf8'));
            assert.equal(data.passed, false);
            assert.equal(data.runnerFailed, true);
            assert.match(
                await readFile(join(cwd, 'sanitized-report/index.html'), 'utf8'),
                /No test results were recorded/
            );
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});
test('target configuration supports other storefronts while rejecting cross-origin PDPs', () => {
    assert.equal(loadTarget({}).id, 'zyss-001');
    assert.throws(() => loadTarget({ WIDGET_TARGET: 'missing' }));
    assert.throws(() =>
        validateTarget({
            ...targets.zyss,
            pdps: [{ id: 'a', name: 'A', path: '//elsewhere.invalid/a' }, targets.zyss.pdps[1]]
        })
    );
    assert.equal(
        validateTarget({ ...targets.zyss, id: 'pwa', origin: 'https://example.com', placementSelector: 'main' }).id,
        'pwa'
    );
});
