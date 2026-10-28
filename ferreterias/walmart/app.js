const API = '/api/walmart/catalog_system/pub/products/search';
const PAGE_SIZE = 50;
const $ = s => document.querySelector(s);
const money = n => 'C$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const mode = document.body.dataset.mode;
const discount = p => p.list > p.price ? Math.round((1 - p.price / p.list) * 100) : 0;
const isDiscounted = p => p.list > p.price;


let query = '', offset = 0, exhausted = false, loading = false, products = [], timer, promoTimer, promotionStatus = '', promotionOffset = 0;
const pool = new Map();
let budget = JSON.parse(localStorage.getItem('walmart-budget') || '[]');
let promoSortKey = 'discount', promoSortDir = -1;
let promoBrands = null, promoCategories = null;

function promoCategory(product) { return product.category.split(' › ')[0] || 'Sin categoría'; }
function promoFilterValues(kind) {
  const values = new Set(products.map(product => kind === 'brand' ? product.brand : promoCategory(product)));
  return [...values].sort((a, b) => a.localeCompare(b, 'es'));
}
function promoFilterSet(kind) { return kind === 'brand' ? promoBrands : promoCategories; }
function setPromoFilterSet(kind, value) { if (kind === 'brand') promoBrands = value; else promoCategories = value; }

function setupPromotionControls() {
  if (mode !== 'discounts') return;
  document.head.insertAdjacentHTML('beforeend', `<style>
    .promo-table{min-width:1120px}.promo-head{white-space:nowrap}.promo-sort{border:0;background:none;padding:0;color:inherit;font:inherit;font-weight:800;cursor:pointer;text-transform:uppercase}.promo-sort:hover{color:#0071ce}.promo-filter{margin-left:5px;border:1px solid #c7d5e1;background:#fff;border-radius:5px;padding:2px 5px;color:#456177;font-size:10px;font-weight:700;cursor:pointer}.promo-filter.active{border-color:#0071ce;color:#0071ce;background:#eaf4fd}.saving-cell{font-weight:700;color:#087443;text-align:right;white-space:nowrap}.discount-cell{text-align:center;white-space:nowrap}.discount-cell .discount{margin:0}.promo-filter-popover{position:fixed;z-index:30;width:275px;max-height:380px;background:#fff;border:1px solid #bfcfdb;border-radius:9px;box-shadow:0 12px 28px #183a5940;padding:10px;display:none}.promo-filter-popover.open{display:block}.promo-filter-title{display:flex;justify-content:space-between;align-items:center;font-weight:800;margin-bottom:8px}.promo-filter-title button{border:0;background:none;font-size:18px;cursor:pointer;color:#627383}.promo-filter-actions{display:flex;gap:10px;margin-bottom:8px}.promo-filter-actions button{border:0;background:none;color:#0071ce;font-size:11px;padding:0;cursor:pointer}.promo-filter-search{width:100%;border:1px solid #c7d5e1;border-radius:5px;padding:7px;font:12px Inter,Arial,sans-serif}.promo-filter-list{max-height:240px;overflow:auto;margin-top:8px}.promo-filter-option{display:flex;align-items:center;gap:7px;padding:5px 2px;font-size:12px}.promo-filter-option input{accent-color:#0071ce}.promo-filter-option small{margin-left:auto;color:#627383}
  </style>`);
  document.body.insertAdjacentHTML('beforeend', `<div class="promo-filter-popover" id="promo-filter-popover"><div class="promo-filter-title"><span id="promo-filter-title">Filtrar</span><button type="button" id="promo-filter-close" aria-label="Cerrar">×</button></div><div class="promo-filter-actions"><button type="button" data-promo-filter-action="all">Todas</button><button type="button" data-promo-filter-action="none">Ninguna</button><button type="button" data-promo-filter-action="reset">Restablecer</button></div><input class="promo-filter-search" id="promo-filter-search" placeholder="Buscar opción…"><div class="promo-filter-list" id="promo-filter-list"></div></div>`);
}

