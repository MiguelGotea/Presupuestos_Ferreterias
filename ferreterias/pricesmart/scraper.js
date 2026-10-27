'use strict';
/**
 * Descarga el catálogo público completo y las promociones de PriceSmart Nicaragua.
 *
 * Uso desde la raíz del proyecto:
 *   node ferreterias/pricesmart/scraper.js
 *
 * Recorre las categorías y su paginación pública. No utiliza las API internas
 * de Commercetools/Bloomreach ni depende de ellas desde el VPS.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const HOME_URL = 'https://www.pricesmart.com/es-ni/home';
const PROMOTIONS_URL = 'https://www.pricesmart.com/es-ni/ahorros-del-fabricante';
const OUT_FILE = path.resolve(__dirname, 'data', 'productos.json');
const PROGRESS_FILE = path.resolve(__dirname, 'data', 'catalog-progress.json');
// PriceSmart puede responder lento durante una descarga grande. El progreso se
// guarda por página, así que es preferible detenerse y reanudar que omitir datos.
const TIMEOUT = Number(process.env.PRICESMART_TIMEOUT_MS || 180000);
const NAVIGATION_RETRIES = Number(process.env.PRICESMART_NAVIGATION_RETRIES || 5);
const MAX_CATALOG_PAGES = 500;
const MAX_PROMOTION_PAGES = 40;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readProgress() {
  try {
    const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    return progress?.version === 1 && Array.isArray(progress.products) && !progress.complete ? progress : null;
  } catch {
    return null;
  }
}

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function writeJsonSafely(file, data) {
  const payload = JSON.stringify(data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      // Escritura directa: evita EPERM de Windows al reemplazar un archivo
      // que Explorer, Git o el antivirus puede estar leyendo brevemente.
      fs.writeFileSync(file, payload, 'utf8');
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 10) throw error;
      console.log(`    ⚠️ Checkpoint bloqueado por Windows; reintentando ${attempt}/10...`);
      waitSync(1000 * attempt);
    }
  }
  throw lastError;
}

function saveProgress(categories, products, categoryIndex, pageNumber) {
  writeJsonSafely(PROGRESS_FILE, {
    version: 1,
    updatedAt: new Date().toISOString(),
    categories,
    nextCategoryIndex: categoryIndex,
    nextPageNumber: pageNumber,
    products
  });
}

async function visit(page, url, label) {
  let lastError;
  for (let attempt = 1; attempt <= NAVIGATION_RETRIES; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      return true;
    } catch (error) {
      lastError = error;
      console.log(`    ⚠️ ${label}: intento ${attempt}/${NAVIGATION_RETRIES} — ${error.message.slice(0, 110)}`);
      if (attempt < NAVIGATION_RETRIES) await sleep(5000 * attempt);
    }
  }
  console.log(`    🔴 ${label}: falló tras ${NAVIGATION_RETRIES} intentos (${lastError.message.slice(0, 90)})`);
  return false;
}

async function collectPage(page, category = '') {
  await page.waitForSelector('div[id^="product-card-"]', { timeout: TIMEOUT }).catch(() => {});

  return page.$$eval('div[id^="product-card-"]', (cards, currentCategory) => {
    const money = value => {
      const normalized = (value || '').replace(/[^0-9.,]/g, '').replace(/,/g, '');
      return Number.parseFloat(normalized) || 0;
    };

    return cards.map(card => {
      const title = card.querySelector('[id^="productTitle-"]');
      const image = card.querySelector('img.sf-image, img:not([alt="Placeholder"])');
      const regular = money(card.querySelector('.sf-price__regular')?.textContent);
      const special = money(card.querySelector('.sf-price__special')?.textContent);
      const previous = money(card.querySelector('.sf-price__old')?.textContent);
      const price = special || regular;
      const listPrice = previous > price ? previous : 0;
      const availableText = card.querySelector('.product-card__availability--container')?.textContent || '';
      const id = card.id.replace(/^product-card-/, '');

      return {
        id,
        name: title?.textContent?.replace(/\s+/g, ' ').trim() || '',
        slug: id,
        link: title?.href || '',
        sku: id.split('-')[0],
        cat: currentCategory,
        price,
        listPrice,
        image: image?.currentSrc || image?.src || '',
        available: !/fuera de inventario|no disponible/i.test(availableText),
        promotion: card.querySelector('.promo-container')?.textContent?.replace(/\s+/g, ' ').trim() || '',
        isPromotion: false
      };
    }).filter(product => product.id && product.name && product.price);
  }, category);
}

async function goToNextPage(page, previousIds) {
  const clicked = await page.evaluate(() => {
    const next = Array.from(document.querySelectorAll('a, button')).find(element => {
      const label = `${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`.toLowerCase();
      return /previous next|siguiente|next page|página siguiente/.test(label);
    });
    if (!next || next.getAttribute('aria-disabled') === 'true' || next.classList.contains('disabled')) return false;
    next.click();
    return true;
  });
  if (!clicked) return false;

  try {
    await page.waitForFunction(ids => {
      const current = Array.from(document.querySelectorAll('div[id^="product-card-"]'))
        .map(card => card.id.replace(/^product-card-/, ''));
      return current.length && current.some(id => !ids.includes(id));
    }, { timeout: 15000 }, previousIds);
    return true;
  } catch {
    return false;
  }
}

async function getCategories(page) {
  if (!(await visit(page, HOME_URL, 'menú de categorías'))) throw new Error('No se pudo cargar el menú de categorías');
  await page.waitForSelector('#btnCategoriesMenu', { timeout: TIMEOUT });
  await page.click('#btnCategoriesMenu');
  await page.waitForSelector('a[id^="category_"]', { timeout: TIMEOUT });
  return page.$$eval('a[id^="category_"]', links => links.map(link => ({
    name: link.textContent.replace(/\s+/g, ' ').trim(), url: link.href
  })).filter(category => category.name && category.url));
}

async function scrapeCatalog(page) {
  const categories = await getCategories(page);
  const progress = readProgress();
  const all = progress?.products || [];
  const startCategory = Math.min(progress?.nextCategoryIndex || 0, categories.length);
  const startPage = Math.max(progress?.nextPageNumber || 1, 1);
  console.log(`  📂 ${categories.length} categorías principales detectadas`);
  if (progress) console.log(`  ↻ Reanudando desde ${categories[startCategory]?.name || 'promociones'}, página ${startPage} (${all.length} registros ya guardados)`);

  for (let categoryIndex = startCategory; categoryIndex < categories.length; categoryIndex++) {
    const category = categories[categoryIndex];
    console.log(`\n  ${category.name}`);
    const firstPage = categoryIndex === startCategory ? startPage : 1;
    for (let number = firstPage; number <= MAX_CATALOG_PAGES; number++) {
      const url = new URL(category.url);
      url.searchParams.set('page', String(number));
      if (!(await visit(page, url.href, `${category.name} p${number}`))) {
        // No avanzar a la página siguiente: impedir un catálogo incompleto.
        saveProgress(categories, all, categoryIndex, number);
        throw new Error(`No se pudo descargar ${category.name}, página ${number}. Vuelve a ejecutar el comando para reanudar.`);
      }
      const products = await collectPage(page, category.name);
      if (!products.length) {
        saveProgress(categories, all, categoryIndex + 1, 1);
        break;
      }
      all.push(...products);
      console.log(`    p${number}: ${products.length} productos (acum ${all.length})`);
      saveProgress(categories, all, categoryIndex, number + 1);
    }
  }
  return { categories, products: all };
}

async function scrapePromotions(page) {
  if (!(await visit(page, PROMOTIONS_URL, 'Ahorros del Fabricante'))) return [];
  const all = [];
  let lastIds = [];
  console.log('\n  Ahorros del Fabricante');
  for (let number = 1; number <= MAX_PROMOTION_PAGES; number++) {
    const products = await collectPage(page, 'Ahorros del Fabricante');
    const ids = products.map(product => product.id);
    const fresh = products.filter(product => !lastIds.includes(product.id));
    all.push(...fresh);
    console.log(`    p${number}: ${fresh.length} promociones (acum ${all.length})`);
    if (!ids.length || !(await goToNextPage(page, ids))) break;
    lastIds = ids;
  }
  return all;
}

(async () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  PriceSmart — Descarga completa del catálogo');
  console.log('══════════════════════════════════════════════\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);
    page.on('request', request => {
      const type = request.resourceType();
      const url = request.url();
      if (['image', 'font', 'media'].includes(type) || /google-analytics|googletagmanager|hotjar|doubleclick|newrelic/i.test(url)) request.abort();
      else request.continue();
    });
    const catalog = await scrapeCatalog(page);
    const promotions = await scrapePromotions(page);
    const byId = new Map();
    for (const product of catalog.products) {
      const existing = byId.get(product.id);
      if (!existing) byId.set(product.id, product);
      else if (!existing.cat.includes(product.cat)) existing.cat += ` · ${product.cat}`;
    }
    const promotionById = new Map(promotions.map(product => [product.id, product]));
    for (const product of byId.values()) {
      const promotion = promotionById.get(product.id);
      if (!promotion) continue;
      product.isPromotion = true;
      product.promotion = promotion.promotion || 'Más Ahorros';
      if (promotion.listPrice > product.price) product.listPrice = promotion.listPrice;
    }
    for (const promotion of promotions) {
      if (!byId.has(promotion.id)) byId.set(promotion.id, {
        ...promotion, isPromotion: true, promotion: promotion.promotion || 'Más Ahorros'
      });
    }
    const products = [...byId.values()];
    const withDiscount = products.filter(product => product.listPrice > product.price).length;

    writeJsonSafely(OUT_FILE, {
      generatedAt: new Date().toISOString(),
      source: HOME_URL,
      promotionsSource: PROMOTIONS_URL,
      categoryCount: catalog.categories.length,
      totalProducts: products.length,
      withPromotion: products.filter(product => product.isPromotion).length,
      withDiscount,
      products
    });
    writeJsonSafely(PROGRESS_FILE, {
      version: 1,
      complete: true,
      completedAt: new Date().toISOString(),
      totalProducts: products.length
    });

    console.log('\n══════════════════════════════════════════════');
    console.log(`  ✅ ${products.length} productos únicos`);
    console.log(`  🗂️  ${catalog.categories.length} categorías`);
    console.log(`  🏷️  ${products.filter(product => product.isPromotion).length} en promoción oficial`);
    console.log(`  💲 ${withDiscount} con precio anterior publicado`);
    console.log(`  📄 ${OUT_FILE}`);
    console.log('══════════════════════════════════════════════\n');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(`\n🔴 Error: ${error.message}`);
  process.exitCode = 1;
});
