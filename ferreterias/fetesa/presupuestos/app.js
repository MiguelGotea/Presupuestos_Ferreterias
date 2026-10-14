// ── CONFIGURACIÓN ──────────────────────────────────────────────────────────
// Fetesa bloquea el VPS y no tiene CORS headers. Solución: CORS proxies
// públicos que hacen el fetch desde IPs residenciales/no-VPS.
// Se prueban en orden hasta que uno funcione.
const FETESA_API = 'https://fetesa.com.ni/wp-json/wc/store/v1/products';

// CORS proxies públicos (se prueban en orden)
const CORS_WRAPPERS = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `/api/fetesa/wp-json/wc/store/v1/products${url.includes('?') ? url.slice(url.indexOf('?')) : ''}`, // VPS como último recurso
];
const PER_PAGE = 12;

const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const money = n => 'C$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc   = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct   = (p, l) => l > p ? Math.round((1 - p / l) * 100) : 0;
const stripHtml = s => s ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
const parseMoney = s => parseFloat(String(s || '0').replace(/[^0-9.]/g, '')) || 0;

let products = [], totalEstimate = 0, page = 1, query = '', sortKey = null, sortDir = 1;
let ctrl = null, timer = null;
let showDiscOnly = false;
let selectedCats = null;

const pool = new Map();
let budget = JSON.parse(localStorage.getItem('fetesa-budget') || '[]');

// ── NORMALIZAR PRODUCTO (WooCommerce Store API v1) ─────────────────────────
function norm(p) {
  const prices  = p.prices || {};
  const price   = parseMoney(prices.price);
  const regular = parseMoney(prices.regular_price);
  const listPrice = regular > price ? regular : 0;

  const images = (p.images || []).map(i => i.src || i.thumbnail || '').filter(Boolean);

  const cats = (p.categories || []).map(c => c.name).filter(Boolean);
  const cat  = cats[cats.length - 1] || '';

  const attrs = {};
  (p.attributes || []).forEach(a => {
    if (a.name && a.terms?.length) attrs[a.name] = a.terms.map(t => t.name).join(', ');
  });

  const raw = {
    id:        String(p.id),
    name:      p.name || '',
    slug:      p.slug || '',
    link:      p.permalink || '',
    sku:       p.sku || '',
    brand:     '',
    price,
    listPrice,
    available: p.is_in_stock !== false,
    image:     images[0] || '',
    images,
    cats,
    cat,
    desc:      stripHtml(p.short_description || p.description || ''),
    attrs,
    _loaded:   true,
  };
  pool.set(raw.id, raw);
  return raw;
}

// ── PROXY ACTIVO (persiste entre búsquedas) ────────────────────────────────
let workingProxyIdx = 0; // empieza por corsproxy.io

async function fetchWithProxy(apiUrl, signal) {
  // Intentar desde el proxy actual; si falla, probar el siguiente
  for (let i = workingProxyIdx; i < CORS_WRAPPERS.length; i++) {
    const proxyUrl = CORS_WRAPPERS[i](apiUrl);
    try {
      const r = await fetch(proxyUrl, { signal });
      if (r.ok || r.status === 404) {
        workingProxyIdx = i; // guardar el que funcionó
        return r;
      }
      // 403/429 → intentar siguiente proxy
      console.warn(`Proxy ${i} falló con ${r.status}, intentando siguiente…`);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn(`Proxy ${i} error: ${e.message}, intentando siguiente…`);
    }
  }
  throw new Error('Todos los proxies fallaron. Fetesa puede estar caído o bloqueando completamente.');
}

// ── BÚSQUEDA ───────────────────────────────────────────────────────────────
async function search(reset = true) {
  if (reset) { page = 1; products = []; selectedCats = null; workingProxyIdx = 0; }
  if (query.length < 2) { render(); return; }
  ctrl?.abort(); ctrl = new AbortController();
  $('#count').textContent = 'Buscando…';
  try {
    const apiUrl = `${FETESA_API}?search=${encodeURIComponent(query)}&per_page=${PER_PAGE}&page=${page}&_fields=id,name,slug,permalink,sku,prices,images,categories,attributes,is_in_stock,short_description`;
    const r = await fetchWithProxy(apiUrl, ctrl.signal);

    const total = parseInt(r.headers.get('X-WP-Total') || r.headers.get('x-wp-total') || '0');
    const data  = await r.json();

    if (!Array.isArray(data)) {
      throw new Error(data?.message || data?.code || 'Respuesta inesperada');
    }

    const items = data.map(norm);
    products = products.concat(items);
    totalEstimate = total || products.length;
    render();

  } catch (e) {
    if (e.name === 'AbortError') return;
    $('#results').innerHTML = `<div class="empty" style="line-height:1.9">
      ❌ <strong>No se pudo conectar a Fetesa</strong><br>
      <span style="font-size:11px;color:var(--mu)">${esc(e.message)}</span><br><br>
      <button class="btn btn-primary" onclick="workingProxyIdx=0;search(true)" style="font-size:12px">🔄 Reintentar todos los proxies</button>
    </div>`;
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
  $('#count').textContent = query.length < 2 ? '' : `${list.length}${label} de ${totalEstimate}`;

  const empty = query.length < 2 ? 'Empieza a escribir para buscar productos.'
    : (filtersActive.length ? 'Ningún resultado coincide con los filtros aplicados.' : 'Sin resultados para esta búsqueda en Fetesa.');

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

  // Más resultados si hay más páginas (12 por página)
  $('#more').hidden = products.length >= totalEstimate;
}

function productRow(p) {
  const d = pct(p.price, p.listPrice);
  return `<tr>
    <td class="img-cell"><img loading="lazy" src="${esc(p.image)}" data-open="${esc(p.id)}" alt="" onerror="this.src='';this.style.display='none'"></td>
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
  renderModal(p);
  $('#modal').classList.add('on');

  // Cargar detalle completo si no se ha cargado (atributos extras)
  if (!p._detailLoaded) {
    try {
      const r = await fetch(`${API_PRODUCTS}/${id}`);
      if (r.ok) {
        const data = await r.json();
        const updated = norm(data);
        updated._detailLoaded = true;
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
      </table>` : ''}
      ${attrRows ? `<div class="section-label">Especificaciones</div><table class="specs-table">${attrRows}</table>` : ''}
      ${p.desc ? `<div class="section-label">Descripción</div><div class="modal-desc">${esc(p.desc)}</div>` : ''}
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
