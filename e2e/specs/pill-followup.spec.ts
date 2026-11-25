import { expect, test } from '@playwright/test';
import { embedded, evidence, installProbe, pdps, visit } from '../support/storefront';

test('storefront starter pill and follow-up receive two replies in one fresh drawer session', async ({ page }, info) => {
    test.skip(process.env.WIDGET_LIVE_PILL_FOLLOWUP !== '1', 'Explicit two-message live opt-in required');
    expect(info.retry + info.repeatEachIndex, 'DELIVERY: only the first attempt is authorized').toBe(0);

    const stages: string[] = [];
    const expectedMessages: string[] = [];
    let requestCount = 0;
    let blockedRequests = 0;

    async function stage<T>(name: string, check: () => Promise<T>) {
        return test.step(name, async () => {
            const value = await check();
            stages.push(name);
            return value;
        });
    }

    const drawer = page.locator('.cim-widget-dialog').first();

    async function observeTurn(
        kind: 'PILL' | 'FOLLOWUP',
        turn: number,
        previous?: { id: string; conversation: string; replyId: string }
    ) {
        const sent = await stage(kind + '_CONTEXT_SENT', async () => {
            await expect
                .poll(() => page.evaluate(() => window.__widgetProbe.sent.length), {
                    timeout: 45000,
                    message: 'MESSAGE_SENT: exactly one request per turn'
                })
                .toBe(turn);
            const message = await page.evaluate((index) => window.__widgetProbe.sent[index], turn - 1);
            expect(requestCount, 'DELIVERY: forwarded sends').toBe(turn);
            expect(blockedRequests, 'DELIVERY: unexpected or duplicate sends').toBe(0);
            expect(
                message.contextId === pdps[0].id && message.contextType === 'pdp',
                'CONTEXT_TRANSMISSION: current PDP'
            ).toBe(true);
            expect(
                Boolean(message.id && message.conversation),
                'MESSAGE_SENT: request and conversation identifiers'
            ).toBe(true);
            if (previous) {
                expect(
                    message.conversation === previous.conversation && message.id !== previous.id,
                    'SAME_SESSION: new request in the original conversation'
                ).toBe(true);
            }
            return message;
        });

        await stage(kind + '_MESSAGE_ACCEPTED', async () => {
            await expect
                .poll(
                    () => page.evaluate((id) => window.__widgetProbe.sent.find((m) => m.id === id)?.accepted, sent.id),
                    { timeout: 15000, message: 'MESSAGE_ACCEPTED: SCRT2 HTTP success' }
                )
                .toBe(true);
        });

        let replyId = '';
        await stage(kind + '_AGENT_REPLY_RECEIVED', async () => {
            await expect
                .poll(
                    async () => {
                        replyId = await page.evaluate(
                            ({ id, conversation, earlierReply }) => {
                                const entries = window.__widgetProbe.entries;
                                const inConversation = (entry) =>
                                    !entry.conversation || entry.conversation === conversation;
                                const echo = entries.findIndex(
                                    (entry) =>
                                        entry.id === id &&
                                        ['EndUser', 'Customer'].includes(entry.role) &&
                                        inConversation(entry)
                                );
                                if (echo < 0) return '';
                                return (
                                    entries
                                        .slice(echo + 1)
                                        .find(
                                            (entry) =>
                                                entry.id &&
                                                entry.id !== earlierReply &&
                                                entry.nonempty &&
                                                ['Chatbot', 'Agent'].includes(entry.role) &&
                                                inConversation(entry)
                                        )?.id || ''
                                );
                            },
                            { id: sent.id, conversation: sent.conversation, earlierReply: previous?.replyId }
                        );
                        return Boolean(replyId);
                    },
                    { timeout: 60000, message: 'AGENT_REPLY: new agent message after the matching user echo' }
                )
                .toBe(true);
        });

        await stage(kind + '_REPLY_RENDERED', async () => {
            await expect
                .poll(
                    () =>
                        drawer.evaluate(
                            (node, question) => {
                                const prompt = Array.from(node.querySelectorAll('.cim-widget-user-message-text')).find(
                                    (message) => message.textContent?.trim() === question
                                );
                                if (!prompt) return false;
                                return Array.from(
                                    node.querySelectorAll(
                                        '.cim-widget-message-group.chatbot, .cim-widget-message-group.human-agent'
                                    )
                                ).some(
                                    (reply) =>
                                        (prompt.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING) !==
                                            0 &&
                                        reply.checkVisibility() &&
                                        (reply.textContent?.trim().length ?? 0) > 0
                                );
                            },
                            expectedMessages[turn - 1]
                        ),
                    { message: 'REPLY_RENDERED: agent bubble after the matching user message' }
                )
                .toBe(true);
        });

        return { id: sent.id, conversation: sent.conversation, replyId };
    }

    try {
        await stage('WIDGET_RENDER', async () => {
            await page.addInitScript(installProbe);
            await page.route(
                (url) => /\/conversation\/[^/]+\/message$/.test(url.pathname),
                async (route) => {
                    if (route.request().method() !== 'POST') {
                        await route.continue();
                        return;
                    }
                    const expected = expectedMessages[requestCount];
                    let text: unknown;
                    try {
                        text = route.request().postDataJSON()?.message?.staticContent?.text;
                    } catch {}
                    if (requestCount >= 2 || !expected || text !== expected) {
                        blockedRequests++;
                        await route.abort('blockedbyclient');
                        return;
                    }
                    requestCount++;
                    await route.continue();
                }
            );
            await visit(page);
        });

        const widget = embedded(page);
        await stage('CONFIGURATION', async () => {
            expect(await widget.getAttribute('mode'), 'CONFIGURATION: saved shopper-agent mode').toBe('shopper-agent');
        });

        const originalURL = page.url();
        await stage('PILL_SUBMITTED', async () => {
            const pill = widget.getByRole('list', { name: 'Suggested questions' }).getByRole('button').first();
            await expect(pill, 'STARTER_QUESTIONS: starter pill visible').toBeVisible();
            const question = (await pill.innerText()).trim();
            expect(question.length > 0, 'STARTER_QUESTIONS: nonempty starter pill').toBe(true);
            expectedMessages.push(question);
            await pill.click();
        });
        await stage('DRAWER_OPEN', async () => {
            await expect(drawer, 'DRAWER_OPEN: real shopper-agent drawer').toBeVisible({ timeout: 30000 });
        });
        const first = await observeTurn('PILL', 1);

        const composer = drawer.getByRole('textbox', { name: 'Ask about ' + pdps[0].name, exact: true });
        await stage('HANDSHAKE_CONTEXT_LABELS_VERIFIED', async () => {
            const ordered = await page.evaluate((id) => {
                const entries = window.__widgetProbe.entries;
                const echo = entries.findIndex((entry) => entry.id === id);
                return (
                    echo >= 0 &&
                    entries.slice(0, echo).some((entry) => ['Chatbot', 'Agent'].includes(entry.role) && entry.nonempty)
                );
            }, first.id);
            expect(ordered, 'COLD_HANDSHAKE: welcome precedes the first user echo').toBe(true);
            await expect(drawer.locator('.cim-widget-page-context-divider').last()).toContainText(pdps[0].name);
            await expect(drawer.getByRole('group', { name: 'Current page context' })).toContainText(pdps[0].name);
        });

        await stage('FOLLOWUP_SUBMITTED', async () => {
            await expect(composer, 'SAME_SESSION: original PDP composer is ready').toBeEditable({ timeout: 30000 });
            const followup = 'What else should I know about this product?';
            expectedMessages.push(followup);
            await composer.fill(followup);
            await composer.press('Enter');
        });
        await observeTurn('FOLLOWUP', 2, first);
        await stage('TWO_MESSAGE_SESSION_VERIFIED', async () => {
            expect(page.url() === originalURL, 'SAME_SESSION: remain on the original PDP').toBe(true);
            await expect(drawer.getByRole('group', { name: 'Current page context' })).toContainText(pdps[0].name);
            expect(requestCount, 'DELIVERY: exactly two messages forwarded').toBe(2);
            expect(blockedRequests, 'DELIVERY: unexpected or duplicate sends').toBe(0);
            const contextWarning = await page.evaluate(() =>
                window.__widgetProbe.warnings.includes('INVALID_CONTEXT_VARIABLE_PAYLOAD')
            );
            expect(contextWarning, 'CONTEXT_ACCEPTANCE: no dropped-context warning').toBe(false);
        });
    } finally {
        await info.attach('sanitized-health', {
            body: JSON.stringify({ requestCount }),
            contentType: 'application/json'
        });
        if (await embedded(page).count()) await evidence(page, info, stages);
    }
});
