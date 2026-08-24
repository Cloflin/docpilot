// The embedding half. Same shape as chat.js and separate for the same reason the
// contract lists two routes rather than one prefix: `/ai/v1/embeddings` is the
// only other path the browser is allowed to reach, and one handler switching on
// the URL would be a handler that can send embeddings to the chat endpoint.
import {proxy} from '../../lib/ai-proxy.js'

export default {fetch: (request) => proxy(request, '/v1/embeddings')}
