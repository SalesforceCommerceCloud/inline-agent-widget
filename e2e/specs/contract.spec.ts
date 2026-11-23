import { test, expect } from '@playwright/test';
import { installProbe } from '../support/storefront';
const host = 'http://127.0.0.1:43132/pdp';
const widget = (page) => page.locator('inline-agent-widget');
async function open(page, query) {
    await page.goto(`${host}?pid=500500&${query}`);
    await expect(widget(page).getByRole('heading', { name: 'Ask Assistant' })).toBeVisible();
}
for (const mode of ['inline', 'shopper-agent', 'hybrid']) {
    test(`${mode}: one widget, starter pills, accessible input and responsive gallery`, async ({ page }) => {
        await open(page, `mode=${mode}`);
        await expect(widget(page)).toHaveCount(1);
        await expect(widget(page).getByRole('list', { name: 'Suggested questions' }).getByRole('button')).toHaveCount(
            2
        );
        await expect(widget(page).getByRole('textbox', { name: 'Ask a question' })).toHaveAttribute(
            'placeholder',
            /TrailFit Charge 2/
        );
        const bounds = await widget(page).boundingBox();
        expect(bounds!.width).toBeGreaterThan(250);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    });
}
for (const mode of ['inline', 'hybrid']) {
    test(`${mode}: cold handshake gates context until welcome and renders inline answer`, async ({ page }) => {
        await open(page, `mode=${mode}&welcome=manual`);
        await widget(page).getByRole('button', { name: 'Can I swap out the band?' }).click();
        await expect
            .poll(() => page.evaluate(() => window.fixture.requests.some((r) => r.url.endsWith('/conversation'))))
            .toBe(true);
        expect(
            await page.evaluate(() => window.fixture.requests.filter((r) => r.url.endsWith('/message')).length)
        ).toBe(0);
        await page.evaluate(() => window.fixture.releaseWelcome());
        await expect(widget(page).getByText('Fixture answer', { exact: true })).toBeVisible();
        expect(await page.evaluate(() => window.fixture.handoffs)).toEqual([]);
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
    test(`${mode}: pre-warm starts handshake without sending a question`, async ({ page }) => {
        await open(page, `mode=${mode}&warm=true`);
        await expect
            .poll(() =>
                page.evaluate(() => window.fixture.requests.filter((r) => r.url.endsWith('/conversation')).length)
            )
            .toBe(1);
        expect(
            await page.evaluate(() => window.fixture.requests.filter((r) => r.url.endsWith('/message')).length)
        ).toBe(0);
    });
    test(`${mode}: lazy initialization and typed input recovery after rejected send`, async ({ page }) => {
        await open(page, `mode=${mode}`);
        expect(await page.evaluate(() => window.fixture.requests.length)).toBe(0);
        await page.evaluate(() => {
            window.fixture.failSend = true;
        });
        const input = widget(page).getByRole('textbox', { name: 'Ask a question' });
        await input.fill('Is this waterproof?');
        await input.press('Enter');
        await expect(input).toHaveValue('Is this waterproof?');
        await expect(widget(page).locator('.error')).toBeVisible();
        await page.evaluate(() => {
            window.fixture.failSend = false;
        });
        await input.press('Enter');
        await expect(widget(page).getByText('Fixture answer', { exact: true })).toBeVisible();
    });
}
test('hybrid: routed follow-up hands off while ordinary follow-up stays inline', async ({ page }) => {
    await open(page, 'mode=hybrid');
    await widget(page).getByRole('button', { name: 'Can I swap out the band?' }).click();
    await expect(widget(page).getByText('Fixture answer', { exact: true })).toBeVisible();
    await widget(page).getByRole('button', { name: 'Inline follow-up', exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => window.fixture.requests.filter((r) => r.url.endsWith('/message')).length))
        .toBe(2);
    await widget(page)
        .getByRole('button', { name: /Explore alternatives/ })
        .click();
    expect(await page.evaluate(() => window.fixture.handoffs)).toEqual([
        { question: 'Explore alternatives', productName: 'TrailFit Charge 2', source: 'pill' }
    ]);
});
test('shopper-agent: emits named pill and typed handoff events without an inline session', async ({ page }) => {
    await open(page, 'mode=shopper-agent&warm=true');
    await widget(page).getByRole('button', { name: 'Can I swap out the band?' }).click();
    const input = widget(page).getByRole('textbox', { name: 'Ask a question' });
    await input.fill('More details please');
    await input.press('Enter');
    const events = await page.evaluate(() => window.fixture.handoffs);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ question: 'Can I swap out the band?', productName: 'TrailFit Charge 2', source: 'pill' });
    expect(events[1]).toMatchObject({ question: 'More details please', productName: 'TrailFit Charge 2', source: 'input' });
    expect(await page.evaluate(() => window.fixture.requests.length)).toBe(0);
});
test('failed widget bundle cannot masquerade as a registered working widget', async ({ page }) => {
    await page.route('**/widget.js', (route) => route.abort('failed'));
    await page.goto(`${host}?mode=inline`);
    await expect(widget(page)).toHaveCount(1);
    expect(await page.evaluate(() => !!customElements.get('inline-agent-widget'))).toBe(false);
    await expect(widget(page).getByRole('textbox', { name: 'Ask a question' })).toHaveCount(0);
});
test('live health probe correlates compact SSE frames without storing their text', async ({ page }) => {
    await open(page, 'mode=inline&compact=true');
    await page.evaluate(installProbe);
    await widget(page).getByRole('button', { name: 'Can I swap out the band?' }).click();
    await expect(widget(page).getByText('Fixture answer', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__widgetProbe.entries.length)).toBe(3);
    const probe = await page.evaluate(() => window.__widgetProbe);
    expect(probe.sent).toHaveLength(1);
    expect(probe.sent[0].accepted).toBe(true);
    expect(probe.entries[1]).toMatchObject({ id: probe.sent[0].id, role: 'EndUser', nonempty: true });
    expect(probe.entries[2]).toMatchObject({ role: 'Chatbot', nonempty: true });
    expect(probe.entries.every((entry) => !('text' in entry))).toBe(true);
});
