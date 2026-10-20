import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/data.js', ['data.js', 'text/javascript; charset=utf-8']],
  ['/services/firebase.js', ['services/firebase.js', 'text/javascript; charset=utf-8']],
  ['/services/firebase-config.js', ['services/firebase-config.js', 'text/javascript; charset=utf-8']],
  ['/services/libras.js', ['services/libras.js', 'text/javascript; charset=utf-8']],
]);

createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  const file = publicFiles.get(pathname);
  if (!file) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado'); return; }
  try {
    const body = await readFile(path.join(root, file[0]));
    response.writeHead(200, { 'Content-Type': file[1], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não foi possível carregar o site.');
  }
}).listen(Number(process.env.PORT || 4173), '127.0.0.1', () => {
  console.log(`CONecta V2 disponível em http://127.0.0.1:${process.env.PORT || 4173}`);
});
