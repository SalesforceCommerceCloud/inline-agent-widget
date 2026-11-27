import { test, expect } from '@playwright/test';
import { findCorrelatedReply, hasRenderedReplyAfterQuestion, installProbe, limitMessageSends } from '../support/storefront';
const host = 'http://127.0.0.1:43132/pdp';
const widget = (page) => page.locator('inline-agent-widget');
test.beforeEach(async ({}, info) => {
    info.annotations.push({
        type: 'Coverage',
        description: 'Shared widget UMD contracts: modes, session lifecycle and public handoff events'
    });
    info.annotations.push({
        type: 'Environment',
        description: 'Controlled fixture; Chromium desktop/mobile; no live agent'
    });
});
async function open(page, query) {
    await test.step('Load the controlled PDP and verify widget readiness', async () => {
        await page.goto(`${host}?pid=500500&${query}`);
        await expect(widget(page).getByRole('heading', { name: 'Ask Assistant' })).toBeVisible();
    });
}
for (const mode of ['inline', 'shopper-agent', 'hybrid']) {
    test(`${mode}: one widget, starter pills, accessible input and responsive gallery`, async ({ page }) => {
        await open(page, `mode=${mode}`);
        await test.step('Verify one widget, starter questions and responsive input', async () => {
            await expect(widget(page)).toHaveCount(1);
            await expect(
                widget(page).getByRole('list', { name: 'Suggested questions' }).getByRole('button')
            ).toHaveCount(2);
            await expect(widget(page).getByRole('textbox', { name: 'Ask a question' })).toHaveAttribute(
                'placeholder',
                /TrailFit Charge 2/
            );
            const bounds = await widget(page).boundingBox();
            expect(bounds!.width).toBeGreaterThan(250);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        });
    });
}
for (const mode of ['inline', 'hybrid']) {
    test(`${mode}: cold handshake gates context until welcome and renders inline answer`, async ({ page }) => {
        await open(page, `mode=${mode}&welcome=manual`);
        await test.step('Start a cold session without sending before welcome', async () => {
            await widget(page).getByRole('button', { name: 'Can I swap out the band?' }).click();
            await expect
                .poll(() => page.evaluate(() => window.fixture.requests.some((r) => r.url.endsWith('/conversation'))))
                .toBe(true);
            expect(
                await page.evaluate(() => window.fixture.requests.filter((r) => r.url.endsWith('/message')).length)
            ).toBe(0);
        });
        await test.step('Release welcome and verify the inline answer', async () => {
            await page.evaluate(() => window.fixture.releaseWelcome());
            await expect(widget(page).getByText('Fixture answer', { exact: true })).toBeVisible();
            expect(await page.evaluate(() => window.fixture.handoffs)).toEqual([]);
        });
        await test.step('Verify welcome order, single delivery and PDP context', async () => {
            const result = await page.evaluate(() => ({
                events: window.fixture.events,
                messages: window.fixture.requests.filter((r) => r.url.endsWith('/message'))
            }));
            expect(result.events.indexOf('welcome')).toBeLessThan(result.events.indexOf('message'));
            expect(result.messages).toHaveLength(1);
            expect(
                result.messages[0].body.context[0].sessionContext.contextVariables[0].value.value.page_context_data.id
            ).toBe('500500');
        });
    });
    test(`${mode}: pre-warm starts handshake without sending a question`, async ({ page }) => {
        await open(page, `mode=${mode}&warm=true`);
        await test.step('Verify pre-warm starts one session without a question', async () => {
            await expect
                .poll(() =>
                    page.evaluate(() => window.fixture.requests.filter((r) => r.url.endsWith('/conversation')).length)
                )
                .toBe(1);
            expect(
                await page.evaluate(() => window.fixture.requests.filter((r) => r.url.endsWith('/message')).length)
            ).toBe(0);
        });
    });
    test(`${mode}: lazy initialization and typed input recovery after rejected send`, async ({ page }) => {
        await open(page, `mode=${mode}`);
        await test.step('Verify lazy initialization and arrange a rejected send', async () => {
            expect(await page.evaluate(() => window.fixture.requests.length)).toBe(0);
            await page.evaluate(() => {
                window.fixture.failSend = true;
            });
        });
        const input = widget(page).getByRole('textbox', { name: 'Ask a question' });
        await test.step('Verify failed input remains recoverable', async () => {
            await input.fill('Is this waterproof?');
            await input.press('Enter');
            await expect(input).toHaveValue('Is this waterproof?');
            await expect(widget(page).locator('.error')).toBeVisible();
        });
        await test.step('Retry the retained input explicitly and render the answer', async () => {
            await page.evaluate(() => {
                window.fixture.failSend = false;
            });
            await input.press('Enter');
            await expect(widget(page).getByText('Fixture answer', { exact: true })).toBeVisible();
        });
    });
}
test('hybrid: routed follow-up hands off while ordinary follow-up stays inline', async ({ page }) => {
    await open(page, 'mode=hybrid');
    await test.step('Keep the first answer and ordinary follow-up inline', async () => {
        await widget(page).getByRole('button', { name: 'Can I swap out the band?' }).click();
        await expect(widget(page).getByText('Fixture answer', { exact: true })).toBeVisible();
        await widget(page).getByRole('button', { name: 'Inline follow-up', exact: true }).click();
        await expect
            .poll(() => page.evaluate(() => window.fixture.requests.filter((r) => r.url.endsWith('/message')).length))
            .toBe(2);
    });
    await test.step('Route the selected follow-up to a named handoff event', async () => {
        await widget(page)
            .getByRole('button', { name: /Explore alternatives/ })
            .click();
        expect(await page.evaluate(() => window.fixture.handoffs)).toEqual([
            { question: 'Explore alternatives', productName: 'TrailFit Charge 2', source: 'pill' }
        ]);
    });
});
test('shopper-agent: emits named pill and typed handoff events without an inline session', async ({ page }) => {
    await open(page, 'mode=shopper-agent&warm=true');
    await test.step('Submit pill and typed questions', async () => {
        await widget(page).getByRole('button', { name: 'Can I swap out the band?' }).click();
        const input = widget(page).getByRole('textbox', { name: 'Ask a question' });
        await input.fill('More details please');
        await input.press('Enter');
    });
    await test.step('Verify two named events and no inline session', async () => {
        const events = await page.evaluate(() => window.fixture.handoffs);
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
            question: 'Can I swap out the band?',
            productName: 'TrailFit Charge 2',
            source: 'pill'
        });
        expect(events[1]).toMatchObject({
            question: 'More details please',
            productName: 'TrailFit Charge 2',
            source: 'input'
        });
        expect(await page.evaluate(() => window.fixture.requests.length)).toBe(0);
    });
});
test('failed widget bundle cannot masquerade as a registered working widget', async ({ page }) => {
    await test.step('Simulate a failed production bundle download', async () => {
        await page.route('**/widget.js', (route) => route.abort('failed'));
        await page.goto(`${host}?mode=inline`);
    });
    await test.step('Verify the unregistered element cannot appear usable', async () => {
        await expect(widget(page)).toHaveCount(1);
        expect(await page.evaluate(() => !!customElements.get('inline-agent-widget'))).toBe(false);
        await expect(widget(page).getByRole('textbox', { name: 'Ask a question' })).toHaveCount(0);
    });
});
test('live health probe correlates compact SSE frames without storing their text', async ({ page }) => {
    await open(page, 'mode=inline&compact=true');
    await test.step('Exercise the compact SSE fixture and collect probe entries', async () => {
        await page.evaluate(installProbe);
        await widget(page).getByRole('button', { name: 'Can I swap out the band?' }).click();
        await expect(widget(page).getByText('Fixture answer', { exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.__widgetProbe.entries.length)).toBe(3);
    });
    await test.step('Verify correlated acceptance and reply without retained text', async () => {
        const probe = await page.evaluate(() => window.__widgetProbe);
        expect(probe.sent).toHaveLength(1);
        expect(probe.sent[0].accepted).toBe(true);
        expect(probe.entries[1]).toMatchObject({ id: probe.sent[0].id, role: 'EndUser', nonempty: true });
        expect(probe.entries[2]).toMatchObject({ role: 'Chatbot', nonempty: true });
        expect(probe.entries.every((entry) => !('text' in entry))).toBe(true);
    });
});

test('live reply evidence requires a correlated event and a rendered reply after the question', async ({ page }) => {
    await page.setContent('<main><p class="cim-widget-message-group chatbot">Welcome</p><p class="cim-widget-user-message-text">Fixture question</p></main>');
    const drawer = page.locator('main');
    const question = 'Fixture question';
    const sent = { id: 'question-1', conversation: 'thread-1' };
    await page.evaluate(() => {
        window.__widgetProbe = {
            entries: [
                { id: 'welcome', role: 'Chatbot', nonempty: true, conversation: 'thread-1' },
                { id: 'question-1', role: 'EndUser', nonempty: true, conversation: 'thread-1' },
                { id: 'wrong-thread', role: 'Chatbot', nonempty: true, conversation: 'thread-2' },
                { id: 'reply-1', role: 'Chatbot', nonempty: true, conversation: 'thread-1' }
            ]
        };
    });
    expect(await findCorrelatedReply(page, sent)).toBe('reply-1');
    expect(await findCorrelatedReply(page, sent, 'reply-1')).toBe('');
    expect(await hasRenderedReplyAfterQuestion(drawer, question)).toBe(false);
    const reply = '<p class="cim-widget-message-group chatbot">Fixture reply</p>';
    await drawer.evaluate((node, html) => node.insertAdjacentHTML('beforeend', html), reply);
    expect(await hasRenderedReplyAfterQuestion(drawer, question)).toBe(true);
});

test('live send budget blocks extra or unexpected POSTs before delivery', async ({ page }) => {
    const path = '/conversation/fixture/message';
    let delivered = 0;
    await page.route('**' + path, (route) => {
        delivered++;
        return route.fulfill({ status: 200 });
    });
    const sends = await limitMessageSends(page, 1);
    await page.goto('http://127.0.0.1:43132/health');
    const send = (text: string) =>
        page.evaluate(
            async ({ path, text }) => {
                try {
                    return (
                        await fetch(path, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ message: { staticContent: { text } } })
                        })
                    ).ok;
                } catch {
                    return false;
                }
            },
            { path, text }
        );

    expect(await send('premature')).toBe(false);
    sends.allowNext('authorized');
    expect(await send('unexpected')).toBe(false);
    expect(await send('authorized')).toBe(true);
    sends.allowNext('authorized');
    expect(await send('authorized')).toBe(false);
    expect(sends.counts).toEqual({ forwarded: 1, blocked: 3 });
    expect(delivered).toBe(1);
});
