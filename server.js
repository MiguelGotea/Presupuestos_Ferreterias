// server.js — Presupuestos Ferreterías
// Sirve archivos estáticos y hace proxy a la API de Sinsa.
// Uso: node server.js  →  http://localhost:3002

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3002;

// ── Exploración de descuentos Walmart ──────────────────────────────────────
// La colección 1040 es el catálogo completo publicado por Walmart. Se recorre
// una vez en el VPS y se conserva sólo el subconjunto que realmente tiene
// ListPrice > Price; así la página de promociones no depende de colecciones
// editoriales como "Rebajas" ni hace cientos de consultas por cada visitante.
const WALMART_CATALOG_COLLECTION = '1040';
const WALMART_PAGE_SIZE = 50;
const WALMART_MAX_CATEGORY_SEGMENT = 2500;
const walmartPromotions = {
  items: [], total: 0, scanned: 0, running: false, completedAt: null, error: null
};

function walmartCatalogPage(categoryPath, from) {
  return new Promise((resolve, reject) => {
    const request = https.get({
      host: 'www.walmart.com.ni',
      path: `/api/catalog_system/pub/products/search?fq=H:${WALMART_CATALOG_COLLECTION}&fq=C:/${categoryPath}/&_from=${from}&_to=${from + WALMART_PAGE_SIZE - 1}`,
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 presupuestos-ferreterias' }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`Walmart respondió HTTP ${response.statusCode}`));
        }
        try {
          const resources = String(response.headers.resources || '');
          const total = Number(resources.split('/')[1]) || 0;
          resolve({ products: JSON.parse(body), total });
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('Tiempo de espera agotado al consultar Walmart')));
    request.on('error', reject);
  });
}

async function walmartCatalogPageWithRetry(categoryPath, from, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await walmartCatalogPage(categoryPath, from);
    } catch (error) {
      lastError = error;
      // Walmart/CloudFront puede responder 400 temporalmente después de una
      // secuencia sostenida. Se respeta una pausa creciente antes de volver a
      // pedir exactamente la misma página, sin descartar el avance previo.
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 3000));
    }
  }
  throw lastError;
}

