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

  // ── Proxy Fetesa via curl (/api/fetesa/*) ─────────────────────────────────
  // Node.js https tiene firma TLS (JA3) que Cloudflare detecta como bot → 403.
  // curl tiene firma TLS diferente y suele pasar el WAF sin problemas.
  // Usamos --include para capturar headers de respuesta (X-WP-Total, etc.).
  if (pathname.startsWith('/api/fetesa/')) {
    const { spawn } = require('child_process');
    const targetPath = pathname.replace('/api/fetesa', '') || '/';
    const targetUrl  = 'https://fetesa.com.ni' + targetPath + (url.search || '');

    const UAS = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ];
    const ua = UAS[Math.floor(Math.random() * UAS.length)];

    const curlArgs = [
      '--silent',
      '--location',           // seguir redirects
      '--max-redirs', '5',
      '--compressed',         // descomprimir gzip/br automáticamente
      '--max-time', '15',
      '--include',            // incluir headers de respuesta en stdout
      '--header', `User-Agent: ${ua}`,
      '--header', 'Accept: application/json, */*;q=0.8',
      '--header', 'Accept-Language: es-NI,es;q=0.9,en-US;q=0.8',
      '--header', 'Referer: https://fetesa.com.ni/',
      '--header', 'sec-fetch-dest: empty',
      '--header', 'sec-fetch-mode: cors',
      '--header', 'sec-fetch-site: same-origin',
      '--header', 'Cache-Control: no-cache',
      targetUrl
    ];

    const curl = spawn('curl', curlArgs);
    const chunks = [];
    curl.stdout.on('data', d => chunks.push(d));
    curl.stderr.on('data', () => {}); // ignorar stderr de curl

    curl.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'curl no disponible: ' + e.message }));
      }
    });

    curl.on('close', () => {
      if (res.headersSent) return;
      const raw = Buffer.concat(chunks).toString('utf8');

      // Parsear headers y body: curl --include produce:
      // HTTP/1.1 200 OK\r\nHeader: val\r\n...\r\n\r\n[body]
      // Con redirects puede haber múltiples bloques de headers → tomar el último.
      const parts = raw.split(/\r?\n\r?\n/);
      let headerBlock = '', body = '';
      // El body es lo que viene después del último bloque de headers HTTP
      let lastHeaderIdx = -1;
      for (let i = 0; i < parts.length; i++) {
        if (/^HTTP\//i.test(parts[i].trimStart())) lastHeaderIdx = i;
      }
      if (lastHeaderIdx >= 0) {
        headerBlock = parts[lastHeaderIdx];
        body = parts.slice(lastHeaderIdx + 1).join('\n\n');
      } else {
        body = raw;
      }

      // Leer status code del bloque de headers
      const statusMatch = headerBlock.match(/^HTTP\/\S+\s+(\d+)/m);
      const status = statusMatch ? parseInt(statusMatch[1]) : 200;

      // Leer X-WP-Total si existe
      const totalMatch    = headerBlock.match(/^x-wp-total:\s*(\d+)/im);
      const totalpMatch   = headerBlock.match(/^x-wp-totalpages:\s*(\d+)/im);
      const wpTotal       = totalMatch   ? totalMatch[1]  : null;
      const wpTotalPages  = totalpMatch  ? totalpMatch[1] : null;

      if (status === 403 || status === 429) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({
          error: 'FETESA_BLOCKED',
          message: 'fetesa.com.ni bloqueó la petición. Intenta de nuevo en unos segundos.'
        }));
      }

      const outHeaders = {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'X-WP-Total, X-WP-TotalPages'
      };
      if (wpTotal)      outHeaders['x-wp-total']      = wpTotal;
      if (wpTotalPages) outHeaders['x-wp-totalpages'] = wpTotalPages;

      res.writeHead(200, outHeaders);
      res.end(body.trim(), 'utf8');
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
