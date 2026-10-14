'use strict';
// fetesa-cf.js — Sesión Chrome persistente para fetesa.com.ni
//
// Cloudflare bloquea /wp-json/ API con Firewall Rules separadas.
// Solución: navegar a las páginas HTML de WooCommerce y extraer
// los datos del DOM (mismo método que usa un usuario real).
//
// Expone:
//   fetesaSearch(query, pageNum) → { items, total }
//   fetesaProduct(url)           → { ...productDetail }

const fs   = require('fs');
const path = require('path');

// ── Chrome ──────────────────────────────────────────────────────────────────
const CHROME_PATHS = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];
function findChrome() {
  return CHROME_PATHS.find(p => fs.existsSync(p)) || null;
}
const CHROME_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--no-zygote', '--no-first-run', '--disable-extensions',
  '--disable-background-networking', '--disable-breakpad',
  '--disable-component-update', '--disable-domain-reliability',
  '--disable-sync', '--disable-translate', '--metrics-recording-only',
  '--mute-audio', '--no-default-browser-check',
  '--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess',
];

function getPuppeteer() {
  try { return require('puppeteer'); } catch(_) {}
  try { return require('puppeteer-core'); } catch(_) {}
  const p = path.resolve(__dirname, '../PitayaBot/wsp-clientes/node_modules/puppeteer');
  try { return require(p); } catch(_) {}
  throw new Error('puppeteer no encontrado. Ejecuta: npm install puppeteer');
}

// ── Sesión persistente ──────────────────────────────────────────────────────
const IDLE_CLOSE_MS  = 8  * 60 * 1000;  // cerrar Chrome tras 8 min sin uso
const SESSION_TTL_MS = 40 * 60 * 1000;  // refrescar sesión CF cada 40 min

let _browser   = null;
let _page      = null;
let _sessionAt = 0;
let _idleTimer = null;
let _starting  = false;
let _queue     = [];

function scheduleIdleClose() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(async () => {
    console.log('[fetesa-cf] 💤 Inactividad — cerrando Chrome (liberar RAM)');
    await closeSession();
  }, IDLE_CLOSE_MS);
}

async function closeSession() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  _page = null; _sessionAt = 0;
  if (_browser) {
    try { await _browser.close(); } catch(_) {}
    _browser = null;
    console.log('[fetesa-cf] 🔒 Chrome cerrado.');
  }
}

async function startSession() {
  const puppeteer = getPuppeteer();
  const exe = findChrome();
  if (!exe) throw new Error('Chrome no encontrado: ' + CHROME_PATHS.join(', '));

  console.log(`[fetesa-cf] 🌐 Lanzando Chrome (${exe})...`);
  await closeSession();

  _browser = await puppeteer.launch({ headless: 'new', executablePath: exe, args: CHROME_ARGS, timeout: 30000 });
  _page    = await _browser.newPage();
  await _page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  // Resolver CF challenge cargando la homepage
  console.log('[fetesa-cf] 🔄 Cargando fetesa.com.ni para resolver CF challenge...');
  try {
    await _page.goto('https://fetesa.com.ni/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch(e) {
    console.log(`[fetesa-cf] ⚠️ goto warn: ${e.message} — continuando...`);
  }

  // Esperar cf_clearance (hasta 20s)
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const cookies = await _page.cookies('https://fetesa.com.ni').catch(() => []);
    if (cookies.some(c => c.name === 'cf_clearance')) {
      console.log(`[fetesa-cf] ✅ cf_clearance obtenido (${i + 1}s). Sesión lista.`);
      break;
    }
    if (i % 5 === 4) console.log(`[fetesa-cf] ... esperando CF (${i + 1}s)`);
  }

  _sessionAt = Date.now();
  scheduleIdleClose();
}

async function ensureSession() {
  const alive   = _page && !_page.isClosed();
  const fresh   = _sessionAt && (Date.now() - _sessionAt) < SESSION_TTL_MS;
  if (alive && fresh) return;

  if (_starting) {
    return new Promise((resolve, reject) => _queue.push({ resolve, reject }));
  }
  _starting = true;
  try {
    await startSession();
    _queue.forEach(p => p.resolve());
  } catch(e) {
    _queue.forEach(p => p.reject(e));
    throw e;
  } finally {
    _starting = false;
    _queue = [];
  }
}

// ── Navegar esperando que el CF challenge se resuelva ──────────────────────
async function navigateTo(targetUrl) {
  scheduleIdleClose();
  console.log(`[fetesa-cf] 🔄 Navegando a: ${targetUrl}`);

  // networkidle2 espera a que el JS del CF challenge termine de ejecutarse
  try {
    await _page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 40000 });
  } catch(e) {
    console.log(`[fetesa-cf] ⚠️ networkidle2 warn: ${e.message.slice(0, 60)} — continuando...`);
  }

  const title = await _page.title().catch(() => '');
  console.log(`[fetesa-cf] 📄 Página cargada: "${title}" | ${_page.url()}`);

  // Si aún hay challenge activo, esperar hasta 15s más
  if (title.includes('Just a moment') || title === '') {
    console.log('[fetesa-cf] ⏳ Esperando resolución del challenge de página...');
    await _page.waitForFunction(
      () => !document.title.includes('Just a moment') && document.title.trim() !== '',
      { timeout: 15000 }
    ).catch(() => console.log('[fetesa-cf] ⚠️ Challenge de página no resuelto en 15s'));
    const t2 = await _page.title().catch(() => '');
    console.log(`[fetesa-cf] 📄 Título tras espera: "${t2}"`);
  }
}

