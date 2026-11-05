// Test-only helper: Supabase's gateway serves PostgREST under /rest/v1. A bare local PostgREST does not, so this
// 20-line proxy maps /rest/v1/* -> /* so the real SupabaseStore code path can be exercised without the Supabase CLI/Docker.
//   node supabase/tests/postgrest-proxy.mjs [listenPort=3112] [postgrestPort=3111]
import http from 'node:http';
const [listen = 3112, target = 3111] = process.argv.slice(2).map(Number);
http.createServer((req, res) => {
  const path = req.url.replace(/^\/rest\/v1/, '') || '/';
  const up = http.request({ host: '127.0.0.1', port: target, path, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}).listen(listen, '127.0.0.1', () => console.log(`proxy :${listen} -> :${target}`));
