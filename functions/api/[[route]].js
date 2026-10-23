import { createD1Adapter } from '../../src/db/dbAdapter.js';
import { handleApiRequest } from '../../src/routes/router.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const WORKER_ORIGIN = 'https://anti-broke-finance-app.mr-haibaoseal.workers.dev';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const d1 = env?.DB || env?.anti_broke_finance_db;
  if (!d1) {
    // 若 Pages 未直接綁定 D1，自動代理至已綁定同顆 D1 的正式 Worker，確保雙網址資料 100% 同步
    const url = new URL(request.url);
    const targetUrl = `${WORKER_ORIGIN}${url.pathname}${url.search}`;
    const proxyReq = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method.toUpperCase()) ? undefined : await request.text()
    });
    return await fetch(proxyReq);
  }

  try {
    const url = new URL(request.url);
    let body = {};
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) {
      const raw = await request.text();
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch (_) {
          body = { raw_text: raw };
        }
      }
    }
    const db = createD1Adapter(d1);
    const result = await handleApiRequest(db, request.method, url.pathname, body, url.searchParams);
    return new Response(JSON.stringify(result.data), {
      status: result.status || 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err?.message || 'Cloudflare Pages Function 錯誤' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }
}
