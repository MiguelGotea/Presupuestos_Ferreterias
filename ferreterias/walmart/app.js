const API = '/api/walmart/catalog_system/pub/products/search';
const PAGE_SIZE = 50;
const $ = s => document.querySelector(s);
const money = n => 'C$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const mode = document.body.dataset.mode;
const discount = p => p.list > p.price ? Math.round((1 - p.price / p.list) * 100) : 0;
const isDiscounted = p => p.list > p.price;


let query = '', offset = 0, exhausted = false, loading = false, products = [], timer, promoTimer, promotionStatus = '';
const pool = new Map();
let budget = JSON.parse(localStorage.getItem('walmart-budget') || '[]');

function normalize(source) {
  const category = (source.categories?.[0] || '').split('/').filter(Boolean).join(' › ');
  return (source.items || []).map(item => {
    const offer = item.sellers?.[0]?.commertialOffer || {};
    const product = {
      id: `${source.productId}-${item.itemId}`, productId: source.productId, sku: item.itemId || '',
      name: item.nameComplete || item.name || source.productName || '', brand: source.brand || 'Sin marca', category,
      description: source.description || '', link: source.link || '', ean: item.ean || '',
      reference: item.referenceId?.[0]?.Value || source.productReference || '', unit: item.measurementUnit || 'un',
      multiplier: item.unitMultiplier || 1, price: Number(offer.Price || 0), list: Number(offer.ListPrice || 0),
      priceWithoutDiscount: Number(offer.PriceWithoutDiscount || offer.Price || 0),
      fullSellingPrice: Number(offer.FullSellingPrice || offer.Price || 0), priceValidUntil: offer.PriceValidUntil || '',
      available: Boolean(offer.IsAvailable) && Number(offer.AvailableQuantity || 0) > 0,
      seller: item.sellers?.[0]?.sellerName || 'Walmart', images: (item.images || []).map(i => i.imageUrl).filter(Boolean),
      promotions: [...(offer.Teasers || []), ...(offer.PromotionTeasers || [])]
        .map(x => x?.Name || x?.name || '').filter(Boolean),
      collections: Object.values(source.productClusters || {})
    };
    pool.set(product.id, product);
    return product;
  });
}

async function fetchCatalog(path) {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`Walmart respondió HTTP ${response.status}`);
  return response.json();
}

function append(items) {
  const ids = new Set(products.map(p => p.id));
  items.forEach(item => { if (!ids.has(item.id)) { ids.add(item.id); products.push(item); } });
}

async function loadCatalog(reset = true) {
  if (loading || query.trim().length < 2) { if (query.trim().length < 2) { products = []; render(); } return; }
  if (reset) { products = []; offset = 0; exhausted = false; }
  loading = true; render();
  try {
    const page = await fetchCatalog(`/${encodeURIComponent(query.trim())}?_from=${offset}&_to=${offset + PAGE_SIZE - 1}`);
    append(page.flatMap(normalize));
    offset += PAGE_SIZE; exhausted = page.length < PAGE_SIZE;
  } catch (error) { showError(error); }
  loading = false; render();
}

async function loadPromotions(refresh = false) {
  if (loading) return;
  clearTimeout(promoTimer);
  loading = true; render();
  try {
    const response = await fetch(`/api/walmart/promotions${refresh ? '?refresh=1' : ''}`);
    if (!response.ok) throw new Error(`El explorador respondió HTTP ${response.status}`);
    const scan = await response.json();
    products = (scan.products || []).flatMap(normalize).filter(isDiscounted);
    exhausted = !scan.running;
    promotionStatus = scan.running
      ? ` · explorando ${Number(scan.scanned || 0).toLocaleString('es-NI')}${scan.total ? ` de ${Number(scan.total).toLocaleString('es-NI')}` : ''}`
      : scan.completedAt ? ` · catálogo completo explorado` : '';
    if (scan.error) promotionStatus = ` · error de exploración: ${scan.error}`;
    else if (scan.running) promoTimer = setTimeout(() => loadPromotions(false), 1200);
  } catch (error) { promotionStatus = ''; showError(error); }
  loading = false; render();
}

