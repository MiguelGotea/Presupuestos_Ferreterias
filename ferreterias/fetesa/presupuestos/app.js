// ── CONFIGURACIÓN ──────────────────────────────────────────────────────────
// Proxy en server.js: /api/fetesa/ → https://fetesa.com.ni/
// Búsqueda: /?s=QUERY&et_search=true&post_type=product&paged=PAGE
// Producto: /producto/SLUG/
const API_SEARCH = '/api/fetesa/';
const PER_PAGE = 12; // Fetesa muestra aprox 12 por página

const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const money = n => 'C$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc   = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct   = (p, l) => l > p ? Math.round((1 - p / l) * 100) : 0;

let products = [], totalEstimate = 0, page = 1, query = '', sortKey = null, sortDir = 1;
let ctrl = null, timer = null;
let showDiscOnly = false;
let selectedCats = null; // null = sin filtro; Set = categorías

const pool = new Map();
let budget = JSON.parse(localStorage.getItem('fetesa-budget') || '[]');

// ── PARSEAR HTML DE BÚSQUEDA (WooCommerce / Elegant Themes) ────────────────
function parseSearchHTML(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const items = [];

  // WooCommerce shop loop: ul.products > li.product  ó  .et_pb_shop .et_pb_product
  const cards = doc.querySelectorAll('li.product, .et_pb_product');

  cards.forEach(card => {
    try {
      // Nombre
      const titleEl = card.querySelector('h2, h3, .woocommerce-loop-product__title, .entry-title a, .et_pb_module_header a');
      const name = titleEl ? titleEl.textContent.trim() : '';
      if (!name) return;

      // Enlace / slug
      const linkEl = card.querySelector('a.woocommerce-LoopProduct-link, a[href*="/producto/"], .et_pb_module_header a, h2 a, h3 a');
      const link = linkEl ? linkEl.getAttribute('href') : '';

      // Slug como ID
      const slugMatch = link.match(/\/producto\/([^/]+)\//);
      const id = slugMatch ? slugMatch[1] : (name.toLowerCase().replace(/[^a-z0-9]/g, '-'));

      // Imagen
      const imgEl = card.querySelector('img');
      let image = imgEl ? (imgEl.dataset.src || imgEl.getAttribute('src') || '') : '';
      // Evitar data URIs/placeholders
      if (image.startsWith('data:')) image = '';

      // Precio — WooCommerce puede tener: ins (precio rebajado) + del (precio tachado)
      let price = 0, listPrice = 0;
      const insDel = card.querySelector('.price ins .amount, .price .ins .amount');
      const delEl  = card.querySelector('.price del .amount, .price .del .amount');
      const priceEl = card.querySelector('.price .amount');

      if (insDel) {
        price = parsePrice(insDel.textContent);
        if (delEl) listPrice = parsePrice(delEl.textContent);
      } else if (priceEl) {
        price = parsePrice(priceEl.textContent);
      }

      // Categoría (si aparece en la card)
      const catEl = card.querySelector('.posted_in a, .et_pb_post_category a, .product-category a');
      const cat = catEl ? catEl.textContent.trim() : '';

      // Stock
      const stockEl = card.querySelector('.stock');
      const available = stockEl ? !stockEl.classList.contains('out-of-stock') : true;

      const raw = { id, name, link, image, price, listPrice, cat, available, images: image ? [image] : [], desc: '', sku: '', brand: '', attrs: {} };
      pool.set(id, raw);
      items.push(raw);
    } catch (_) { /* ignorar card con error */ }
  });

  // Intentar leer total de resultados (paginación de WooCommerce)
  const totalEl = doc.querySelector('.woocommerce-result-count');
  let total = items.length;
  if (totalEl) {
    const m = totalEl.textContent.match(/(\d+)\s*resultado/i);
    if (m) total = parseInt(m[1]);
  }

  return { items, total };
}

// ── PARSEAR HTML DE DETALLE DE PRODUCTO ────────────────────────────────────
function parseProductHTML(html, id) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const p = pool.get(id) || {};

  // Nombre
  const nameEl = doc.querySelector('h1.product_title, h1.entry-title');
  if (nameEl) p.name = nameEl.textContent.trim();

  // Precio
  const insDel = doc.querySelector('p.price ins .amount, .price .ins .amount');
  const delEl  = doc.querySelector('p.price del .amount, .price .del .amount');
  const priceEl = doc.querySelector('p.price .amount');
  if (insDel) {
    p.price = parsePrice(insDel.textContent);
    if (delEl) p.listPrice = parsePrice(delEl.textContent);
  } else if (priceEl) {
    p.price = parsePrice(priceEl.textContent);
  }

  // SKU
  const skuEl = doc.querySelector('.sku');
  if (skuEl) p.sku = skuEl.textContent.trim();

  // Marca
  const brandEl = doc.querySelector('.posted_in a, .product_meta .brand a, .pa_marca a, .pa_brand a');
  if (brandEl) p.brand = brandEl.textContent.trim();

  // Categorías
  const catEls = doc.querySelectorAll('.posted_in a');
  p.cats = [...catEls].map(e => e.textContent.trim()).filter(Boolean);
  if (!p.cat && p.cats.length) p.cat = p.cats[p.cats.length - 1];

  // Disponibilidad
  const stockEl = doc.querySelector('p.stock');
  p.available = stockEl ? !stockEl.classList.contains('out-of-stock') : true;

  // Imágenes (galería WooCommerce)
  const imgs = new Set();
  doc.querySelectorAll('.woocommerce-product-gallery__image img, .flex-control-nav img, .woocommerce-product-gallery img').forEach(img => {
    const src = img.dataset.large_image || img.dataset.src || img.getAttribute('src') || '';
    if (src && !src.startsWith('data:')) imgs.add(src);
  });
  if (imgs.size) p.images = [...imgs];
  if (!p.image && p.images && p.images.length) p.image = p.images[0];

  // Descripción corta
  const shortDesc = doc.querySelector('.woocommerce-product-details__short-description');
  p.desc = shortDesc ? shortDesc.textContent.trim() : '';

  // Tabla de atributos / especificaciones
  const attrs = {};
  doc.querySelectorAll('table.shop_attributes tr, table.woocommerce-product-attributes tr').forEach(row => {
    const th = row.querySelector('th');
    const td = row.querySelector('td');
    if (th && td) attrs[th.textContent.trim()] = td.textContent.trim();
  });
  p.attrs = attrs;

  pool.set(id, p);
  return p;
}

