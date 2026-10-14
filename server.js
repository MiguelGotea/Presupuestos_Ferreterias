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
  // Cloudflare de fetesa.com.ni usa JS Challenge.
  // Estrategia: obtener cf_clearance real con headless Chrome (fetesa-cf.js),
  // luego reutilizar ese cookie con curl para las peticiones API.
  if (pathname.startsWith('/api/fetesa/')) {
    const { spawn }  = require('child_process');
    const fetesaCf   = (() => { try { return require('./fetesa-cf'); } catch(_) { return null; } })();

    const targetPath = pathname.replace('/api/fetesa', '') || '/';
    const targetUrl  = 'https://fetesa.com.ni' + targetPath + (url.search || '');

    const UAS = [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ];
    const ua = UAS[Math.floor(Date.now() / 60000) % UAS.length];

    async function doFetch(cookie) {
      return new Promise((resolve, reject) => {
        const curlArgs = [
          '--silent', '--location', '--max-redirs', '5',
          '--compressed', '--max-time', '15', '--include',
          '--header', `User-Agent: ${ua}`,
          '--header', 'Accept: application/json, */*;q=0.8',
          '--header', 'Accept-Language: es-NI,es;q=0.9',
          '--header', 'Referer: https://fetesa.com.ni/',
          '--header', 'sec-fetch-dest: empty',
          '--header', 'sec-fetch-mode: cors',
          '--header', 'sec-fetch-site: same-origin',
          ...(cookie ? ['--header', `Cookie: ${cookie}`] : []),
          targetUrl
        ];

        const curl = spawn('curl', curlArgs);
        const chunks = [];
        curl.stdout.on('data', d => chunks.push(d));
        curl.stderr.on('data', () => {});
        curl.on('error', reject);
        curl.on('close', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          // Parsear bloques de headers/body del --include
          const parts = raw.split(/\r?\n\r?\n/);
          let headerBlock = '', body = '', lastHeaderIdx = -1;
          for (let i = 0; i < parts.length; i++) {
            if (/^HTTP\//i.test(parts[i].trimStart())) lastHeaderIdx = i;
          }
          if (lastHeaderIdx >= 0) {
            headerBlock = parts[lastHeaderIdx];
            body = parts.slice(lastHeaderIdx + 1).join('\n\n').trim();
          } else {
            body = raw.trim();
          }
          const statusMatch = headerBlock.match(/^HTTP\/\S+\s+(\d+)/m);
          const status = statusMatch ? parseInt(statusMatch[1]) : 200;
          const totalMatch  = headerBlock.match(/^x-wp-total:\s*(\d+)/im);
          const totalpMatch = headerBlock.match(/^x-wp-totalpages:\s*(\d+)/im);
          resolve({
            status, body,
            wpTotal:      totalMatch  ? totalMatch[1]  : null,
            wpTotalPages: totalpMatch ? totalpMatch[1] : null,
            isHtml: body.trimStart().startsWith('<'),
          });
        });
      });
    }

    function sendResult({ status, body, wpTotal, wpTotalPages }) {
      const outHeaders = {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'X-WP-Total, X-WP-TotalPages',
      };
      if (wpTotal)      outHeaders['x-wp-total']      = wpTotal;
      if (wpTotalPages) outHeaders['x-wp-totalpages'] = wpTotalPages;
      res.writeHead(status === 403 ? 403 : 200, outHeaders);
      res.end(body, 'utf8');
    }

    function sendError(msg) {
      if (res.headersSent) return;
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ error: 'FETESA_CF', message: msg }));
    }

    (async () => {
      try {
        if (!fetesaCf) {
          // puppeteer no instalado — intentar sin cookie primero
          const result = await doFetch(null);
          if (!result.isHtml && result.status !== 403) return sendResult(result);
          return sendError(
            'Cloudflare bloquea fetesa.com.ni. Instala puppeteer en el servidor:\n' +
            'npm install puppeteer-core && apt-get install -y chromium-browser'
          );
        }

        // Obtener cf_clearance (del cache o renovando con Chrome)
        let cookie;
        try {
          cookie = await fetesaCf.getCfCookie();
        } catch(e) {
          return sendError('No se pudo obtener cookie CF: ' + e.message);
        }

        // Primera petición con el cookie
        let result = await doFetch(cookie);

        // Si la respuesta sigue siendo HTML (CF challenge), invalidar y reintentar
        if (result.isHtml || result.status === 403) {
          console.log('[fetesa] Cookie CF expirado, renovando...');
          fetesaCf.invalidateCfCache();
          try { cookie = await fetesaCf.getCfCookie(); } catch(e) {
            return sendError('Renovación de cookie CF falló: ' + e.message);
          }
          result = await doFetch(cookie);
        }

        if (result.isHtml) {
          return sendError('Fetesa devuelve página HTML (CF challenge activo).');
        }

        sendResult(result);
      } catch(e) {
        sendError(e.message);
      }
    })();

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