// ── Búsqueda — navega HTML de WooCommerce y extrae del DOM ─────────────────
async function fetesaSearch(query, pageNum = 1) {
  await ensureSession();
  const searchUrl = `https://fetesa.com.ni/?s=${encodeURIComponent(query)}&et_search=true&post_type=product&paged=${pageNum}`;
  await navigateTo(searchUrl);

  // Esperar a que aparezcan productos (máx 10s)
  await _page.waitForSelector(
    'li.product, .et_pb_product, article.product, ul.products li',
    { timeout: 10000 }
  ).catch(() => console.log('[fetesa-cf] ⚠️ Selectores de producto no encontrados en 10s'));

  const result = await _page.evaluate(() => {
    // Debug: contar elementos con distintos selectores
    const sels = ['li.product', '.et_pb_product', 'article.product', 'ul.products > li', '.products > li', '[class*="product"]'];
    const debug = {};
    sels.forEach(s => { try { debug[s] = document.querySelectorAll(s).length; } catch(_) {} });

    // Recolectar con todos los selectores posibles
    let cards = Array.from(document.querySelectorAll('li.product, .et_pb_product, article.product'));
    if (!cards.length) cards = Array.from(document.querySelectorAll('ul.products > li, ol.products > li, .products > li'));

    const items = cards.map(el => {
      const linkEl = el.querySelector([
        'a.woocommerce-LoopProduct-link',
        '.woocommerce-loop-product__link',
        'a[href*="/producto/"]',
        'a[href*="/product/"]',
        '.et_pb_module_inner > a',
        'h2 > a', 'h3 > a', 'a'
      ].join(', '));
      const link = linkEl?.href || '';
      const slug = link.replace(/.*\/producto\//, '').replace(/.*\/product\//, '').replace(/\/+$/, '');

      const name = (el.querySelector(
        '.woocommerce-loop-product__title, h2, h3, .et_pb_title_container h2, [class*="title"]'
      )?.textContent?.trim()) || '';

      const img = el.querySelector('img')?.src || el.querySelector('img')?.dataset?.src || '';

      const priceEl = el.querySelector('.price');
      const amounts = Array.from(priceEl?.querySelectorAll('bdi, .amount, .woocommerce-Price-amount') || []);
      const prices  = amounts.map(b => parseFloat(b.textContent.replace(/[^\d.,]/g, '').replace(',', '.')) ).filter(n => n > 0 && !isNaN(n)).sort((a, b) => a - b);
      const price     = prices[0] || 0;
      const listPrice = prices.length > 1 ? prices[prices.length - 1] : 0;

      const available = !el.querySelector('.out-of-stock, .outofstock, .stock.out-of-stock');
      if (!name && !link) return null;
      return { id: slug || btoa(name).slice(0, 16), name, slug, link, image: img, price, listPrice, available, cats: [], cat: '', sku: '', attrs: {}, desc: '', _loaded: true };
    }).filter(Boolean);

    const countEl = document.querySelector('.woocommerce-result-count');
    const totMatch = countEl?.textContent?.match(/(\d+)/g);
    const total    = totMatch ? parseInt(totMatch[totMatch.length - 1]) : items.length;
    const hasNext  = !!document.querySelector('.next.page-numbers, .woocommerce-pagination .next');

    return { items, total, hasNext, _debug: debug };
  });

  console.log(`[fetesa-cf] 📦 Extracción: ${result.items.length} items, total=${result.total} | selectores:`, JSON.stringify(result._debug));
  return result;
}

// ── Extractor de detalle de producto ───────────────────────────────────────
async function fetesaProduct(url) {
  await ensureSession();
  await navigateTo(url);

  return _page.evaluate(() => {
    const name = document.querySelector('.product_title, h1.product_title')?.textContent?.trim() || '';
    const sku  = document.querySelector('.sku')?.textContent?.trim() || '';

    const priceEl  = document.querySelector('.summary .price');
    const bdiList  = Array.from(priceEl?.querySelectorAll('bdi, .woocommerce-Price-amount') || []);
    const prices   = bdiList.map(b => parseFloat(b.textContent.replace(/[^\d.]/g, '')) || 0).filter(n => n > 0).sort((a, b) => a - b);
    const price    = prices[0] || 0;
    const listPrice = prices.length > 1 ? prices[prices.length - 1] : 0;

    const images = Array.from(document.querySelectorAll('.woocommerce-product-gallery img, .et_pb_wc_images img'))
      .map(i => i.src || i.dataset.src || '').filter(Boolean);

    const cats = Array.from(document.querySelectorAll('.posted_in a')).map(a => a.textContent.trim());

    const attrs = {};
    document.querySelectorAll('.woocommerce-product-attributes tr, .shop_attributes tr').forEach(row => {
      const k = row.querySelector('th')?.textContent?.trim();
      const v = row.querySelector('td')?.textContent?.trim();
      if (k && v) attrs[k] = v;
    });

    const desc = document.querySelector('.woocommerce-product-details__short-description, .et_pb_wc_description')
      ?.innerText?.trim() || '';

    const available = !document.querySelector('.out-of-stock');

    return { name, sku, price, listPrice, images, cats, cat: cats[cats.length - 1] || '', attrs, desc, available, _detailLoaded: true };
  });
}

async function warmUp() {
  try { await ensureSession(); console.log('[fetesa-cf] 🔥 Sesión precalentada'); }
  catch(e) { console.log(`[fetesa-cf] ⚠️ Warmup: ${e.message}`); }
}

module.exports = { fetesaSearch, fetesaProduct, warmUp, closeSession };
