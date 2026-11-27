import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { loadTarget } from '../targets.mjs';
export const target = loadTarget();
export const origin = target.origin;
export const pdps = target.pdps;
export const embedded = (page: Page) => page.locator(target.widgetSelector);
export async function visit(page: Page, product = pdps[0]) {
    const response = await page.goto(origin + product.path, { waitUntil: 'domcontentloaded' });
    expect(response?.ok(), 'PDP_HTTP: page must load successfully').toBe(true);
    expect(new URL(page.url()).origin, 'TARGET: remain on selected origin').toBe(origin);
    await expect(embedded(page), 'WIDGET_RENDER: exactly one embedded PDP widget').toHaveCount(1);
    await expect(embedded(page).getByRole('heading', { name: 'Ask Assistant' })).toBeVisible({ timeout: 30000 });
    await expect(embedded(page)).toHaveAttribute('product-name', product.name);
}
export async function evidence(page: Page, info: TestInfo, stages: string[]) {
    const config = await embedded(page)
        .evaluate((el) => ({
            mode: el.getAttribute('mode') || 'inline',
            preWarm: el.hasAttribute('pre-warm')
        }))
        .catch(() => ({}));
    await info.attach('sanitized-stages', {
        body: JSON.stringify({ stages, config }),
        contentType: 'application/json'
    });
}
export async function findCorrelatedReply(
    page: Page,
    sent: { id: string; conversation: string },
    earlierReply?: string
): Promise<string> {
    return page.evaluate(
        ({ id, conversation, earlierReply }) => {
            const entries = window.__widgetProbe.entries;
            const inConversation = (entry) => !entry.conversation || entry.conversation === conversation;
            const echo = entries.findIndex(
                (entry) => entry.id === id && ['EndUser', 'Customer'].includes(entry.role) && inConversation(entry)
            );
            if (echo < 0) return '';
            return (
                entries.slice(echo + 1).find(
                    (entry) =>
                        entry.id && entry.id !== earlierReply && entry.nonempty &&
                        ['Chatbot', 'Agent'].includes(entry.role) && inConversation(entry)
                )?.id || ''
            );
        },
        { id: sent.id, conversation: sent.conversation, earlierReply }
    );
}

export function hasRenderedReplyAfterQuestion(drawer: Locator, question: string): Promise<boolean> {
    return drawer.evaluate((node, question) => {
        const prompt = Array.from(node.querySelectorAll('.cim-widget-user-message-text'))
            .reverse()
            .find((message) => message.textContent?.trim() === question && message.checkVisibility());
        if (!prompt) return false;
        return Array.from(
            node.querySelectorAll('.cim-widget-message-group.chatbot, .cim-widget-message-group.human-agent')
        ).some(
            (reply) =>
                (prompt.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
                reply.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) &&
                Boolean(reply.textContent?.trim())
        );
    }, question);
}

export async function limitMessageSends(page: Page, max: number) {
    let expected = '';
    const counts = { forwarded: 0, blocked: 0 };
    await page.route(
        (url) => /\/conversation\/[^/]+\/message$/.test(url.pathname),
        async (route) => {
            const request = route.request();
            if (request.method() !== 'POST') {
                await route.fallback();
                return;
            }

            let text: unknown;
            try {
                text = request.postDataJSON()?.message?.staticContent?.text;
            } catch {}
            if (!expected || text !== expected || counts.forwarded >= max) {
                counts.blocked++;
                await route.abort('blockedbyclient');
                return;
            }

            expected = '';
            counts.forwarded++;
            await route.fallback();
        }
    );
    return {
        counts,
        allowNext(question: string) {
            expected = question;
        }
    };
}
export function installProbe() {
    const probe = (window.__widgetProbe = { sent: [], entries: [], warnings: [], failures: [] });
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
        const [input, init] = args;
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const parsed = new URL(url, location.href);
        const message = parsed.pathname.match(/\/conversation\/([^/]+)\/message$/);
        let sent;
        if (message && init?.method?.toUpperCase() === 'POST' && typeof init.body === 'string') {
            const body = JSON.parse(init.body);
            const variables = body.context?.flatMap((entry) => entry.sessionContext?.contextVariables || []) || [];
            const variable = variables.find((v) => v.name === 'commerce_agent_context');
            let value = variable?.value?.value;
            if (typeof value === 'string') {
                try {
                    value = JSON.parse(value);
                } catch {
                    value = null;
                }
            }
            sent = {
                id: body.message?.id,
                conversation: message[1],
                text: body.message?.staticContent?.text,
                contextId: value?.page_context_data?.id,
                contextType: value?.page_context_type,
                accepted: false
            };
            probe.sent.push(sent);
        }
        let response;
        try {
            response = await original(...args);
        } catch (error) {
            if (message) probe.failures.push('MESSAGE_NETWORK');
            throw error;
        }
        if (sent) {
            sent.accepted = response.ok;
            if (!response.ok) probe.failures.push('MESSAGE_HTTP_' + response.status);
            response
                .clone()
                .json()
                .then((body) => {
                    if (body?.warning?.warningCode) probe.warnings.push(body.warning.warningCode);
                })
                .catch(() => {});
        }
        if (parsed.pathname.endsWith('/sse') && response.ok && response.body) {
            const reader = response.clone().body.getReader();
            const decoder = new TextDecoder();
            void (async () => {
                let buffer = '';
                try {
                    while (true) {
                        const part = await reader.read();
                        if (part.done) break;
                        buffer += decoder.decode(part.value, { stream: true });
                        buffer = buffer.replace(/\r\n/g, '\n');
                        if (buffer.length > 1000000) {
                            probe.failures.push('SSE_FRAME_TOO_LARGE');
                            await reader.cancel();
                            break;
                        }
                        let boundary;
                        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                            const frame = buffer.slice(0, boundary);
                            buffer = buffer.slice(boundary + 2);
                            if (!/^event:\s*CONVERSATION_MESSAGE\s*$/m.test(frame)) continue;
                            const raw = frame
                                .split('\n')
                                .filter((line) => line.startsWith('data:'))
                                .map((line) => line.slice(5).trimStart())
                                .join('\n');
                            try {
                                const body = JSON.parse(raw);
                                const entry = body.conversationEntry;
                                if (!entry) continue;
                                const payload =
                                    typeof entry.entryPayload === 'string'
                                        ? JSON.parse(entry.entryPayload)
                                        : entry.entryPayload;
                                const abstract = payload?.abstractMessage;
                                const text = abstract?.staticContent?.text || abstract?.content?.text || '';
                                probe.entries.push({
                                    id: entry.identifier,
                                    role: entry.sender?.role,
                                    nonempty: typeof text === 'string' && text.trim().length > 0,
                                    conversation: body.conversationId || entry.conversationId || null
                                });
                            } catch {}
                        }
                    }
                } catch {
                } finally {
                    reader.releaseLock();
                }
            })();
        }
        return response;
    };
}
