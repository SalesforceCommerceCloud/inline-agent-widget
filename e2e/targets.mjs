import { readFileSync } from 'node:fs';

const products = [
    { slug: 'trailfit-charge-2-500500.html', id: '500500', name: 'TrailFit Charge 2' },
    { slug: 'trailfit-alta-500400.html', id: '500400', name: 'TrailFit Alta' }
];
const nto = (id, origin, prefix) => ({
    id,
    origin,
    widgetSelector: 'inline-agent-widget[data-iaw-pdp]',
    placementSelector: '.carousel-container, .primary-images',
    pdps: products.map(({ slug, ...product }) => ({ ...product, path: prefix + slug }))
});
export const targets = {
    zyss: nto('zyss-001', 'https://zyss-001.unified.demandware.net', '/s/nto/default/')
};

export function validateTarget(input) {
    if (!input || typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id))
        throw new Error('TARGET_CONFIG: invalid id');
    const url = new URL(input.origin);
    if (url.protocol !== 'https:' || url.origin !== input.origin || url.username || url.password) {
        throw new Error('TARGET_CONFIG: origin must be an HTTPS origin without credentials, path or query');
    }
    for (const field of ['widgetSelector', 'placementSelector']) {
        if (typeof input[field] !== 'string' || !input[field].trim()) {
            throw new Error('TARGET_CONFIG: missing ' + field);
        }
    }
    if (!Array.isArray(input.pdps) || input.pdps.length < 2) {
        throw new Error('TARGET_CONFIG: configure at least two reference PDPs');
    }
    const pdps = input.pdps.map(({ id, name, path }) => {
        if (![id, name, path].every((value) => typeof value === 'string' && value.trim())) {
            throw new Error('TARGET_CONFIG: PDP id, name and path are required');
        }
        if (!path.startsWith('/') || path.startsWith('//') || new URL(path, url).origin !== url.origin) {
            throw new Error('TARGET_CONFIG: PDP path must stay on the selected origin');
        }
        return { id, name, path };
    });
    return {
        id: input.id,
        origin: url.origin,
        widgetSelector: input.widgetSelector,
        placementSelector: input.placementSelector,
        pdps
    };
}

export function loadTarget(env = process.env) {
    if (env.WIDGET_TARGET && env.WIDGET_TARGET_FILE) throw new Error('TARGET_CONFIG: choose WIDGET_TARGET or WIDGET_TARGET_FILE');
    const selected = env.WIDGET_TARGET_FILE
        ? JSON.parse(readFileSync(env.WIDGET_TARGET_FILE, 'utf8'))
        : targets[env.WIDGET_TARGET || 'zyss'];
    if (!selected) throw new Error('TARGET_CONFIG: unknown WIDGET_TARGET');
    return validateTarget(selected);
}
