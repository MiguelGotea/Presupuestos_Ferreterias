// ── CONFIGURACIÓN ──────────────────────────────────────────────────────────
// El servidor navega fetesa.com.ni con Chrome real (bypasa CF) y extrae
// los productos del DOM HTML (evita /wp-json/ bloqueado por Firewall Rules).
const API_SEARCH  = '/api/fetesa/search';   // ?q=QUERY&page=N
const API_PRODUCT = '/api/fetesa/product';  // ?url=PRODUCT_URL
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

// ── NORMALIZAR PRODUCTO (scraping HTML vía Chrome) ─────────────────────────
// El servidor ya devuelve objetos normalizados; solo aseguramos tipos y pool.
function norm(p) {
  const raw = {
    id:        String(p.id || p.slug || p.name),
    name:      p.name      || '',
    slug:      p.slug      || '',
    link:      p.link      || '',
    sku:       p.sku       || '',
    brand:     p.brand     || '',
    price:     Number(p.price)     || 0,
    listPrice: Number(p.listPrice) || 0,
    available: p.available !== false,
    image:     p.image     || (p.images?.[0]) || '',
    images:    p.images    || (p.image ? [p.image] : []),
    cats:      p.cats      || (p.cat ? [p.cat] : []),
    cat:       p.cat       || '',
    desc:      p.desc      || '',
    attrs:     p.attrs     || {},
    _loaded:   true,
  };
  pool.set(raw.id, raw);
  return raw;
}


// ── BÚSQUEDA ───────────────────────────────────────────────────────────────
async function search(reset = true) {
  if (reset) { page = 1; products = []; selectedCats = null; }
  if (query.length < 2) { render(); return; }
  ctrl?.abort(); ctrl = new AbortController();
  $('#count').textContent = 'Buscando… (Chrome abriendo Fetesa, puede tomar ~20s la primera vez)';
  try {
    const url = `${API_SEARCH}?q=${encodeURIComponent(query)}&page=${page}`;
    const r = await fetch(url, { signal: ctrl.signal });

    if (r.status === 503) {
      const j = await r.json().catch(() => ({}));
      $('#results').innerHTML = `<div class="empty" style="line-height:2">
        🛡️ <strong>Fetesa protegida por Cloudflare</strong><br>
        <span style="font-size:11px;color:var(--mu)">${esc(j.message || 'El servidor del VPS no puede acceder a fetesa.com.ni')}</span><br><br>
        <a href="https://fetesa.com.ni/?s=${encodeURIComponent(query)}&et_search=true&post_type=product" target="_blank" rel="noopener" class="btn btn-primary" style="font-size:12px">🌐 Buscar directamente en Fetesa ↗</a>
      </div>`;
      $('#count').textContent = '';
      return;
    }

    if (!r.ok) throw new Error('HTTP ' + r.status);

    const data = await r.json();
    if (!data?.items) throw new Error(data?.error || 'Respuesta inesperada del servidor');

    products = products.concat(data.items.map(norm));
    totalEstimate = data.total || products.length;
    render();

  } catch (e) {
    if (e.name === 'AbortError') return;
    $('#results').innerHTML = `<div class="empty" style="line-height:1.9">
      🛡️ <strong>Fetesa.com.ni bloqueó el acceso</strong><br>
      <span style="font-size:11px;color:var(--mu)">Cloudflare bloquea las IPs de servidor (DigitalOcean).</span><br>
      <a href="https://fetesa.com.ni/?s=${encodeURIComponent(query)}&et_search=true&post_type=product" target="_blank" rel="noopener" class="btn btn-primary" style="font-size:12px;margin-top:8px">🌐 Abrir en Fetesa ↗</a>
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

  // Cargar detalle completo via Chrome si no se cargó aún
  if (!p._detailLoaded && p.link) {
    try {
      const r = await fetch(`${API_PRODUCT}?url=${encodeURIComponent(p.link)}`);
      if (r.ok) {
        const detail = await r.json();
        if (detail.name) {
          const updated = norm({ ...p, ...detail, id: p.id });
          updated._detailLoaded = true;
          pool.set(p.id, updated);
          renderModal(updated);
        }
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
