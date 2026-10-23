/**
 * 標準 REST API Client (彻底廢除舊版 _clientState 整包資料庫快照同步)
 */
export async function apiCall(path, method = 'GET', body = null) {
  const opts = {
    method: method.toUpperCase(),
    headers: { 'Content-Type': 'application/json' }
  };
  if (body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(opts.method)) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || 'API 請求處理失敗');
  }
  return data;
}
