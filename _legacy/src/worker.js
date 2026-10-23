import { connect } from 'cloudflare:sockets';
import cloudState from './db/cloudState.js';

globalThis.__cfSocketConnect = connect;

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
      let assetRes;
      if (url.pathname === '/shift-pay' || url.pathname === '/shift-pay/') {
        assetRes = await env.ASSETS.fetch(new Request(new URL('/shift-pay.html', request.url), request));
      } else {
        assetRes = await env.ASSETS.fetch(request);
        if (assetRes.status === 404 && request.method === 'GET') {
          assetRes = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
        }
      }
      const headers = new Headers(assetRes.headers);
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return new Response(assetRes.body, {
        status: assetRes.status,
        statusText: assetRes.statusText,
        headers
      });
    }

    return new Response('Not Found', { status: 404 });
  },

  async email(message, env) {
    try {
      const rawEmail = await new Response(message.raw).text();
      const fakeReq = new Request('https://localhost/api/notifications/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'cloudflare_email_routing_auto',
          emailUid: message.headers.get('message-id') || undefined,
          rawEmail
        })
      });
      await cloudState.handleCloudflareApiRequest(fakeReq, env);
    } catch (err) {
      console.error('[Cloudflare Email Auto-Parse Error]', err);
    }
  }
};
