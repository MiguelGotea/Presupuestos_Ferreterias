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
  sinsa:  'www.sinsa.com.ni',
  fetesa: 'fetesa.com.ni'
};

// ── Tipos MIME permitidos ───────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/svg+xml',
  '.png':  'image/png',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8'
};

// ── Redirecciones / Retrocompatibilidad ─────────────────────────────────────
const REDIRECTS = {
  '/ferreterias/sinsa/sinsa-presupuestos.html': '/ferreterias/sinsa/presupuestos/',
  '/ferreterias/sinsa/sinsa-descuentos.html':   '/ferreterias/sinsa/descuentos/',
  '/ferreterias/sinsa/presupuestos':            '/ferreterias/sinsa/presupuestos/',
  '/ferreterias/sinsa/descuentos':              '/ferreterias/sinsa/descuentos/',
  '/ferreterias/fetesa/presupuestos':           '/ferreterias/fetesa/presupuestos/'
};

// ── Alias específicos de rutas estáticas ────────────────────────────────────
const ALIASES = {
  '/':                   'index.html',
  '/index.html':         'index.html',
  '/favicon.ico':        'favicon.svg',
  '/favicon.svg':        'favicon.svg',
  '/favicon-sinsa.svg':  'favicon-sinsa.svg'
};

http.createServer((req, res) => {
  const url      = new URL(req.url, `http://localhost`);
  const pathname = decodeURIComponent(url.pathname);

  // ── Redirecciones ─────────────────────────────────────────────────────────
  if (REDIRECTS[pathname]) {
    res.writeHead(301, { 'Location': REDIRECTS[pathname] });
    return res.end();
  }

  // ── Proxy Fetesa (/api/fetesa/*) ──────────────────────────────────────────
  // fetesa-cf.js mantiene una sesión Chrome persistente y usa page.evaluate()
  // para hacer fetch() dentro del contexto del browser — mismo TLS, mismas cookies CF.
  if (pathname.startsWith('/api/fetesa/')) {
    const fetesaCf = (() => { try { return require('./fetesa-cf'); } catch(_) { return null; } })();

    if (!fetesaCf) {
      res.writeHead(503, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ error: 'FETESA_CF', message: 'fetesa-cf.js no disponible' }));
    }

    const targetPath = pathname.replace('/api/fetesa', '') || '/';
    const targetUrl  = 'https://fetesa.com.ni' + targetPath + (url.search || '');

    fetesaCf.fetesaFetch(targetUrl).then(result => {
      if (result.error) {
        res.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({ error: 'FETESA_FETCH', message: result.error }));
      }
      const outHeaders = {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'X-WP-Total, X-WP-TotalPages',
      };
      if (result.xTotal)      outHeaders['x-wp-total']      = result.xTotal;
      if (result.xTotalPages) outHeaders['x-wp-totalpages'] = result.xTotalPages;
      res.writeHead(result.ok ? 200 : result.status, outHeaders);
      res.end(result.text, 'utf8');
    }).catch(e => {
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ error: 'FETESA_CF', message: e.message }));
      }
    });

    return;
  }


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
  let relPath = ALIASES[pathname] || pathname.replace(/^\/+/, '');
  let fullPath = path.resolve(__dirname, relPath);

  // Seguridad: evitar directory traversal
  if (!fullPath.startsWith(__dirname)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('403 - Acceso denegado');
  }

  fs.stat(fullPath, (err, stats) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 - Archivo no encontrado');
    }

    if (stats.isDirectory()) {
      fullPath = path.join(fullPath, 'index.html');
    }

    fs.readFile(fullPath, (err2, data) => {
      if (err2) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('404 - Archivo no encontrado');
      }
      const ext = path.extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': contentType });
      res.end(data);
    });
  });

}).listen(PORT, () => {
  console.log('');
  console.log('  🏗️  Presupuestos Ferreterías — servidor listo');
  console.log('  ─────────────────────────────────────────────');
  console.log('  Landing:            http://localhost:' + PORT + '/');
  console.log('  Sinsa presupuestos:  http://localhost:' + PORT + '/ferreterias/sinsa/presupuestos/');
  console.log('  Sinsa descuentos:    http://localhost:' + PORT + '/ferreterias/sinsa/descuentos/');
  console.log('  Fetesa presupuestos: http://localhost:' + PORT + '/ferreterias/fetesa/presupuestos/');
  console.log('');
});
