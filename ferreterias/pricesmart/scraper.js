'use strict';
/**
 * Descarga local de Ahorros del Fabricante de PriceSmart Nicaragua.
 *
 * Uso desde la raíz del proyecto:
 *   node ferreterias/pricesmart/scraper.js
 *
 * Guarda ferreterias/pricesmart/data/productos.json. PriceSmart usa servicios
 * internos de Commercetools/Bloomreach; por eso no se consume su API desde el
 * VPS. El scraper extrae los datos visibles de la página pública de promociones.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const START_URL = 'https://www.pricesmart.com/es-ni/ahorros-del-fabricante';
const OUT_FILE = path.resolve(__dirname, 'data', 'productos.json');
const TIMEOUT = 60000;
const MAX_PAGES = 40;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function collectPage(page) {
  await page.waitForSelector('div[id^="product-card-"]', { timeout: TIMEOUT });

  return page.$$eval('div[id^="product-card-"]', cards => {
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
        cat: 'Ahorros del Fabricante',
        price,
        listPrice,
        image: image?.currentSrc || image?.src || '',
        available: !/fuera de inventario|no disponible/i.test(availableText),
        promotion: card.querySelector('.promo-container')?.textContent?.replace(/\s+/g, ' ').trim() || 'Más Ahorros',
        isPromotion: true
      };
    }).filter(product => product.id && product.name && product.price);
  });
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

(async () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  PriceSmart — Descarga de Ahorros del Fabricante');
  console.log('══════════════════════════════════════════════\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(START_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });

    let all = [];
    let currentIds = [];
    for (let number = 1; number <= MAX_PAGES; number++) {
      const products = await collectPage(page);
      const ids = products.map(product => product.id);
      const newProducts = products.filter(product => !currentIds.includes(product.id));
      all = all.concat(newProducts);
      console.log(`  Página ${number}: ${newProducts.length} productos (acumulado ${all.length})`);

      if (!ids.length || !(await goToNextPage(page, ids))) break;
      currentIds = ids;
      await sleep(800);
    }

    const seen = new Set();
    const products = all.filter(product => {
      if (seen.has(product.id)) return false;
      seen.add(product.id);
      return true;
    });
    const withDiscount = products.filter(product => product.listPrice > product.price).length;

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: START_URL,
      totalProducts: products.length,
      withPromotion: products.filter(product => product.isPromotion).length,
      withDiscount,
      products
    }), 'utf8');

    console.log('\n══════════════════════════════════════════════');
    console.log(`  ✅ ${products.length} productos descargados`);
    console.log(`  🏷️  ${products.length} en promoción oficial`);
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