function filtered() {
  const words = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const onlyDiscount = mode === 'discounts' || $('#only-discount').checked;
  return products.filter(p => {
    const text = `${p.name} ${p.brand} ${p.category} ${p.sku} ${p.ean} ${p.reference}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return (!words || text.includes(words)) && (!onlyDiscount || isDiscounted(p));
  });
}

function row(p) {
  const pct = discount(p);
  return `<tr><td class="image-cell"><img src="${esc(p.images[0] || '')}" alt="" loading="lazy" data-open="${esc(p.id)}"></td>
    <td><button class="name-button" data-open="${esc(p.id)}">${esc(p.name)}</button><div class="sub">SKU ${esc(p.sku)}${p.reference ? ` · Ref. ${esc(p.reference)}` : ''}</div></td>
    <td><b>${esc(p.brand)}</b><div class="sub clamp">${esc(p.category || 'Sin categoría publicada')}</div></td>
    <td><span class="availability ${p.available ? 'yes' : 'no'}">${p.available ? 'Disponible' : 'Sin existencia'}</span></td>
    <td class="price-cell"><b>${money(p.price)}</b>${pct ? `<span class="discount">-${pct}%</span><del>${money(p.list)}</del>` : ''}</td>
    <td class="actions"><button class="button secondary" data-open="${esc(p.id)}">Ver</button><button class="button primary" data-add="${esc(p.id)}" title="Añadir al presupuesto">+</button></td></tr>`;
}

function render() {
  const list = filtered();
  $('#count').textContent = loading ? 'Consultando Walmart…' : `${list.length} producto${list.length === 1 ? '' : 's'}${mode === 'discounts' ? ` con descuento${promotionStatus}` : ''}`;
  $('#more').hidden = mode === 'discounts' || exhausted || loading || (mode === 'catalog' && query.trim().length < 2);
  $('#more').textContent = loading ? 'Consultando…' : mode === 'discounts' ? 'Cargar más promociones' : 'Cargar más resultados';
  if (!list.length) {
    const message = loading ? 'Consultando el catálogo oficial…' : mode === 'discounts' ? 'No hay promociones publicadas en los lotes consultados.' : query.trim().length < 2 ? 'Escribe al menos dos caracteres para buscar en Walmart.' : 'No se encontraron productos con esos criterios.';
    $('#results').innerHTML = `<div class="empty">${message}</div>`; return;
  }
  $('#results').innerHTML = `<table><thead><tr><th></th><th>Producto</th><th>Marca / categoría</th><th>Disponibilidad</th><th class="right">Precio</th><th></th></tr></thead><tbody>${list.map(row).join('')}</tbody></table>`;
}

function showError(error) { $('#results').innerHTML = `<div class="empty error">No se pudo consultar Walmart: ${esc(error.message)}. Verifica que server.js esté activo.</div>`; }

function openModal(id) {
  const p = pool.get(id) || budget.find(item => item.id === id); if (!p) return;
  const images = p.images.length ? p.images : [''];
  const pct = discount(p), saving = Math.max(0, p.list - p.price);
  const promo = p.promotions.length ? p.promotions.join(' · ') : pct ? 'Precio rebajado publicado por Walmart' : 'Sin promoción adicional publicada';
  $('#modal-box').innerHTML = `<div class="modal-head"><div><span class="eyebrow">${esc(p.brand)}</span><h2>${esc(p.name)}</h2></div><button class="icon-close" id="close-modal" aria-label="Cerrar">×</button></div>
    <div class="modal-main"><section class="gallery"><img id="main-image" src="${esc(images[0])}" alt="${esc(p.name)}"><div class="thumbs">${images.map((image, i) => `<button class="thumb ${i === 0 ? 'selected' : ''}" data-image="${esc(image)}"><img src="${esc(image)}" alt=""></button>`).join('')}</div></section>
    <section class="product-data"><div class="modal-price">${money(p.price)} <span>por ${esc(p.unit)}</span></div>${pct ? `<div class="saving"><b>-${pct}%</b> Antes ${money(p.list)} · Ahorras ${money(saving)}</div>` : ''}
    <div class="badges"><span class="availability ${p.available ? 'yes' : 'no'}">${p.available ? 'Disponible' : 'Sin existencia'}</span><span class="chip">Vendido por ${esc(p.seller)}</span></div>
    <div class="modal-actions"><button class="button primary" data-add="${esc(p.id)}">+ Añadir al presupuesto</button><a class="button secondary" href="${esc(p.link)}" target="_blank" rel="noopener">Ver en Walmart ↗</a></div>
    <p class="store-note">Precio público consultado en línea. La disponibilidad final puede variar según la tienda y zona seleccionadas en Walmart.</p></section></div>
    <div class="detail-grid"><section><h3>Identificación</h3><dl><dt>Producto</dt><dd>${esc(p.productId)}</dd><dt>SKU</dt><dd>${esc(p.sku)}</dd><dt>EAN</dt><dd>${esc(p.ean || 'No publicado')}</dd><dt>Referencia</dt><dd>${esc(p.reference || 'No publicada')}</dd><dt>Unidad</dt><dd>${esc(p.unit)} × ${esc(p.multiplier)}</dd></dl></section>
    <section><h3>Catálogo y precio</h3><dl><dt>Categoría</dt><dd>${esc(p.category || 'No publicada')}</dd><dt>Precio sin descuento</dt><dd>${money(p.priceWithoutDiscount)}</dd><dt>Precio total</dt><dd>${money(p.fullSellingPrice)}</dd><dt>Vigencia</dt><dd>${p.priceValidUntil ? esc(new Date(p.priceValidUntil).toLocaleString('es-NI')) : 'No publicada'}</dd><dt>Promoción</dt><dd>${esc(promo)}</dd></dl></section></div>
    ${p.description ? `<section class="description"><h3>Descripción</h3><div>${esc(p.description)}</div></section>` : ''}`;
  $('#modal').classList.add('open');
}

function saveBudget() { localStorage.setItem('walmart-budget', JSON.stringify(budget)); }
function addBudget(id) { const p = pool.get(id); if (!p) return; const item = budget.find(x => x.id === id); if (item) item.qty++; else budget.push({ ...p, qty: 1 }); saveBudget(); renderBudget(); }
function changeQty(id, amount) { const item = budget.find(x => x.id === id); if (!item) return; item.qty += amount; if (item.qty <= 0) budget = budget.filter(x => x.id !== id); saveBudget(); renderBudget(); }
function renderBudget() {
  const quantity = budget.reduce((sum, item) => sum + item.qty, 0), total = budget.reduce((sum, item) => sum + item.price * item.qty, 0);
  $('#budget-count').textContent = `${quantity} ítem${quantity === 1 ? '' : 's'}`; $('#budget-total').textContent = money(total);
  $('#budget-list').innerHTML = budget.length ? budget.map(item => `<div class="budget-item"><div><b>${esc(item.name)}</b><span>${money(item.price)} c/u</span></div><div class="quantity"><button data-qty="${esc(item.id)}" data-change="-1">−</button><b>${item.qty}</b><button data-qty="${esc(item.id)}" data-change="1">+</button><strong>${money(item.price * item.qty)}</strong></div></div>`).join('') : '<div class="empty budget-empty">Añade productos con el botón +.</div>';
}

$('#query').addEventListener('input', event => { query = event.target.value; clearTimeout(timer); timer = setTimeout(() => mode === 'discounts' ? render() : loadCatalog(true), 300); });
$('#only-discount').addEventListener('change', render);
$('#more').onclick = () => loadCatalog(false);
$('#clear-budget').onclick = () => { budget = []; saveBudget(); renderBudget(); };
$('#print-budget').onclick = () => window.print();
document.addEventListener('click', event => {
  const open = event.target.closest('[data-open]'), add = event.target.closest('[data-add]'), qty = event.target.closest('[data-qty]'), image = event.target.closest('[data-image]');
  if (open) openModal(open.dataset.open); if (add) addBudget(add.dataset.add); if (qty) changeQty(qty.dataset.qty, Number(qty.dataset.change));
  if (image) { $('#main-image').src = image.dataset.image; document.querySelectorAll('.thumb').forEach(x => x.classList.toggle('selected', x === image)); }
  if (event.target.id === 'close-modal' || event.target.id === 'modal') $('#modal').classList.remove('open');
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('#modal').classList.remove('open'); });
$('#page-title').textContent = mode === 'discounts' ? 'Promociones' : 'Presupuestos';
$('#promo-link').href = mode === 'discounts' ? '/ferreterias/walmart/presupuestos/' : '/ferreterias/walmart/descuentos/';
$('#promo-link').textContent = mode === 'discounts' ? '📋 Ver catálogo' : '🏷️ Ver promociones';
$('#query').placeholder = mode === 'discounts' ? 'Filtrar promociones cargadas por producto, marca o SKU…' : 'Buscar por producto, marca, SKU o EAN…';
$('#only-discount-wrap').hidden = mode === 'discounts';
$('#reload-promotions')?.addEventListener('click', () => loadPromotions(true));
renderBudget(); if (mode === 'discounts') loadPromotions(); else render();