// ── PARSEO DE PRECIO (C$1,234.56 → 1234.56) ───────────────────────────────
function parsePrice(str) {
  if (!str) return 0;
  // Eliminar símbolo de moneda y espacios, luego parsear
  const clean = str.replace(/[^0-9.,]/g, '').trim();
  // Si tiene coma Y punto: coma=miles, punto=decimal  →  1,234.56
  // Si solo coma: puede ser decimal (europeo) →  1234,56
  if (clean.includes('.') && clean.includes(',')) {
    return parseFloat(clean.replace(/,/g, ''));
  }
  if (clean.includes(',') && !clean.includes('.')) {
    // Verificar si coma separa decimales (2 dígitos al final) o miles
    const parts = clean.split(',');
    if (parts[parts.length - 1].length === 2) {
      return parseFloat(clean.replace(',', '.'));
    }
    return parseFloat(clean.replace(/,/g, ''));
  }
  return parseFloat(clean) || 0;
}

// ── BÚSQUEDA ───────────────────────────────────────────────────────────────
async function search(reset = true) {
  if (reset) { page = 1; products = []; selectedCats = null; }
  if (query.length < 2) { render(); return; }
  ctrl?.abort(); ctrl = new AbortController();
  $('#count').textContent = 'Buscando…';
  try {
    const url = `${API_SEARCH}?s=${encodeURIComponent(query)}&et_search=true&post_type=product&paged=${page}`;
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    const { items, total } = parseSearchHTML(html);
    products = products.concat(items);
    totalEstimate = total;
    render();
  } catch (e) {
    if (e.name === 'AbortError') return;
    $('#results').innerHTML = `<div class="empty">Error: ${esc(e.message)}. Verifica que server.js está corriendo.</div>`;
    $('#count').textContent = '';
  }
}

