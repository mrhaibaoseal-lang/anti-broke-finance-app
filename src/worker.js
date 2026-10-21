import cloudState from './db/cloudState.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        const result = await cloudState.handleCloudflareApiRequest(request, env);
        return new Response(JSON.stringify(result.data), {
          status: result.status || 200,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json; charset=utf-8'
          }
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: err?.message || 'Cloudflare Worker API 處理錯誤' }),
          {
            status: 400,
            headers: {
              ...CORS_HEADERS,
              'Content-Type': 'application/json; charset=utf-8'
            }
          }
        );
      }
    }

    if (env && env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status === 404 && request.method === 'GET') {
        return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
      }
      return assetRes;
    }

    return new Response('Not Found', { status: 404 });
  }
};
