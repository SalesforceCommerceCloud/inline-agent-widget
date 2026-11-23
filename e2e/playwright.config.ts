import { defineConfig, devices } from '@playwright/test';
import { loadTarget } from './targets.mjs';
export default defineConfig({
    testDir: './specs',
    metadata: { target: loadTarget().id, source: process.env.GITHUB_SHA || 'local' },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: !!process.env.CI,
    timeout: 45000,
    globalTimeout: 600000,
    expect: { timeout: 12000 },
    reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
    use: { screenshot: 'only-on-failure', serviceWorkers: 'block' },
    webServer:
        process.argv.some((arg) => arg.includes('storefront-')) && !process.argv.some((arg) => arg.includes('contract-'))
            ? undefined
            : { command: 'node tools/server.mjs', url: 'http://127.0.0.1:43132/health', reuseExistingServer: false },
    projects: [
        {
            name: 'contract-desktop',
            testMatch: 'contract.spec.ts',
            use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' }
        },
        {
            name: 'contract-mobile',
            testMatch: 'contract.spec.ts',
            use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium', trace: 'retain-on-failure' }
        },
        {
            name: 'storefront-readonly',
            testMatch: 'deployed.spec.ts',
            use: { ...devices['Desktop Chrome'], trace: 'off', video: 'off', screenshot: 'off' }
        },
        {
            name: 'storefront-health',
            testMatch: 'health.spec.ts',
            use: { ...devices['Desktop Chrome'], trace: 'off', video: 'off', screenshot: 'off' },
            timeout: 150000
        }
    ]
});
