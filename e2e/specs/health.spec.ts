import { test, expect } from '@playwright/test';
import { embedded, evidence, installProbe, pdps, visit } from '../support/storefront';
test('storefront fresh-session handoff receives a real agent reply without evaluating answer accuracy', async ({
    page
}, info) => {
    test.skip(process.env.WIDGET_LIVE_CHAT !== '1', 'Explicit live-chat opt-in required');
    const stages: string[] = [];
    const question = 'Please tell me about this product.';
    try {
        await test.step('WIDGET_RENDER', async () => {
            await page.addInitScript(installProbe);
            await visit(page);
            stages.push('WIDGET_RENDER');
        });
        const widget = embedded(page);
        await test.step('CONFIGURATION', async () => {
            expect(
                (await widget.getAttribute('mode')) || 'inline',
                'CONFIGURATION: requires saved shopper-agent mode; no BM writes'
            ).toBe('shopper-agent');
            stages.push('CONFIGURATION');
        });
        const beforeURL = page.url();
        await test.step('HANDOFF_SUBMITTED', async () => {
            await widget.getByRole('textbox', { name: 'Ask a question' }).fill(question);
            await widget.getByRole('button', { name: 'Send question', exact: true }).click();
            stages.push('HANDOFF_SUBMITTED');
        });
        await test.step('DRAWER_OPEN', async () => {
            await expect(
                page.locator('.cim-widget-dialog').first(),
                'DRAWER_OPEN: real shopper-agent drawer'
            ).toBeVisible({ timeout: 30000 });
            stages.push('DRAWER_OPEN');
        });
        const sent = await test.step('QUESTION_CONTEXT_SENT', async () => {
            await expect
                .poll(
                    () => page.evaluate((q) => window.__widgetProbe.sent.filter((m) => m.text === q).length, question),
                    {
                        timeout: 45000,
                        message: 'MESSAGE_SENT: handoff must produce one SCRT2 send'
                    }
                )
                .toBe(1);
            const message = await page.evaluate((q) => window.__widgetProbe.sent.find((m) => m.text === q), question);
            expect(message.contextId, 'CONTEXT_TRANSMISSION: current PDP id').toBe(pdps[0].id);
            expect(message.contextType, 'CONTEXT_TRANSMISSION: PDP context type').toBe('pdp');
            stages.push('QUESTION_CONTEXT_SENT');
            return message;
        });
        await test.step('MESSAGE_ACCEPTED', async () => {
            await expect
                .poll(
                    () => page.evaluate((id) => window.__widgetProbe.sent.find((m) => m.id === id)?.accepted, sent.id),
                    {
                        timeout: 15000,
                        message: 'MESSAGE_ACCEPTED: SCRT2 HTTP success'
                    }
                )
                .toBe(true);
            stages.push('MESSAGE_ACCEPTED');
        });
        await test.step('AGENT_REPLY_RECEIVED', async () => {
            await expect
                .poll(
                    () =>
                        page.evaluate((id) => {
                            const p = window.__widgetProbe;
                            const echo = p.entries.findIndex(
                                (e) => e.id === id && ['EndUser', 'Customer'].includes(e.role)
                            );
                            return (
                                echo >= 0 &&
                                p.entries
                                    .slice(echo + 1)
                                    .some((e) => ['Chatbot', 'Agent'].includes(e.role) && e.nonempty)
                            );
                        }, sent.id),
                    { timeout: 60000, message: 'AGENT_REPLY: nonempty bot message after the matching user echo' }
                )
                .toBe(true);
            stages.push('AGENT_REPLY_RECEIVED');
        });
        await test.step('REPLY_RENDERED', async () => {
            const bot = page.locator('.cim-widget-message-group.chatbot').last();
            await expect(bot, 'REPLY_RENDERED: agent response visible in drawer').toBeVisible();
            expect((await bot.innerText()).trim().length, 'REPLY_RENDERED: nonempty visible response').toBeGreaterThan(
                0
            );
            stages.push('REPLY_RENDERED');
        });
        await test.step('HANDSHAKE_CONTEXT_LABELS_VERIFIED', async () => {
            const order = await page.evaluate((id) => {
                const entries = window.__widgetProbe.entries;
                const echo = entries.findIndex((e) => e.id === id);
                return entries.slice(0, echo).some((e) => ['Chatbot', 'Agent'].includes(e.role) && e.nonempty);
            }, sent.id);
            expect(order, 'COLD_HANDSHAKE: welcome must precede question echo').toBe(true);
            await expect(page.locator('.cim-widget-page-context-divider').last()).toContainText(pdps[0].name);
            await expect(page.getByRole('group', { name: 'Current page context' })).toContainText(pdps[0].name);
            await expect(page.getByRole('textbox', { name: 'Ask about ' + pdps[0].name, exact: true })).toBeVisible();
            expect(page.url()).toBe(beforeURL);
            expect(
                await page.evaluate((q) => window.__widgetProbe.sent.filter((m) => m.text === q).length, question),
                'DELIVERY: no duplicate send'
            ).toBe(1);
            expect(
                await page.evaluate(() => window.__widgetProbe.warnings),
                'CONTEXT_ACCEPTANCE: no dropped-context warning'
            ).not.toContain('INVALID_CONTEXT_VARIABLE_PAYLOAD');
            await expect(page.getByRole('alert').filter({ hasText: 'Unable to send' })).toHaveCount(0);
            stages.push('HANDSHAKE_CONTEXT_LABELS_VERIFIED');
        });
    } finally {
        if (await embedded(page).count()) await evidence(page, info, stages);
        await info.attach('sanitized-health', {
            body: JSON.stringify({
                requestCount: await page.evaluate(() => window.__widgetProbe?.sent.length).catch(() => null)
            }),
            contentType: 'application/json'
        });
    }
});
