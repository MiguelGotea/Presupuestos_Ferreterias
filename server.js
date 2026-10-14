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

  // ── Proxy HTML Fetesa (/api/fetesa/*) ──────────────────────────────────────
  // Fetesa es WooCommerce con Cloudflare; hacemos proxy con headers completos
  // y seguimos redirects manualmente (Node no los sigue solo).
  if (pathname.startsWith('/api/fetesa/')) {
    const targetPath = pathname.replace('/api/fetesa', '') || '/';
    const fullTarget = targetPath + (url.search || '');

    // Rotar User-Agents para evitar bloqueos
    const UAS = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ];
    const ua = UAS[Math.floor(Math.random() * UAS.length)];

    function doFetesaRequest(host, requestPath, redirectCount, clientCookies) {
      if (redirectCount > 5) {
        res.writeHead(502);
        return res.end(JSON.stringify({ error: 'Demasiados redirects' }));
      }

      const opts = {
        host,
        path: requestPath,
        method: 'GET',
        timeout: 15000,
        headers: {
          'host': 'fetesa.com.ni',
          'accept': 'application/json, text/html, */*;q=0.8',
          'accept-language': 'es-NI,es;q=0.9,en-US;q=0.8,en;q=0.7',
          'accept-encoding': 'gzip, deflate, br',
          'user-agent': ua,
          'referer': 'https://fetesa.com.ni/',
          'connection': 'keep-alive',
          'cache-control': 'no-cache',
          'pragma': 'no-cache',
          'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'upgrade-insecure-requests': '1',
          ...(clientCookies ? { 'cookie': clientCookies } : {})
        }
      };

      const proxy = https.request(opts, (up) => {
        // Seguir redirects 301/302/307/308
        if ([301, 302, 307, 308].includes(up.statusCode) && up.headers['location']) {
          up.resume(); // consumir body para liberar conexión
          let loc = up.headers['location'];
          // Recoger cookies del redirect para la siguiente petición
          const setCookie = up.headers['set-cookie'];
          const newCookies = setCookie ? setCookie.map(c => c.split(';')[0]).join('; ') : clientCookies;
          // Resolver URL relativa vs absoluta
          if (loc.startsWith('/')) {
            return doFetesaRequest('fetesa.com.ni', loc, redirectCount + 1, newCookies);
          } else if (loc.startsWith('http')) {
            try {
              const u = new URL(loc);
              return doFetesaRequest(u.hostname, u.pathname + u.search, redirectCount + 1, newCookies);
            } catch(_) {}
          }
        }

        // Si sigue siendo 403, devolver JSON con mensaje claro
        if (up.statusCode === 403) {
          up.resume();
          res.writeHead(403, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          return res.end(JSON.stringify({
            error: 'FETESA_BLOCKED',
            message: 'fetesa.com.ni bloqueó la petición (WAF/Cloudflare). Intenta de nuevo en unos segundos.'
          }));
        }

        // Descomprimir gzip/br si es necesario
        const zlib = require('zlib');
        const encoding = up.headers['content-encoding'];
        const respHeaders = {
          'content-type':       up.headers['content-type'] || 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'X-WP-Total, X-WP-TotalPages'
        };
        // Pasar totales de paginación de WooCommerce Store API al cliente
        if (up.headers['x-wp-total'])      respHeaders['x-wp-total']       = up.headers['x-wp-total'];
        if (up.headers['x-wp-totalpages']) respHeaders['x-wp-totalpages']  = up.headers['x-wp-totalpages'];
        res.writeHead(up.statusCode, respHeaders);


        if (encoding === 'gzip') {
          up.pipe(zlib.createGunzip()).pipe(res);
        } else if (encoding === 'br') {
          up.pipe(zlib.createBrotliDecompress()).pipe(res);
        } else if (encoding === 'deflate') {
          up.pipe(zlib.createInflate()).pipe(res);
        } else {
          up.pipe(res);
        }
      });

      proxy.on('timeout', () => {
        proxy.destroy();
        if (!res.headersSent) {
          res.writeHead(504, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Timeout conectando a fetesa.com.ni' }));
        }
      });

      proxy.on('error', (e) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      proxy.end();
    }

    doFetesaRequest('fetesa.com.ni', fullTarget, 0, null);
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
