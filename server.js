// server.js — Presupuestos Ferreterías
// Sirve archivos estáticos y hace proxy a las APIs externas de cada ferretería.
// Uso: node server.js  →  http://localhost:3001

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3001;

// ── Configuración de APIs por ferretería ────────────────────────────────────
const FERRETERIAS_API = {
  sinsa: 'www.sinsa.com.ni'
};

// ── Rutas de archivos estáticos y tipos MIME ────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/svg+xml',
  '.png':  'image/png',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8'
};

const STATIC_ROUTES = {
  '/':                                           'index.html',
  '/index.html':                                 'index.html',
  '/favicon.ico':                                'favicon.svg',
  '/favicon.svg':                                'favicon.svg',
  '/favicon-sinsa.svg':                          'favicon-sinsa.svg',
  '/ferreterias/sinsa/sinsa-presupuestos.html':  'ferreterias/sinsa/sinsa-presupuestos.html',
  '/ferreterias/sinsa/sinsa-descuentos.html':    'ferreterias/sinsa/sinsa-descuentos.html',
};

http.createServer((req, res) => {
  const url      = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // ── Proxy API Sinsa (/api/sinsa/*) ────────────────────────────────────────
  if (pathname.startsWith('/api/sinsa/')) {
    const apiPath = pathname.replace('/api/sinsa', '/api');
    const proxy = https.request(
      {
        host: FERRETERIAS_API.sinsa,
        path: apiPath + (url.search || ''),
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'user-agent': 'Mozilla/5.0 presupuestos-ferreterias'
        }
      },
      (up) => {
        res.writeHead(up.statusCode, {
          'content-type': up.headers['content-type'] || 'application/json',
          'access-control-allow-origin': '*'
        });
        up.pipe(res);
      }
    );
    proxy.on('error', (e) => {
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    });
    proxy.end();
    return;
  }

  // ── Archivos estáticos ────────────────────────────────────────────────────
  const file = STATIC_ROUTES[pathname];

  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404 - Página no encontrada');
  }

  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Archivo no encontrado: ' + file);
    }
    const ext = path.extname(file).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': contentType });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log('');
  console.log('  🏗️  Presupuestos Ferreterías — servidor listo');
  console.log('  ─────────────────────────────────────────────');
  console.log('  Landing:            http://localhost:' + PORT + '/');
  console.log('  Sinsa presupuestos: http://localhost:' + PORT + '/ferreterias/sinsa/sinsa-presupuestos.html');
  console.log('  Sinsa descuentos:   http://localhost:' + PORT + '/ferreterias/sinsa/sinsa-descuentos.html');
  console.log('');
});
