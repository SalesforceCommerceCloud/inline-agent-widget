import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const completedStages = new Set(['WIDGET_RENDER', 'HANDOFF_SUBMITTED', 'DRAWER_OPEN', 'QUESTION_CONTEXT_SENT', 'MESSAGE_ACCEPTED', 'AGENT_REPLY_RECEIVED', 'REPLY_RENDERED', 'HANDSHAKE_CONTEXT_LABELS_VERIFIED']);
export function summarize(report, source = 'unknown') {
    const tests = [];
    const visit = (suites) => {
        for (const suite of suites || []) {
            for (const spec of suite.specs || []) {
                for (const test of spec.tests || []) {
                    const result = test.results?.at(-1);
                    const attachment = result?.attachments?.find((a) => a.name === 'sanitized-stages' && a.body);
                    let stages = [];
                    if (attachment) {
                        const data = JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'));
                        stages = (data.stages || []).filter((s) => completedStages.has(s) || /^(WIDGET_RENDER|METADATA_QUESTIONS_PLACEMENT):[a-zA-Z0-9_-]+$/.test(s));
                    }
                    const allowed = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
                    tests.push({ project: test.projectName, status: allowed.has(result?.status) ? result.status : 'interrupted', stages });
                }
            }
            visit(suite.suites);
        }
    };
    visit(report.suites);
    return { source, target: /^[a-z0-9-]+$/.test(report.config?.metadata?.target || '') ? report.config.metadata.target : 'unknown', at: new Date().toISOString(), tests, passed: tests.length > 0 && tests.every((t) => t.status === 'passed') };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const data = summarize(JSON.parse(await readFile('test-results/results.json', 'utf8')), process.env.GITHUB_SHA || 'local');
    await mkdir('sanitized-report', { recursive: true });
    await writeFile('sanitized-report/summary.json', JSON.stringify(data, null, 2));
    const safe = JSON.stringify(data, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    await writeFile('sanitized-report/index.html', '<!doctype html><html lang="en"><meta charset="utf-8"><title>Widget health</title><h1>Widget health</h1><pre>' + safe + '</pre></html>');
}