// ── RENDER ─────────────────────────────────────────────────────────────────
function render() {
  let list = products.slice();
  if (selectedCats !== null) list = list.filter(p => selectedCats.has(p.cat || 'Sin categoría'));
  if (showDiscOnly) list = list.filter(p => p.listPrice > p.price);
  if (sortKey) {
    list.sort((a, b) => {
      let va = a[sortKey] ?? '';
      let vb = b[sortKey] ?? '';
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      return (va > vb ? 1 : -1) * sortDir;
    });
  }

  const filtersActive = [];
  if (showDiscOnly) filtersActive.push('con descuento');
  if (selectedCats !== null) filtersActive.push(`categorías (${selectedCats.size})`);
  const label = filtersActive.length ? ` (${filtersActive.join(', ')})` : '';
  $('#count').textContent = query.length < 2 ? '' : `${list.length}${label} de ${totalEstimate || products.length}`;

  const empty = query.length < 2 ? 'Empieza a escribir para buscar productos.'
    : (filtersActive.length ? 'Ningún resultado coincide con los filtros aplicados.' : 'Sin resultados.');

  if (!list.length) {
    $('#results').innerHTML = `<div class="empty">${empty}</div>`;
    $('#more').hidden = true;
    return;
  }
  const arrow = k => sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : '';

  $('#results').innerHTML =
    `<table><thead><tr>
      <th></th>
      <th><span class="th-sort" data-k="name">Producto${arrow('name')}</span></th>
      <th><span class="th-sort" data-k="cat">Categoría${arrow('cat')}</span></th>
      <th style="text-align:right"><span class="th-sort" data-k="price">Precio${arrow('price')}</span></th>
      <th></th>
    </tr></thead><tbody>` +
    list.map(productRow).join('') + '</tbody></table>';

  // Mostrar botón "más" si es posible que haya más páginas
  $('#more').hidden = products.length >= totalEstimate;
}

function productRow(p) {
  const d = pct(p.price, p.listPrice);
  return `<tr>
    <td class="img-cell"><img loading="lazy" src="${esc(p.image || '')}" data-open="${esc(p.id)}" alt="" onerror="this.src='';this.style.display='none'"></td>
    <td>
      <div class="name">${esc(p.name)}</div>
      ${p.sku ? `<div class="sub">SKU: ${esc(p.sku)}</div>` : '<div class="sub">&nbsp;</div>'}
    </td>
    <td style="font-size:12px">${p.cat ? `<span class="cat-badge">${esc(p.cat)}</span>` : '<span style="color:var(--mu)">—</span>'}</td>
    <td class="price-col">
      ${p.price ? money(p.price) : '<span style="color:var(--mu)">S/P</span>'}${d > 0 ? `<span class="badge-disc">-${d}%</span>` : ''}
      ${p.listPrice > p.price ? `<div class="list-price">${money(p.listPrice)}</div>` : ''}
      <div>${!p.available ? '<span class="badge-avail avail-no">Agotado</span>' : '<span class="badge-avail avail-yes">Disponible</span>'}</div>
    </td>
    <td style="white-space:nowrap">
      <button class="btn btn-sec btn-table-ver" data-open="${esc(p.id)}">Ver</button>
      <button class="btn btn-primary btn-table-add" data-add="${esc(p.id)}" title="Añadir al presupuesto">+</button>
    </td>
  </tr>`;
}