let activePromoFilter = null, activePromoFilterButton = null;
function renderPromoFilterPopover() {
  if (!activePromoFilter) return;
  const values = promoFilterValues(activePromoFilter);
  const selected = promoFilterSet(activePromoFilter);
  const term = $('#promo-filter-search').value.trim().toLocaleLowerCase('es');
  $('#promo-filter-list').innerHTML = values.filter(value => !term || value.toLocaleLowerCase('es').includes(term)).map(value => {
    const checked = selected === null || selected.has(value);
    const count = products.filter(product => (activePromoFilter === 'brand' ? product.brand : promoCategory(product)) === value).length;
    return `<label class="promo-filter-option"><input type="checkbox" data-promo-filter-item="${activePromoFilter}" value="${esc(value)}" ${checked ? 'checked' : ''}><span>${esc(value)}</span><small>${count}</small></label>`;
  }).join('') || '<div class="sub">Sin opciones</div>';
}
function openPromoFilter(kind, button) {
  const popover = $('#promo-filter-popover');
  if (activePromoFilter === kind && popover.classList.contains('open')) return closePromoFilter();
  activePromoFilter = kind; activePromoFilterButton = button;
  $('#promo-filter-title').textContent = kind === 'brand' ? 'Filtrar por marca' : 'Filtrar por categoría';
  $('#promo-filter-search').value = '';
  renderPromoFilterPopover();
  const bounds = button.getBoundingClientRect();
  popover.style.top = `${bounds.bottom + 5}px`;
  popover.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - 285))}px`;
  popover.classList.add('open');
}
function closePromoFilter() { $('#promo-filter-popover')?.classList.remove('open'); activePromoFilter = null; activePromoFilterButton = null; }

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
  if (refresh) {
    products = [];
    pool.clear();
    promotionOffset = 0;
  }
  loading = true; render();
  try {
    const params = new URLSearchParams({ from: String(promotionOffset) });
    if (refresh) params.set('refresh', '1');
    const response = await fetch(`/api/walmart/promotions?${params}`);
    if (!response.ok) throw new Error(`El explorador respondió HTTP ${response.status}`);
    const scan = await response.json();
    append((scan.products || []).flatMap(normalize).filter(isDiscounted));
    promotionOffset = Number(scan.count || promotionOffset);
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
  let list = products.filter(p => {
    const text = `${p.name} ${p.brand} ${p.category} ${p.sku} ${p.ean} ${p.reference}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return (!words || text.includes(words)) && (!onlyDiscount || isDiscounted(p));
  });
  if (mode !== 'discounts') return list;
  if (promoBrands !== null) list = list.filter(product => promoBrands.has(product.brand));
  if (promoCategories !== null) list = list.filter(product => promoCategories.has(promoCategory(product)));
  const valueFor = product => ({
    name: product.name, brand: product.brand, category: promoCategory(product), price: product.price,
    list: product.list, saving: product.list - product.price, discount: discount(product)
  })[promoSortKey];
  return list.sort((a, b) => {
    const av = valueFor(a), bv = valueFor(b);
    return typeof av === 'string' ? av.localeCompare(bv, 'es') * promoSortDir : (av - bv) * promoSortDir;
  });
}

function row(p) {
  const pct = discount(p);
  if (mode === 'discounts') return `<tr><td class="image-cell"><img src="${esc(p.images[0] || '')}" alt="" loading="lazy" data-open="${esc(p.id)}"></td>
    <td><button class="name-button" data-open="${esc(p.id)}">${esc(p.name)}</button><div class="sub">SKU ${esc(p.sku)}${p.reference ? ` · Ref. ${esc(p.reference)}` : ''}</div></td>
    <td><b>${esc(p.brand)}</b></td><td><span class="sub">${esc(promoCategory(p))}</span></td>
    <td class="price-cell"><b>${money(p.price)}</b></td><td class="price-cell"><del>${money(p.list)}</del></td>
    <td class="saving-cell">${money(p.list - p.price)}</td><td class="discount-cell"><span class="discount">-${pct}%</span></td>
    <td class="actions"><button class="button secondary" data-open="${esc(p.id)}">Ver</button><button class="button primary" data-add="${esc(p.id)}" title="Añadir al presupuesto">+</button></td></tr>`;
  return `<tr><td class="image-cell"><img src="${esc(p.images[0] || '')}" alt="" loading="lazy" data-open="${esc(p.id)}"></td>
    <td><button class="name-button" data-open="${esc(p.id)}">${esc(p.name)}</button><div class="sub">SKU ${esc(p.sku)}${p.reference ? ` · Ref. ${esc(p.reference)}` : ''}</div></td>
    <td><b>${esc(p.brand)}</b><div class="sub clamp">${esc(p.category || 'Sin categoría publicada')}</div></td>
    <td><span class="availability ${p.available ? 'yes' : 'no'}">${p.available ? 'Disponible' : 'Sin existencia'}</span></td>
    <td class="price-cell"><b>${money(p.price)}</b>${pct ? `<span class="discount">-${pct}%</span><del>${money(p.list)}</del>` : ''}</td>
    <td class="actions"><button class="button secondary" data-open="${esc(p.id)}">Ver</button><button class="button primary" data-add="${esc(p.id)}" title="Añadir al presupuesto">+</button></td></tr>`;
}

