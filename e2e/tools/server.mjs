import http from 'node:http';
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const assets = new Map([
    ['/widget.js', [await readFile(new URL('../../dist/inline-agent-widget.umd.js', import.meta.url)), 'text/javascript']],
    ['/fixture.js', [await readFile(new URL('support/browser-fixture.mjs', root)), 'text/javascript']]
]);
http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:43132');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/health') return res.end('ready');
    const asset = assets.get(url.pathname);
    if (asset) {
        res.setHeader('Content-Type', asset[1]);
        return res.end(asset[0]);
    }
    if (url.pathname !== '/pdp') { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px;font-family:Arial}main{max-width:1000px}inline-agent-widget{display:block;width:100%}</style></head><body><main><h1>TrailFit Charge 2</h1><div id="mount"></div></main><script src="/fixture.js"></script><script src="/widget.js" defer></script></body></html>`);
}).listen(43132, '127.0.0.1');