// ── MODAL ──────────────────────────────────────────────────────────────────
async function openModal(id) {
  const p = pool.get(id) || budget.find(x => x.id === id);
  if (!p) return;

  // Mostrar modal con datos básicos primero
  renderModal(p);
  $('#modal').classList.add('on');

  // Si no tenemos detalle completo, cargar la página de producto
  if (!p._loaded && p.link) {
    try {
      // Convertir link absoluto a ruta proxy
      const proxyPath = p.link.replace('https://fetesa.com.ni', '/api/fetesa');
      const r = await fetch(proxyPath);
      if (r.ok) {
        const html = await r.text();
        const updated = parseProductHTML(html, id);
        updated._loaded = true;
        pool.set(id, updated);
        renderModal(updated);
      }
    } catch (_) { /* usar datos básicos */ }
  }
}

function renderModal(p) {
  const imgs = p.images?.length ? p.images : (p.image ? [p.image] : []);
  const d = pct(p.price, p.listPrice), saving = p.listPrice > p.price ? p.listPrice - p.price : 0;
  const catsHtml = (p.cats || (p.cat ? [p.cat] : [])).map(c => `<span class="cat-badge">${esc(c)}</span>`).join(' ');
  const attrRows = Object.entries(p.attrs || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');

  $('#mbox').innerHTML = `
    <div class="modal-top">
      <div class="modal-gallery">
        <img class="big-img" id="big" src="${esc(imgs[0] || '')}" alt="" onerror="this.style.display='none'">
        <div class="thumbs">${imgs.map((u, i) => `<img src="${esc(u)}" data-img="${esc(u)}" class="${i === 0 ? 'on' : ''}" alt="" onerror="this.style.display='none'">`).join('')}</div>
      </div>
      <div class="modal-info">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="modal-brand">${esc(p.brand || 'Fetesa')}</div>
          <button class="btn btn-sec btn-sm" id="close">✕ Cerrar</button>
        </div>
        <div class="modal-name">${esc(p.name)}</div>
        <div class="modal-price-block">
          <div class="modal-price">${p.price ? money(p.price) : 'Sin precio'}</div>
          ${d > 0 ? `<span class="badge-disc">-${d}%</span>` : ''}
        </div>
        ${p.listPrice > p.price ? `<div>
          <div class="modal-list-price">Lista: ${money(p.listPrice)}</div>
          <div class="modal-disc-pct">Ahorras ${money(saving)}</div>
        </div>` : ''}
        <div>
          <span class="badge-avail ${p.available ? 'avail-yes' : 'avail-no'}">${p.available ? '✔ Disponible' : '✖ Agotado'}</span>
        </div>
        ${catsHtml ? `<div style="margin-top:2px">${catsHtml}</div>` : ''}
        <div class="modal-top-actions">
          <button class="btn btn-primary" data-add="${esc(p.id)}">+ Añadir al presupuesto</button>
          ${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener" class="btn btn-sec">Abrir en Fetesa ↗</a>` : ''}
        </div>
      </div>
    </div>
    <div class="modal-bottom">
      ${p.sku ? `<div class="section-label">Identificación</div>
      <table class="specs-table">
        <tr><td>SKU</td><td><code>${esc(p.sku)}</code></td></tr>
        ${p.brand ? `<tr><td>Marca</td><td>${esc(p.brand)}</td></tr>` : ''}
      </table>` : ''}
      ${attrRows ? `<div class="section-label">Especificaciones</div><table class="specs-table">${attrRows}</table>` : ''}
      ${p.desc ? `<div class="section-label">Descripción</div><div class="modal-desc">${esc(p.desc)}</div>` : ''}
      ${!p._loaded ? '<div style="font-size:11px;color:var(--mu);text-align:center;padding:8px">Cargando detalles…</div>' : ''}
    </div>`;
}

// ── PRESUPUESTO ────────────────────────────────────────────────────────────
function save() { localStorage.setItem('fetesa-budget', JSON.stringify(budget)); renderBudget(); }
function add(id) {
  const ex = budget.find(b => b.id === id);
  if (ex) { ex.qty++; } else { const p = pool.get(id); if (p) budget.push({ ...p, qty: 1 }); }
  save();
  const panel = $('#budget-panel');
  panel.style.boxShadow = '0 0 0 3px #c0392b';
  setTimeout(() => panel.style.boxShadow = '', 700);
}

function renderBudget() {
  const grand = budget.reduce((s, b) => s + (b.price || 0) * b.qty, 0);
  const discSave = budget.reduce((s, b) => b.listPrice > b.price ? s + (b.listPrice - b.price) * b.qty : s, 0);
  $('#nitems').textContent = budget.length + (budget.length === 1 ? ' ítem' : ' ítems');
  $('#total').textContent = money(grand);
  if (!budget.length) { $('#budget').innerHTML = '<div class="empty">Añade productos con "+".</div>'; return; }
  $('#budget').innerHTML = `
    <table>
      <thead><tr>
        <th></th><th>Producto</th>
        <th style="text-align:center">Precio c/u</th>
        <th style="text-align:center">Cant.</th>
        <th style="text-align:right">Subtotal</th>
        <th></th>
      </tr></thead>
      <tbody>${budget.map(b => {
        const d = pct(b.price, b.listPrice);
        return `<tr>
          <td class="img-cell"><img src="${esc(b.image || '')}" data-open="${esc(b.id)}" alt="" onerror="this.style.display='none'"></td>
          <td>
            <div class="name" style="font-size:11px">${esc(b.name)}</div>
            <div class="sub">${esc(b.cat || '')}${d > 0 ? ` <span class="badge-disc">-${d}%</span>` : ''}</div>
          </td>
          <td class="budget-unit-cell">
            <div class="bud-cu">${b.price ? money(b.price) : 'S/P'}</div>
          </td>
          <td style="text-align:center">
            <input class="qty-input" type="number" min="1" value="${b.qty}" data-qty="${esc(b.id)}">
          </td>
          <td class="budget-subtotal">${b.price ? money(b.price * b.qty) : '—'}</td>
          <td><button class="x-btn" data-del="${esc(b.id)}" title="Quitar">✕</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    ${discSave > 0 ? `<div style="padding:7px 14px;font-size:11px;color:var(--od);font-weight:600;background:var(--ob);border-top:1px solid #f5cba7">🏷️ Ahorras ${money(discSave)} en descuentos</div>` : ''}`;
}

// ── TOGGLE SOLO DESCUENTO ──────────────────────────────────────────────────
$('#toggle-disc').addEventListener('click', () => {
  showDiscOnly = !showDiscOnly;
  $('#toggle-disc').classList.toggle('on', showDiscOnly);
  render();
});

// ── EVENTOS ────────────────────────────────────────────────────────────────
$('#q').addEventListener('input', e => {
  clearTimeout(timer);
  timer = setTimeout(() => { query = e.target.value.trim(); search(true); }, 320);
});

$('#more').addEventListener('click', () => { page++; search(false); });

document.addEventListener('click', e => {
  const t = e.target;
  if (t.dataset.open) { openModal(t.dataset.open); return; }
  if (t.dataset.add)  { add(t.dataset.add); return; }
  if (t.dataset.del)  { budget = budget.filter(b => b.id !== t.dataset.del); save(); return; }
  if (t.dataset.k)    { sortDir = sortKey === t.dataset.k ? -sortDir : 1; sortKey = t.dataset.k; render(); return; }
  if (t.dataset.img)  { $('#big').src = t.dataset.img; $$('.thumbs img').forEach(i => i.classList.toggle('on', i === t)); return; }
  if (t.id === 'close' || t.id === 'modal') $('#modal').classList.remove('on');
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $('#modal').classList.remove('on');
});

document.addEventListener('change', e => {
  if (e.target.dataset.qty) {
    const b = budget.find(x => x.id === e.target.dataset.qty);
    if (b) { b.qty = Math.max(1, +e.target.value || 1); save(); }
  }
});

$('#clear').onclick = () => { if (confirm('¿Vaciar presupuesto?')) { budget = []; save(); } };
$('#print').onclick = () => window.print();

renderBudget();