function render() {
  const list = filtered();
  const activeFilters = mode === 'discounts' ? [promoBrands, promoCategories].filter(filter => filter !== null).length : 0;
  $('#count').textContent = mode === 'discounts'
    ? `${list.length} de ${products.length} producto${products.length === 1 ? '' : 's'} con descuento${activeFilters ? ` · ${activeFilters} filtro${activeFilters === 1 ? '' : 's'}` : ''}${promotionStatus}`
    : loading ? 'Consultando Walmart…' : `${list.length} producto${list.length === 1 ? '' : 's'}`;
  const hideMore = mode === 'discounts' || exhausted || loading || (mode === 'catalog' && query.trim().length < 2);
  $('#more').hidden = hideMore;
  $('#more').style.display = hideMore ? 'none' : 'inline-block';
  $('#more').textContent = loading ? 'Consultando…' : mode === 'discounts' ? 'Cargar más promociones' : 'Cargar más resultados';
  if (!list.length) {
    const message = loading ? 'Consultando el catálogo oficial…' : mode === 'discounts' ? 'No hay promociones publicadas en los lotes consultados.' : query.trim().length < 2 ? 'Escribe al menos dos caracteres para buscar en Walmart.' : 'No se encontraron productos con esos criterios.';
    $('#results').innerHTML = `<div class="empty">${message}</div>`; return;
  }
  const arrow = key => promoSortKey === key ? (promoSortDir > 0 ? ' ▲' : ' ▼') : '';
  const head = (label, key) => `<button class="promo-sort" data-promo-sort="${key}">${label}${arrow(key)}</button>`;
  const filter = kind => `<button class="promo-filter ${promoFilterSet(kind) !== null ? 'active' : ''}" data-promo-filter="${kind}" title="Filtrar">▾</button>`;
  const discountsHeader = `<tr><th></th><th class="promo-head">${head('Producto', 'name')}</th><th class="promo-head">${head('Marca', 'brand')}${filter('brand')}</th><th class="promo-head">${head('Categoría', 'category')}${filter('category')}</th><th class="right promo-head">${head('Precio actual', 'price')}</th><th class="right promo-head">${head('Precio lista', 'list')}</th><th class="right promo-head">${head('Ahorro', 'saving')}</th><th class="promo-head">${head('Descuento', 'discount')}</th><th></th></tr>`;
  const catalogHeader = '<tr><th></th><th>Producto</th><th>Marca / categoría</th><th>Disponibilidad</th><th class="right">Precio</th><th></th></tr>';
  $('#results').innerHTML = `<table class="${mode === 'discounts' ? 'promo-table' : ''}"><thead>${mode === 'discounts' ? discountsHeader : catalogHeader}</thead><tbody>${list.map(row).join('')}</tbody></table>`;
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
  const sort = event.target.closest('[data-promo-sort]');
  const filterButton = event.target.closest('[data-promo-filter]');
  const filterAction = event.target.closest('[data-promo-filter-action]');
  if (sort) {
    const key = sort.dataset.promoSort;
    promoSortDir = promoSortKey === key ? -promoSortDir : (['price', 'list', 'saving', 'discount'].includes(key) ? -1 : 1);
    promoSortKey = key; render(); return;
  }
  if (filterButton) { openPromoFilter(filterButton.dataset.promoFilter, filterButton); return; }
  if (filterAction && activePromoFilter) {
    const values = promoFilterValues(activePromoFilter);
    setPromoFilterSet(activePromoFilter, filterAction.dataset.promoFilterAction === 'all' || filterAction.dataset.promoFilterAction === 'reset' ? null : new Set());
    renderPromoFilterPopover(); render(); return;
  }
  if (event.target.id === 'promo-filter-close') { closePromoFilter(); return; }
  if (activePromoFilter && !event.target.closest('#promo-filter-popover')) closePromoFilter();
  const open = event.target.closest('[data-open]'), add = event.target.closest('[data-add]'), qty = event.target.closest('[data-qty]'), image = event.target.closest('[data-image]');
  if (open) openModal(open.dataset.open); if (add) addBudget(add.dataset.add); if (qty) changeQty(qty.dataset.qty, Number(qty.dataset.change));
  if (image) { $('#main-image').src = image.dataset.image; document.querySelectorAll('.thumb').forEach(x => x.classList.toggle('selected', x === image)); }
  if (event.target.id === 'close-modal' || event.target.id === 'modal') $('#modal').classList.remove('open');
});
document.addEventListener('change', event => {
  const input = event.target.closest('[data-promo-filter-item]');
  if (!input || !activePromoFilter) return;
  const values = promoFilterValues(activePromoFilter);
  let selected = promoFilterSet(activePromoFilter) || new Set(values);
  if (input.checked) selected.add(input.value); else selected.delete(input.value);
  setPromoFilterSet(activePromoFilter, selected.size === values.length ? null : selected);
  renderPromoFilterPopover(); render();
});
setupPromotionControls();
$('#promo-filter-search')?.addEventListener('input', renderPromoFilterPopover);
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('#modal').classList.remove('open'); });
$('#page-title').textContent = mode === 'discounts' ? 'Promociones' : 'Presupuestos';
$('#promo-link').href = mode === 'discounts' ? '/ferreterias/walmart/presupuestos/' : '/ferreterias/walmart/descuentos/';
$('#promo-link').textContent = mode === 'discounts' ? '📋 Ver catálogo' : '🏷️ Ver promociones';
$('#query').placeholder = mode === 'discounts' ? 'Filtrar promociones cargadas por producto, marca o SKU…' : 'Buscar por producto, marca, SKU o EAN…';
$('#only-discount-wrap').hidden = mode === 'discounts';
$('#reload-promotions')?.addEventListener('click', () => loadPromotions(true));
renderBudget(); if (mode === 'discounts') loadPromotions(); else render();
