import cloudState from '../../src/db/cloudState.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

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
      JSON.stringify({ ok: false, error: err?.message || 'Cloudflare Pages Function 處理錯誤' }),
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
