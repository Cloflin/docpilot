// The chat half of the `/ai` proxy. `vercel.json` rewrites the one literal path
// `proxyContract()` names — `/ai/v1/chat/completions` — to this file, and the
// upstream path is written out here rather than derived from the request: a path
// this handler computes is a path it can compute wrongly, which is the drift the
// contract's own comment in src/config.js records as a production 404 on every
// question. `export default {fetch}` takes every method so the 405 is ours.
import {proxy} from '../../lib/ai-proxy.js'

export default {fetch: (request) => proxy(request, '/v1/chat/completions')}
