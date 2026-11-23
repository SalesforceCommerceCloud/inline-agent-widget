import { expect, type Page, type TestInfo } from '@playwright/test';
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
    const config = await embedded(page).evaluate((el) => ({
        mode: el.getAttribute('mode') || 'inline',
        preWarm: el.hasAttribute('pre-warm'),
        productName: el.getAttribute('product-name')
    }));
    const assets = await page.locator('script[src]').evaluateAll((nodes) =>
        nodes
            .map((node) => node.getAttribute('src'))
            .filter((src) => /inline-agent-widget|messaging\.umd|shopper-agent-handoff/.test(src || ''))
            .map((src) => {
                const url = new URL(src!, location.href);
                return url.origin + url.pathname;
            })
    );
    await info.attach('sanitized-stages', {
        body: JSON.stringify(
            { target: { id: target.id, origin }, stages, config, assets, at: new Date().toISOString() },
            null,
            2
        ),
        contentType: 'application/json'
    });
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
                            } catch {
                            }
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
