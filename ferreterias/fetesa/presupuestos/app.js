// ferreterias/fetesa/presupuestos/app.js
// Lee el JSON estático y permite buscar/filtrar/presupuestar localmente.

const DATA_URL = '/ferreterias/fetesa/data/productos.json';
const PAGE_SIZE = 24;

const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const money = n => 'C$' + Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
const esc   = s => String(s??'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pct   = (p,l) => l > p ? Math.round((1-p/l)*100) : 0;

// ── Estado ────────────────────────────────────────────────────────────────────
let allProducts  = [];   // catálogo completo
let filtered     = [];   // resultado del filtro actual
let pageEnd      = PAGE_SIZE;
let query        = '';
let showDiscOnly = false;
let selectedCats = null; // null = todas; Set = categorías seleccionadas
let sortKey      = null, sortDir = 1;
let activeFilterCol = null, activeFilterBtn = null;
let timer        = null;

const pool   = new Map();
let budget   = JSON.parse(localStorage.getItem('fetesa-budget') || '[]');

// ── Cargar datos ──────────────────────────────────────────────────────────────
async function loadData() {
  try {
    const r = await fetch(DATA_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    allProducts = (data.products || []);
    allProducts.forEach(p => pool.set(p.id, p));

    if (data.generatedAt) {
      const d = new Date(data.generatedAt);
      $('#last-update').textContent = `📅 ${d.toLocaleDateString('es-NI')} ${d.toLocaleTimeString('es-NI',{hour:'2-digit',minute:'2-digit'})}`;
    }
    applyFilter();
  } catch(e) {
    $('#results').innerHTML = `<div class="empty">Error cargando catálogo: ${esc(e.message)}<br><small>Ejecuta el scraper para generar los datos.</small></div>`;
    $('#count').textContent = '';
  }
}

// ── Filtrar y ordenar ─────────────────────────────────────────────────────────
function applyFilter(reset = true) {
  if (reset) { pageEnd = PAGE_SIZE; }
  const q = query.toLowerCase();

  filtered = allProducts.filter(p => {
    if (showDiscOnly && !(p.listPrice > p.price)) return false;
    if (selectedCats !== null && !selectedCats.has(p.cat || 'Sin categoría')) return false;
    if (!q) return true;
    return (p.name||'').toLowerCase().includes(q) ||
           (p.sku||'').toLowerCase().includes(q)   ||
           (p.cat||'').toLowerCase().includes(q);
  });

  if (sortKey) {
    filtered.sort((a,b) => {
      let va = a[sortKey]??'', vb = b[sortKey]??'';
      if (typeof va==='string') va=va.toLowerCase();
      if (typeof vb==='string') vb=vb.toLowerCase();
      return (va>vb?1:-1)*sortDir;
    });
  }

  render();
}

// ── Render tabla ──────────────────────────────────────────────────────────────
function render() {
  const catActive = selectedCats !== null;
  const filtersActive = [];
  if (showDiscOnly) filtersActive.push('con descuento');
  if (catActive)   filtersActive.push(`categorías (${selectedCats.size})`);

  const label = filtersActive.length ? ` (${filtersActive.join(', ')})` : '';
  if (allProducts.length === 0) {
    $('#count').textContent = '';
  } else if (query.length < 1 && !filtersActive.length) {
    $('#count').textContent = `${allProducts.length} productos`;
  } else {
    $('#count').textContent = `${filtered.length}${label} de ${allProducts.length}`;
  }

  const visible = filtered.slice(0, pageEnd);
  if (!visible.length) {
    $('#results').innerHTML = `<div class="empty">${
      allProducts.length ? 'Sin resultados para tu búsqueda o filtros.' : 'Empieza a escribir para buscar productos.'
    }</div>`;
    $('#more').hidden = true;
    return;
  }

  const arrow = k => sortKey===k ? (sortDir>0?' ▲':' ▼') : '';
  $('#results').innerHTML =
    `<table><thead><tr>
      <th></th>
      <th><span class="th-sort" data-k="name">Producto${arrow('name')}</span></th>
      <th>
        <div class="th-content">
          <span class="th-sort" data-k="cat">Categoría${arrow('cat')}</span>
          <button type="button" class="th-filter-btn ${catActive?'active':''}" data-filter-col="cat" title="Filtrar por categoría">
            <span>Filtrar</span> <span>▾</span>
            ${catActive ? `<span class="filter-badge">${selectedCats.size}</span>` : ''}
          </button>
        </div>
      </th>
      <th style="text-align:right"><span class="th-sort" data-k="price">Precio${arrow('price')}</span></th>
      <th></th>
    </tr></thead><tbody>` +
    visible.map(productRow).join('') + '</tbody></table>';

  $('#more').hidden = pageEnd >= filtered.length;
}

function productRow(p) {
  const d = pct(p.price, p.listPrice);
  return `<tr>
    <td class="img-cell"><img loading="lazy" src="${esc(p.image)}" data-open="${esc(p.id)}" alt="" onerror="this.src='';this.style.display='none'"></td>
    <td>
      <div class="name">${esc(p.name)}</div>
      <div class="sub">${p.sku ? `SKU: ${esc(p.sku)}` : '&nbsp;'}</div>
    </td>
    <td style="font-size:12px">${p.cat ? `<span class="cat-badge">${esc(p.cat)}</span>` : '<span style="color:var(--mu)">—</span>'}</td>
    <td class="price-col">
      ${p.price ? money(p.price) : '<span style="color:var(--mu)">S/P</span>'}${d>0?`<span class="badge-disc">-${d}%</span>`:''}
      ${p.listPrice>p.price ? `<div class="list-price">${money(p.listPrice)}</div>` : ''}
      <div>${!p.available?'<span class="badge-avail avail-no">Agotado</span>':'<span class="badge-avail avail-yes">Disponible</span>'}</div>
    </td>
    <td style="white-space:nowrap">
      <button class="btn btn-sec btn-table-ver" data-open="${esc(p.id)}">Ver</button>
      <button class="btn btn-primary btn-table-add" data-add="${esc(p.id)}" title="Añadir al presupuesto">+</button>
    </td>
  </tr>`;
}

// ── Popover filtro categorías ─────────────────────────────────────────────────
function getCatItems() {
  const counts = new Map();
  allProducts.forEach(p => {
    const v = p.cat || 'Sin categoría';
    counts.set(v, (counts.get(v)||0)+1);
  });
  return [...counts.entries()].sort((a,b) => a[0].localeCompare(b[0],'es'));
}

function openFilterPopover(col, btn) {
  const pop = $('#col-filter-popover');
  if (activeFilterCol===col && pop.classList.contains('on')) { closeFilterPopover(); return; }
  activeFilterCol = col; activeFilterBtn = btn;
  $('#popover-title').textContent = 'Filtrar por Categoría';
  $('#popover-search').value = '';
  renderFilterItems();
  pop.classList.add('on');
  positionPopover();
}

function positionPopover() {
  const pop = $('#col-filter-popover');
  if (!activeFilterBtn || !pop.classList.contains('on')) return;
  const rect = activeFilterBtn.getBoundingClientRect();
  pop.style.top  = (rect.bottom+5)+'px';
  let left = rect.left;
  if (left+270 > window.innerWidth) left = window.innerWidth-280;
  pop.style.left = Math.max(10,left)+'px';
}

function closeFilterPopover() {
  $('#col-filter-popover').classList.remove('on');
  activeFilterCol = null; activeFilterBtn = null;
}

function renderFilterItems() {
  const items = getCatItems();
  const qFilter = ($('#popover-search').value||'').toLowerCase().trim();
  const filtered2 = items.filter(([n]) => !qFilter || n.toLowerCase().includes(qFilter));
  if (!filtered2.length) { $('#popover-list').innerHTML='<div style="padding:10px;text-align:center;color:var(--mu);font-size:11px">Sin opciones</div>'; return; }
  $('#popover-list').innerHTML = filtered2.map(([name, count]) => {
    const isChecked = selectedCats===null ? true : selectedCats.has(name);
    return `<label class="filter-item">
      <input type="checkbox" value="${esc(name)}" ${isChecked?'checked':''} data-filter-item="cat">
      <span class="filter-item-name" title="${esc(name)}">${esc(name)}</span>
      <span class="filter-item-count">(${count})</span>
    </label>`;
  }).join('');
}

$('#popover-close').onclick = closeFilterPopover;
$('#popover-all').onclick   = () => { selectedCats=null; renderFilterItems(); applyFilter(); };
$('#popover-none').onclick  = () => { selectedCats=new Set(); renderFilterItems(); applyFilter(); };
$('#popover-reset').onclick = () => { selectedCats=null; renderFilterItems(); applyFilter(); };
$('#popover-search').addEventListener('input', renderFilterItems);
$('#popover-list').addEventListener('change', e => {
  if (!e.target.dataset.filterItem) return;
  const all = getCatItems().map(i=>i[0]);
  if (selectedCats===null) selectedCats = new Set(all);
  if (e.target.checked) selectedCats.add(e.target.value);
  else selectedCats.delete(e.target.value);
  if (selectedCats.size===all.length) selectedCats=null;
  applyFilter();
});

window.addEventListener('resize', positionPopover);
window.addEventListener('scroll', positionPopover, true);

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(id) {
  const p = pool.get(id) || budget.find(x=>x.id===id);
  if (!p) return;
  const d = pct(p.price, p.listPrice), saving = p.listPrice>p.price ? p.listPrice-p.price : 0;
  $('#mbox').innerHTML = `
    <div class="modal-top">
      <div class="modal-gallery">
        <img class="big-img" id="big" src="${esc(p.image||'')}" alt="" onerror="this.style.display='none'">
        <div class="thumbs">${p.image?`<img src="${esc(p.image)}" class="on" alt="">`:''}</div>
      </div>
      <div class="modal-info">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="modal-brand">Fetesa Do It Center</div>
          <button class="btn btn-sec btn-sm" id="close">✕ Cerrar</button>
        </div>
        <div class="modal-name">${esc(p.name)}</div>
        <div class="modal-price-block">
          <div class="modal-price">${p.price ? money(p.price) : 'Sin precio'}</div>
          ${d>0?`<span class="badge-disc">-${d}%</span>`:''}
        </div>
        ${p.listPrice>p.price?`<div>
          <div class="modal-list-price">Lista: ${money(p.listPrice)}</div>
          <div class="modal-disc-pct">Ahorras ${money(saving)}</div>
        </div>`:''}
        <div>
          <span class="badge-avail ${p.available?'avail-yes':'avail-no'}">${p.available?'✔ Disponible':'✖ Agotado'}</span>
          ${p.cat?`<span class="cat-badge" style="margin-left:6px">${esc(p.cat)}</span>`:''}
        </div>
        <div class="modal-top-actions">
          <button class="btn btn-primary" data-add="${esc(p.id)}">+ Añadir al presupuesto</button>
          ${p.link?`<a href="${esc(p.link)}" target="_blank" rel="noopener" class="btn btn-sec">Abrir en Fetesa ↗</a>`:''}
        </div>
      </div>
    </div>
    <div class="modal-bottom">
      ${p.sku?`<div class="section-label">Identificación</div>
      <table class="specs-table"><tr><td>SKU</td><td><code>${esc(p.sku)}</code></td></tr></table>`:''}
    </div>`;
  $('#modal').classList.add('on');
}

// ── Presupuesto ───────────────────────────────────────────────────────────────
function save() { localStorage.setItem('fetesa-budget', JSON.stringify(budget)); renderBudget(); }
function add(id) {
  const ex = budget.find(b=>b.id===id);
  if (ex) { ex.qty++; } else { const p=pool.get(id); if(p) budget.push({...p, qty:1}); }
  save();
  const panel = $('#budget-panel');
  panel.style.boxShadow = '0 0 0 3px #c0392b';
  setTimeout(()=>panel.style.boxShadow='', 700);
}

function renderBudget() {
  const grand    = budget.reduce((s,b)=>s+(b.price||0)*b.qty, 0);
  const discSave = budget.reduce((s,b)=>b.listPrice>b.price?s+(b.listPrice-b.price)*b.qty:s, 0);
  $('#nitems').textContent = budget.length+(budget.length===1?' ítem':' ítems');
  $('#total').textContent  = money(grand);
  if (!budget.length) { $('#budget').innerHTML='<div class="empty">Añade productos con "+".</div>'; return; }
  $('#budget').innerHTML = `
    <table><thead><tr>
      <th></th><th>Producto</th>
      <th style="text-align:center">Precio c/u</th>
      <th style="text-align:center">Cant.</th>
      <th style="text-align:right">Subtotal</th>
      <th></th>
    </tr></thead>
    <tbody>${budget.map(b => {
      const d = pct(b.price, b.listPrice);
      return `<tr>
        <td class="img-cell"><img src="${esc(b.image||'')}" data-open="${esc(b.id)}" alt="" onerror="this.src='';this.style.display='none'"></td>
        <td>
          <div class="name" style="font-size:11px">${esc(b.name)}</div>
          <div class="sub">${esc(b.cat||'')}${d>0?` <span class="badge-disc">-${d}%</span>`:''}</div>
        </td>
        <td class="budget-unit-cell"><div class="bud-cu">${b.price?money(b.price):'S/P'}</div></td>
        <td style="text-align:center"><input class="qty-input" type="number" min="1" value="${b.qty}" data-qty="${esc(b.id)}"></td>
        <td class="budget-subtotal">${b.price?money(b.price*b.qty):'—'}</td>
        <td><button class="x-btn" data-del="${esc(b.id)}" title="Quitar">✕</button></td>
      </tr>`;
    }).join('')}</tbody></table>
    ${discSave>0?`<div style="padding:7px 14px;font-size:11px;color:var(--od);font-weight:600;background:var(--ob);border-top:1px solid #f5cba7">🏷️ Ahorras ${money(discSave)} en descuentos</div>`:''}`;
}

// ── Eventos ───────────────────────────────────────────────────────────────────
$('#toggle-disc').addEventListener('click', () => {
  showDiscOnly = !showDiscOnly;
  $('#toggle-disc').classList.toggle('on', showDiscOnly);
  applyFilter();
});

$('#q').addEventListener('input', e => {
  clearTimeout(timer);
  timer = setTimeout(()=>{ query=e.target.value.trim(); applyFilter(); }, 280);
});

$('#more').addEventListener('click', ()=>{ pageEnd+=PAGE_SIZE; render(); });

document.addEventListener('click', e => {
  const t = e.target;
  if (t.id==='popover-close' || t.closest('#popover-close')) { closeFilterPopover(); return; }
  const filterBtn = t.closest('[data-filter-col]');
  if (filterBtn) { openFilterPopover(filterBtn.dataset.filterCol, filterBtn); return; }
  if (!t.closest('#col-filter-popover') && !t.closest('[data-filter-col]')) closeFilterPopover();
  if (t.dataset.open) { openModal(t.dataset.open); return; }
  if (t.dataset.add)  { add(t.dataset.add); return; }
  if (t.dataset.del)  { budget=budget.filter(b=>b.id!==t.dataset.del); save(); return; }
  if (t.dataset.k)    { sortDir=sortKey===t.dataset.k?-sortDir:1; sortKey=t.dataset.k; render(); return; }
  if (t.dataset.img)  { $('#big').src=t.dataset.img; $$('.thumbs img').forEach(i=>i.classList.toggle('on',i===t)); return; }
  if (t.id==='close'||t.id==='modal') $('#modal').classList.remove('on');
});

document.addEventListener('keydown', e => {
  if (e.key==='Escape') { $('#modal').classList.remove('on'); closeFilterPopover(); }
});

document.addEventListener('change', e => {
  if (e.target.dataset.qty) {
    const b = budget.find(x=>x.id===e.target.dataset.qty);
    if (b) { b.qty=Math.max(1,+e.target.value||1); save(); }
  }
});

$('#clear').onclick  = ()=>{ if(confirm('¿Vaciar presupuesto?')){ budget=[]; save(); } };
$('#print').onclick  = ()=>window.print();

// ── Inicio ────────────────────────────────────────────────────────────────────
renderBudget();
loadData();