function walmartPromotionCategories() {
  return new Promise((resolve, reject) => {
    const request = https.get({
      host: 'www.walmart.com.ni',
      path: `/api/catalog_system/pub/facets/search?fq=H:${WALMART_CATALOG_COLLECTION}`,
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 presupuestos-ferreterias' }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`Walmart respondió HTTP ${response.statusCode} al leer categorías`));
        try {
          const splitLargeCategory = (category, parentPath = '') => {
            const children = category.Children || [];
            const categoryPath = parentPath ? `${parentPath}/${category.Id}` : String(category.Id);
            if (Number(category.Quantity || 0) <= WALMART_MAX_CATEGORY_SEGMENT || !children.length) {
              return [{ path: categoryPath, name: category.Name, quantity: Number(category.Quantity || 0) }];
            }
            return children.flatMap(child => splitLargeCategory(child, categoryPath));
          };
          // No pasar splitLargeCategory directamente a flatMap: éste también
          // entrega el índice como segundo argumento, que se interpretaría por
          // error como parte de la ruta jerárquica de la categoría.
          resolve((JSON.parse(body).CategoriesTrees || []).flatMap(category => splitLargeCategory(category)));
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('Tiempo de espera agotado al leer categorías Walmart')));
    request.on('error', reject);
  });
}

function compactDiscountProduct(product) {
  const discountedItems = (product.items || []).filter(item => {
    const offer = item.sellers?.[0]?.commertialOffer || {};
    return Number(offer.ListPrice || 0) > Number(offer.Price || 0);
  }).map(item => ({
    itemId: item.itemId, name: item.name, nameComplete: item.nameComplete, ean: item.ean,
    referenceId: item.referenceId, measurementUnit: item.measurementUnit, unitMultiplier: item.unitMultiplier,
    images: item.images,
    sellers: (item.sellers || []).slice(0, 1).map(seller => {
      const offer = seller.commertialOffer || {};
      // No conservar cuotas, SLA, objetos de checkout ni metadatos extensos.
      // El modal sólo necesita estos campos de oferta publicados.
      return {
        sellerId: seller.sellerId,
        sellerName: seller.sellerName,
        commertialOffer: {
          Price: offer.Price,
          ListPrice: offer.ListPrice,
          PriceWithoutDiscount: offer.PriceWithoutDiscount,
          FullSellingPrice: offer.FullSellingPrice,
          PriceValidUntil: offer.PriceValidUntil,
          IsAvailable: offer.IsAvailable,
          AvailableQuantity: offer.AvailableQuantity,
          Teasers: offer.Teasers,
          PromotionTeasers: offer.PromotionTeasers
        }
      };
    })
  }));
  if (!discountedItems.length) return null;
  return {
    productId: product.productId, productName: product.productName, brand: product.brand,
    productReference: product.productReference, categories: product.categories, description: product.description,
    link: product.link, productClusters: product.productClusters, items: discountedItems
  };
}

async function scanWalmartPromotions() {
  if (walmartPromotions.running) return;
  walmartPromotions.items = [];
  walmartPromotions.total = 0;
  walmartPromotions.scanned = 0;
  walmartPromotions.error = null;
  walmartPromotions.completedAt = null;
  walmartPromotions.running = true;
  const seen = new Set();
  try {
    // VTEX rechaza páginas después de la posición 2,549. Se toma el árbol de
    // categorías y sólo se subdividen las categorías que superan ese límite.
    const categories = await walmartPromotionCategories();
    walmartPromotions.total = categories.reduce((sum, category) => sum + category.quantity, 0);
    for (const category of categories) {
      let categoryScanned = 0;
      for (let from = 0; from < category.quantity; from += WALMART_PAGE_SIZE) {
        const page = await walmartCatalogPageWithRetry(category.path, from);
        walmartPromotions.scanned += page.products.length;
        categoryScanned += page.products.length;
        for (const source of page.products) {
          const product = compactDiscountProduct(source);
          if (!product) continue;
          product.items = product.items.filter(item => {
            const key = `${product.productId}-${item.itemId}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          // Un registro por SKU: permite paginar promociones sin separar las
          // variantes de un mismo producto en el navegador.
          for (const item of product.items) {
            walmartPromotions.items.push({ ...product, items: [item] });
          }
        }
        if (page.products.length < WALMART_PAGE_SIZE) break;
        // Cadencia deliberadamente moderada: es una exploración de fondo, no
        // una búsqueda interactiva, y evita activar límites del catálogo VTEX.
        await new Promise(resolve => setTimeout(resolve, 450));
      }
      // Evita declarar terminado un catálogo si una ruta inválida o una
      // respuesta inesperada dejó una categoría publicada sin explorar.
      if (category.quantity > 0 && categoryScanned === 0) {
        throw new Error(`La categoría Walmart "${category.name}" no devolvió productos`);
      }
    }
    walmartPromotions.completedAt = new Date().toISOString();
  } catch (error) {
    walmartPromotions.error = error.message;
  } finally {
    walmartPromotions.running = false;
  }
}

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
  '/ferreterias/fetesa/presupuestos':           '/ferreterias/fetesa/presupuestos/',
  '/ferreterias/fetesa/descuentos':             '/ferreterias/fetesa/descuentos/',
  '/ferreterias/elhalcon/presupuestos':         '/ferreterias/elhalcon/presupuestos/',
  '/ferreterias/elhalcon/descuentos':           '/ferreterias/elhalcon/descuentos/',
  '/ferreterias/pricesmart/presupuestos':       '/ferreterias/pricesmart/presupuestos/',
  '/ferreterias/pricesmart/descuentos':         '/ferreterias/pricesmart/descuentos/',
  '/ferreterias/walmart/presupuestos':          '/ferreterias/walmart/presupuestos/',
  '/ferreterias/walmart/descuentos':            '/ferreterias/walmart/descuentos/',
};

// ── Alias específicos de rutas estáticas ────────────────────────────────────
const ALIASES = {
  '/':                  'index.html',
  '/index.html':        'index.html',
  '/favicon.ico':       'favicon.svg',
  '/favicon.svg':       'favicon.svg',
  '/favicon-sinsa.svg': 'favicon-sinsa.svg'
};

http.createServer((req, res) => {
  const url      = new URL(req.url, `http://localhost`);
  const pathname = decodeURIComponent(url.pathname);

  // ── Redirecciones ─────────────────────────────────────────────────────────
  if (REDIRECTS[pathname]) {
    res.writeHead(301, { 'Location': REDIRECTS[pathname] });
    return res.end();
  }

  // ── Proxy API Sinsa (/api/sinsa/*) ────────────────────────────────────────
  if (pathname.startsWith('/api/sinsa/')) {
    const apiPath = pathname.replace('/api/sinsa', '/api');
    const proxy = https.request(
      {
        host: 'www.sinsa.com.ni',
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

  // ── Proxy API El Halcón (/api/elhalcon/*) ─────────────────────────────────
  if (pathname.startsWith('/api/elhalcon/')) {
    const apiPath = pathname.replace('/api/elhalcon', '');
    const proxy = https.request(
      {
        host: 'elhalcon.com.ni',
        path: apiPath + (url.search || ''),
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'user-agent': 'Mozilla/5.0 presupuestos-ferreterias'
        }
      },
      (up) => {
        // Reenviar también X-WP-Total para la paginación
        const headers = {
          'content-type': up.headers['content-type'] || 'application/json',
          'access-control-allow-origin': '*'
        };
        if (up.headers['x-wp-total'])       headers['x-wp-total']        = up.headers['x-wp-total'];
        if (up.headers['x-wp-totalpages'])   headers['x-wp-totalpages']   = up.headers['x-wp-totalpages'];
        res.writeHead(up.statusCode, headers);
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

  // ── Descuentos reales de todo el catálogo Walmart ─────────────────────────
  // Devuelve el cache vivo mientras el VPS recorre el catálogo completo. No se
  // basa en la colección editorial de "Rebajas"; compara precio de lista vs.
  // precio actual para cada SKU.
  if (pathname === '/api/walmart/promotions') {
    // Tras un fallo se conserva el avance y se pausa. Sólo “Actualizar” puede
    // iniciar de nuevo; los sondeos del navegador nunca reinician desde cero.
    if (!walmartPromotions.running && (url.searchParams.has('refresh') || (!walmartPromotions.completedAt && !walmartPromotions.error))) {
      scanWalmartPromotions();
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    });
    const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
    const limit = Math.max(0, Math.min(100, Number(url.searchParams.get('limit')) || 100));
    return res.end(JSON.stringify({
      running: walmartPromotions.running,
      total: walmartPromotions.total,
      scanned: walmartPromotions.scanned,
      count: walmartPromotions.items.length,
      completedAt: walmartPromotions.completedAt,
      error: walmartPromotions.error,
      // La lista se entrega paginada: la interfaz no necesita renderizar miles
      // de tarjetas a la vez ni reenviar el catálogo completo en cada sondeo.
      products: walmartPromotions.items.slice(from, from + limit)
    }));
  }

  // ── Proxy de catálogo público Walmart / VTEX ─────────────────────────────
  // Sólo reenvía lecturas del catálogo: no transmite cookies, sesión ni datos
  // del visitante a Walmart. La disponibilidad final depende de la sucursal
  // seleccionada por el cliente en el sitio oficial.
  if (pathname.startsWith('/api/walmart/catalog_system/pub/')) {
    // /api/walmart/catalog_system/... → /api/catalog_system/...
    // (el prefijo /api es obligatorio en el endpoint VTEX de Walmart).
    const apiPath = pathname.replace('/api/walmart', '/api');
    const proxy = https.request(
      {
        host: 'www.walmart.com.ni',
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
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    proxy.end();
    return;
  }

  // ── Archivos estáticos ────────────────────────────────────────────────────
  let relPath  = ALIASES[pathname] || pathname.replace(/^\/+/, '');
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
      const ext         = path.extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': contentType });
      res.end(data);
    });
  });

}).listen(PORT, () => {
  console.log('');
  console.log('  🏗️  Presupuestos Ferreterías — servidor listo');
  console.log('  ─────────────────────────────────────────────');
  console.log('  Landing:               http://localhost:' + PORT + '/');
  console.log('  Sinsa presupuestos:    http://localhost:' + PORT + '/ferreterias/sinsa/presupuestos/');
  console.log('  Sinsa descuentos:      http://localhost:' + PORT + '/ferreterias/sinsa/descuentos/');
  console.log('  Fetesa presupuestos:   http://localhost:' + PORT + '/ferreterias/fetesa/presupuestos/');
  console.log('  Fetesa descuentos:     http://localhost:' + PORT + '/ferreterias/fetesa/descuentos/');
  console.log('  El Halcón presup.:     http://localhost:' + PORT + '/ferreterias/elhalcon/presupuestos/');
  console.log('  El Halcón descuentos:  http://localhost:' + PORT + '/ferreterias/elhalcon/descuentos/');
  console.log('  PriceSmart presup.:    http://localhost:' + PORT + '/ferreterias/pricesmart/presupuestos/');
  console.log('  PriceSmart descuentos: http://localhost:' + PORT + '/ferreterias/pricesmart/descuentos/');
  console.log('  Walmart presupuestos:  http://localhost:' + PORT + '/ferreterias/walmart/presupuestos/');
  console.log('  Walmart descuentos:    http://localhost:' + PORT + '/ferreterias/walmart/descuentos/');
  console.log('');
});
