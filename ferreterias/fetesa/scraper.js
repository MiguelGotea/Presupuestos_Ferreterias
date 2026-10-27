'use strict';
/**
 * ferreterias/fetesa/scraper.js — Descargador completo del catálogo Fetesa
 *
 * Ejecutar desde la raíz del proyecto:
 *   node ferreterias/fetesa/scraper.js            → descarga por categorías
 *   node ferreterias/fetesa/scraper.js martillo   → solo búsqueda
 *   node ferreterias/fetesa/scraper.js martillo 3 → búsqueda, máx 3 páginas
 *
 * Guarda: ferreterias/fetesa/data/productos.json
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.resolve(__dirname, 'data', 'productos.json');
const BASE_URL = 'https://fetesa.com.ni';
const DELAY_MS = 1800;
const TIMEOUT = 45000;
// Reintentos por página en caso de error de red
const MAX_RETRIES = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapePage(page, url) {
  console.log(`    🌐 ${url}`);
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: TIMEOUT });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.log(`    ⚠️  intento ${attempt}/${MAX_RETRIES}: ${e.message.slice(0, 70)}`);
      if (attempt < MAX_RETRIES) await sleep(3000);
    }
  }
  if (lastErr) {
    console.log(`    🔴 Página no cargó tras ${MAX_RETRIES} intentos — saltando`);
    return { items: [], nextUrl: null };
  }

  const title = await page.title().catch(() => '');
  if (title.includes('Just a moment') || title === '') {
    console.log(`    🔴 Cloudflare challenge — saltando`);
    return { items: [], nextUrl: null };
  }

  await page.waitForSelector('h2.woocommerce-loop-product__title', { timeout: 8000 }).catch(() => { });

  return page.evaluate(() => {
    const items = [];
    document.querySelectorAll('h2.woocommerce-loop-product__title').forEach(h2 => {
      const linkEl = h2.querySelector('a');
      const link = linkEl?.href || '';
      if (!link) return;

      const name = (linkEl?.textContent?.trim() || '')
        .replace(/[\u201c\u201d\u2033]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        .trim();
      const slug = link.replace(/.*\/producto\//, '').replace(/\/$/, '');
      const container = h2.closest('.etheme-product-grid-content') || h2.parentElement;

      const cat = container?.querySelector('.etheme-product-grid-categories a')?.textContent?.trim() || '';

      const priceEl = container?.querySelector('span.price');
      const bdis = Array.from(priceEl?.querySelectorAll('bdi') || [])
        .map(b => parseFloat(b.textContent.replace(/[^0-9.]/g, '')) || 0)
        .filter(n => n > 0)
        .sort((a, b) => a - b);
      const price = bdis[0] || 0;
      const listPrice = bdis.length > 1 ? bdis[bdis.length - 1] : 0;

      const wrapper = h2.closest('li, article, .product-wrapper, .product-inner') || h2.parentElement?.parentElement;
      const imgEl = wrapper?.querySelector('img');
      const image = imgEl?.getAttribute('data-src') || imgEl?.src || '';
      const sku = wrapper?.querySelector('[data-product_sku]')?.getAttribute('data-product_sku') || '';
      const available = !(container?.querySelector('.stock-status')?.textContent?.toLowerCase().includes('agotado'));

      items.push({ id: slug || btoa(name).slice(0, 16), name, slug, link, sku, cat, price, listPrice, image, available });
    });

    const nextEl = document.querySelector('a.next.page-numbers, .woocommerce-pagination .next');
    return { items, nextUrl: nextEl?.href || null };
  });
}

async function scrapeSource(page, label, startUrl, maxPages = 99) {
  console.log(`\n  📂 ${label}`);
  let all = [], nextUrl = startUrl, pg = 1;
  while (nextUrl && pg <= maxPages) {
    const { items, nextUrl: next } = await scrapePage(page, nextUrl);
    all = all.concat(items);
    console.log(`    📦 p${pg}: ${items.length} prods (acum ${all.length})`);
    if (!next) break;
    nextUrl = next;
    pg++;
    await sleep(DELAY_MS);
  }
  return all;
}

(async () => {
  const args = process.argv.slice(2);
  const query = args[0] || null;
  const maxPages = parseInt(args[1] || '99');

  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  🏗️  Fetesa Scraper — Descarga de catálogo');
  console.log('══════════════════════════════════════════════');
  console.log(query ? `  Modo búsqueda: "${query}"` : `  Modo completo: /tienda/ con paginación`);
  console.log('');

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  let rawAll = [];

  if (query) {
    rawAll = await scrapeSource(page, `Búsqueda: "${query}"`,
      `https://fetesa.com.ni/?s=${encodeURIComponent(query)}&et_search=true&post_type=product`, maxPages);
  } else {
    // Modo completo: recorre /tienda/ con paginación (incluye todos los productos)
    rawAll = await scrapeSource(page, 'Tienda completa (fetesa.com.ni/tienda/)', `${BASE_URL}/tienda/`, maxPages);
  }

  await browser.close();

  const seen = new Set();
  const products = rawAll.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
  const withDiscount = products.filter(p => p.listPrice > p.price).length;

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), totalProducts: products.length, withDiscount, products }, null, 2), 'utf8');

  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log(`  ✅ ${products.length} productos únicos`);
  console.log(`  🏷️  ${withDiscount} con descuento`);
  console.log(`  📄 ${OUT_FILE}`);
  console.log('══════════════════════════════════════════════');
  console.log('');
})();
