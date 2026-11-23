import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './summary.mjs';
import { validateTarget, loadTarget, targets } from '../targets.mjs';
test('summary preserves failure stages without transcripts, errors or network data', () => {
    const body = Buffer.from(JSON.stringify({ stages: ['WIDGET_RENDER', 'DRAWER_OPEN', 'secret-token'], payload: 'secret-token' })).toString('base64');
    const result = summarize({ suites: [{ specs: [{ tests: [{ projectName: 'storefront-health', results: [{ status: 'failed', error: { message: 'secret-token' }, attachments: [{ name: 'sanitized-stages', body }] }] }] }] }] });
    assert.equal(result.passed, false);
    assert.deepEqual(result.tests[0].stages, ['WIDGET_RENDER', 'DRAWER_OPEN']);
    assert.equal(JSON.stringify(result).includes('secret-token'), false);
});
test('missing results cannot pass health', () => assert.equal(summarize({}).passed, false));
test('target configuration supports other storefronts while rejecting cross-origin PDPs', () => {
    assert.equal(loadTarget({}).id, 'zyss-001');
    assert.throws(() => loadTarget({ WIDGET_TARGET: 'missing' }));
    assert.throws(() => validateTarget({ ...targets.zyss, pdps: [{ id: 'a', name: 'A', path: '//elsewhere.invalid/a' }, targets.zyss.pdps[1]] }));
    assert.equal(validateTarget({ ...targets.zyss, id: 'pwa', origin: 'https://example.com', placementSelector: 'main' }).id, 'pwa');
});
