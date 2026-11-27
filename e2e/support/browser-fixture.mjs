/* eslint-env browser */
(function () {
    const params = new URLSearchParams(location.search);
    const mode = params.get('mode') || 'inline';
    const state = (window.fixture = {
        calls: [],
        requests: [],
        events: [],
        controllers: [],
        welcome: false,
        failSend: false
    });
    const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    function emit(role, text, id) {
        const data = {
            conversationEntry: {
                identifier: id || crypto.randomUUID(),
                sender: { role },
                transcriptedTimestamp: new Date().toISOString(),
                entryPayload: JSON.stringify({ abstractMessage: { staticContent: { text } } })
            }
        };
        const bytes = new TextEncoder().encode(
            (params.get('compact') === 'true'
                ? 'event:CONVERSATION_MESSAGE\ndata:'
                : 'event: CONVERSATION_MESSAGE\ndata: ') +
                JSON.stringify(data) +
                '\n\n'
        );
        state.controllers.forEach((controller) => {
            try {
                controller.enqueue(bytes);
            } catch {
                state.controllers = state.controllers.filter((c) => c !== controller);
            }
        });
    }
    state.releaseWelcome = () => {
        state.welcome = true;
        state.events.push('welcome');
        emit('Chatbot', 'Fixture welcome');
    };
    window.fetch = async (input, init = {}) => {
        const url = String(input);
        state.requests.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
        if (init.method === 'DELETE') return json({});
        if (url.endsWith('/access-token')) return json({ accessToken: 'fixture-token' });
        if (url.includes('/sse'))
            return new Response(
                new ReadableStream({
                    start(controller) {
                        state.controllers.push(controller);
                        init.signal?.addEventListener(
                            'abort',
                            () => {
                                state.controllers = state.controllers.filter((c) => c !== controller);
                                controller.close();
                            },
                            { once: true }
                        );
                        controller.enqueue(new TextEncoder().encode(': open\n\n'));
                    }
                }),
                { headers: { 'Content-Type': 'text/event-stream' } }
            );
        if (url.endsWith('/conversation')) {
            if (params.get('welcome') !== 'manual') setTimeout(state.releaseWelcome, 20);
            return json({});
        }
        if (url.endsWith('/message')) {
            const body = JSON.parse(init.body);
            if (state.failSend) return new Response('{}', { status: 400 });
            state.events.push('message');
            setTimeout(() => {
                emit('EndUser', body.message.staticContent.text, body.message.id);
                setTimeout(
                    () =>
                        emit(
                            'Chatbot',
                            JSON.stringify({
                                response: [
                                    { type: 'text', data: { content: 'Fixture answer' } },
                                    {
                                        type: 'suggestions',
                                        data: {
                                            items: [
                                                { text: 'Inline follow-up', answerable_by: 'inline' },
                                                { text: 'Explore alternatives', answerable_by: 'shopper-agent' }
                                            ]
                                        }
                                    }
                                ]
                            })
                        ),
                    20
                );
            }, 20);
            return json({ conversationEntries: [{ id: body.message.id }] });
        }
        throw new Error('Unexpected fixture request: ' + url);
    };
    state.handoffs = [];
    document.addEventListener('inline-agent-widget:handoff', (event) => state.handoffs.push(event.detail));
    if (params.get('disabled') === 'true') return;
    const el = document.createElement('inline-agent-widget');
    el.setAttribute('product-id-param', 'pid');
    el.setAttribute('mode', mode);
    el.setAttribute('scrt2-url', 'https://fixture.invalid');
    el.setAttribute('org-id', 'fixture-org');
    el.setAttribute('es-developer-name', 'fixture-agent');
    el.setAttribute('product-name', params.get('product') === 'alta' ? 'TrailFit Alta' : 'TrailFit Charge 2');
    el.setAttribute('pdp-questions', JSON.stringify(['Can I swap out the band?', 'How long does the battery last?']));
    if (params.get('warm') === 'true') el.setAttribute('pre-warm', '');
    document.querySelector('#mount').appendChild(el);
})();
