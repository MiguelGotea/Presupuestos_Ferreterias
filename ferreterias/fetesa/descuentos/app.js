// ferreterias/fetesa/descuentos/app.js
// Muestra solo productos donde listPrice > price, leídos del JSON estático.

const DATA_URL = '/ferreterias/fetesa/data/productos.json';
const PAGE_SIZE = 30;

const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const money = n => 'C$' + Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
const esc   = s => String(s??'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pct   = (p,l) => l > p ? Math.round((1-p/l)*100) : 0;

// ── Estado ────────────────────────────────────────────────────────────────────
let discAll      = [];  // todos con descuento
let filtered     = [];
let pageEnd      = PAGE_SIZE;
let userQuery    = '';
let selectedCats = null;
let sortKey      = null, sortDir = 1;
let activeFilterCol = null, activeFilterBtn = null;
const pool = new Map();

// ── Cargar datos ──────────────────────────────────────────────────────────────
async function loadData() {
  try {
    const r = await fetch(DATA_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();

    if (data.generatedAt) {
      const d = new Date(data.generatedAt);
      $('#last-update').textContent = `📅 ${d.toLocaleDateString('es-NI')} ${d.toLocaleTimeString('es-NI',{hour:'2-digit',minute:'2-digit'})}`;
    }

    const all = data.products || [];
    all.forEach(p => pool.set(p.id, p));
    discAll = all.filter(p => p.listPrice > p.price);

    // Stats
    $('#stat-total').textContent = discAll.length;
    if (discAll.length) {
      $('#stat-max').textContent = Math.max(...discAll.map(p=>pct(p.price,p.listPrice)))+'%';
      $('#stat-avg').textContent = Math.round(discAll.reduce((s,p)=>s+pct(p.price,p.listPrice),0)/discAll.length)+'%';
    }

    applyFilter();
  } catch(e) {
    $('#results').innerHTML = `<div class="empty">Error cargando datos: ${esc(e.message)}<br><small>Ejecuta el scraper primero.</small></div>`;
  }
}

// ── Filtrar ───────────────────────────────────────────────────────────────────
function applyFilter(reset = true) {
  if (reset) pageEnd = PAGE_SIZE;
  const terms = userQuery.toLocaleLowerCase('es').split(/\s+/).filter(Boolean).map(t=>t.normalize('NFD').replace(/[\u0300-\u036f]/g,''));

  filtered = discAll.filter(p => {
    if (selectedCats!==null && !selectedCats.has(p.cat||'Sin categoría')) return false;
    if (!terms.length) return true;
    const text = `${p.name||''} ${p.sku||''} ${p.cat||''}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es');
    return terms.every(term=>text.includes(term));
  });

  // Ordenar
  if (sortKey) {
    filtered.sort((a,b) => {
      let va = sortKey==='disc' ? pct(a.price,a.listPrice) : (a[sortKey]??'');
      let vb = sortKey==='disc' ? pct(b.price,b.listPrice) : (b[sortKey]??'');
      if (typeof va==='string') va=va.toLowerCase();
      if (typeof vb==='string') vb=vb.toLowerCase();
      return (va>vb?1:-1)*sortDir;
    });
  } else {
    const s = $('#sort-sel').value;
    if      (s==='disc')       filtered.sort((a,b)=>pct(b.price,b.listPrice)-pct(a.price,a.listPrice));
    else if (s==='saving')     filtered.sort((a,b)=>(b.listPrice-b.price)-(a.listPrice-a.price));
    else if (s==='price-asc')  filtered.sort((a,b)=>a.price-b.price);
    else if (s==='price-desc') filtered.sort((a,b)=>b.price-a.price);
  }

  renderAll();
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderAll() {
  const catActive = selectedCats!==null;
  const filterExtra = catActive ? ` · categorías (${selectedCats.size})` : '';
  $('#filter-count').textContent = `Mostrando ${Math.min(pageEnd,filtered.length)} de ${filtered.length}${filterExtra}`;

  const visible = filtered.slice(0, pageEnd);
  if (!visible.length) {
    $('#results').innerHTML = userQuery||catActive
      ? '<div class="empty">Sin resultados. Prueba cambiando búsqueda o filtros.</div>'
      : '<div class="empty">Sin productos con descuento en el catálogo actual.</div>';
    $('#more').hidden = true;
    return;
  }

  const arrow = k => sortKey===k ? (sortDir>0?' ▲':' ▼') : '';
  $('#results').innerHTML = `
    <table><thead><tr>
      <th></th>
      <th><span class="th-sort" data-k="name">Producto${arrow('name')}</span></th>
      <th>
        <div class="th-content">
          <span class="th-sort" data-k="cat">Categoría${arrow('cat')}</span>
          <button type="button" class="th-filter-btn ${catActive?'active':''}" data-filter-col="cat" title="Filtrar por categoría">
            <span>Filtrar</span> <span>▾</span>
            ${catActive?`<span class="filter-badge">${selectedCats.size}</span>`:''}
          </button>
        </div>
      </th>
      <th style="text-align:right"><span class="th-sort" data-k="price">Precio${arrow('price')}</span></th>
      <th style="text-align:right"><span class="th-sort" data-k="listPrice">Precio Lista${arrow('listPrice')}</span></th>
      <th style="text-align:center"><span class="th-sort" data-k="disc">Descuento${arrow('disc')}</span></th>
      <th></th>
    </tr></thead><tbody>
    ${visible.map(discRow).join('')}
    </tbody></table>`;

  $('#more').hidden = pageEnd >= filtered.length;
}

function discRow(p) {
  const d = pct(p.price, p.listPrice), saving = p.listPrice-p.price;
  return `<tr>
    <td class="img-cell"><img loading="lazy" src="${esc(p.image)}" data-open="${esc(p.id)}" alt="" onerror="this.src='';this.style.display='none'"></td>
    <td>
      <div class="name">${esc(p.name)}</div>
      <div class="sub">${p.sku?`SKU: ${esc(p.sku)}`:'&nbsp;'}</div>
    </td>
    <td style="font-size:12px">${p.cat?`<span class="cat-badge">${esc(p.cat)}</span>`:''}</td>
    <td class="price-col">${money(p.price)}</td>
    <td class="list-price" style="text-align:right">${money(p.listPrice)}</td>
    <td class="disc-cell">
      <div class="disc-pct">-${d}%</div>
      <div class="disc-save">Ahorras ${money(saving)}</div>
    </td>
    <td style="white-space:nowrap">
      <button class="btn btn-sec btn-table-ver" data-open="${esc(p.id)}">Ver</button>
    </td>
  </tr>`;
}

// ── Popover filtro categorías ─────────────────────────────────────────────────
function getCatItems() {
  const counts = new Map();
  discAll.forEach(p => { const v=p.cat||'Sin categoría'; counts.set(v,(counts.get(v)||0)+1); });
  return [...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0],'es'));
}

function openFilterPopover(col, btn) {
  const pop = $('#col-filter-popover');
  if (activeFilterCol===col && pop.classList.contains('on')) { closeFilterPopover(); return; }
  activeFilterCol=col; activeFilterBtn=btn;
  $('#popover-title').textContent='Filtrar por Categoría';
  $('#popover-search').value='';
  renderFilterItems();
  pop.classList.add('on');
  positionPopover();
}

function positionPopover() {
  const pop=$('#col-filter-popover');
  if (!activeFilterBtn||!pop.classList.contains('on')) return;
  const rect=activeFilterBtn.getBoundingClientRect();
  pop.style.top=(rect.bottom+5)+'px';
  let left=rect.left;
  if (left+270>window.innerWidth) left=window.innerWidth-280;
  pop.style.left=Math.max(10,left)+'px';
}

function closeFilterPopover() {
  $('#col-filter-popover').classList.remove('on');
  activeFilterCol=null; activeFilterBtn=null;
}

function renderFilterItems() {
  const items=getCatItems();
  const qF=($('#popover-search').value||'').toLowerCase().trim();
  const f=items.filter(([n])=>!qF||n.toLowerCase().includes(qF));
  if (!f.length) { $('#popover-list').innerHTML='<div style="padding:10px;text-align:center;color:var(--mu);font-size:11px">Sin opciones</div>'; return; }
  $('#popover-list').innerHTML=f.map(([name,count])=>{
    const isChecked=selectedCats===null?true:selectedCats.has(name);
    return `<label class="filter-item">
      <input type="checkbox" value="${esc(name)}" ${isChecked?'checked':''} data-filter-item="cat">
      <span class="filter-item-name" title="${esc(name)}">${esc(name)}</span>
      <span class="filter-item-count">(${count})</span>
    </label>`;
  }).join('');
}

$('#popover-close').onclick = closeFilterPopover;
$('#popover-all').onclick   = ()=>{ selectedCats=null; renderFilterItems(); applyFilter(); };
$('#popover-none').onclick  = ()=>{ selectedCats=new Set(); renderFilterItems(); applyFilter(); };
$('#popover-reset').onclick = ()=>{ selectedCats=null; renderFilterItems(); applyFilter(); };
$('#popover-search').addEventListener('input', renderFilterItems);
$('#popover-list').addEventListener('change', e=>{
  if (!e.target.dataset.filterItem) return;
  const all=getCatItems().map(i=>i[0]);
  if (selectedCats===null) selectedCats=new Set(all);
  if (e.target.checked) selectedCats.add(e.target.value);
  else selectedCats.delete(e.target.value);
  if (selectedCats.size===all.length) selectedCats=null;
  applyFilter();
});

window.addEventListener('resize', positionPopover);
window.addEventListener('scroll', positionPopover, true);

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(id) {
  const p=pool.get(id); if (!p) return;
  const d=pct(p.price,p.listPrice), saving=p.listPrice-p.price;
  $('#mbox').innerHTML=`
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
          <div class="modal-price">${money(p.price)}</div>
          <span style="background:linear-gradient(135deg,#e67e22,#d35400);color:#fff;font-size:14px;font-weight:800;padding:4px 10px;border-radius:8px">-${d}%</span>
        </div>
        <div>
          <div class="modal-list-price">Precio lista: ${money(p.listPrice)}</div>
          <div class="modal-disc-pct">Ahorras ${money(saving)}</div>
        </div>
        <div>
          <span class="badge-avail ${p.available?'avail-yes':'avail-no'}">${p.available?'✔ Disponible':'✖ Agotado'}</span>
          ${p.cat?`<span class="cat-badge" style="margin-left:6px">${esc(p.cat)}</span>`:''}
        </div>
        <div class="modal-top-actions">
          ${p.link?`<a href="${esc(p.link)}" target="_blank" rel="noopener" class="btn btn-primary" style="display:inline-flex;align-items:center;gap:6px">Abrir en Fetesa ↗</a>`:''}
        </div>
      </div>
    </div>
    <div class="modal-bottom">
      ${p.sku?`<div class="section-label">Identificación</div>
      <table class="specs-table"><tr><td>SKU</td><td><code>${esc(p.sku)}</code></td></tr></table>`:''}
    </div>`;
  $('#modal').classList.add('on');
}

// ── Eventos ───────────────────────────────────────────────────────────────────
let searchTimer=null;
$('#q').addEventListener('input', e=>{
  clearTimeout(searchTimer);
  searchTimer=setTimeout(()=>{ userQuery=e.target.value.trim(); applyFilter(); }, 200);
});
$('#sort-sel').addEventListener('change', ()=>{ sortKey=null; applyFilter(); });
$('#more').addEventListener('click', ()=>{ pageEnd+=PAGE_SIZE; renderAll(); });

document.addEventListener('click', e=>{
  const t=e.target;
  if (t.id==='popover-close'||t.closest('#popover-close')) { closeFilterPopover(); return; }
  const filterBtn=t.closest('[data-filter-col]');
  if (filterBtn) { openFilterPopover(filterBtn.dataset.filterCol, filterBtn); return; }
  if (!t.closest('#col-filter-popover')&&!t.closest('[data-filter-col]')) closeFilterPopover();
  if (t.dataset.open) { openModal(t.dataset.open); return; }
  if (t.dataset.k) { sortDir=sortKey===t.dataset.k?-sortDir:1; sortKey=t.dataset.k; applyFilter(); return; }
  if (t.dataset.img) { $('#big').src=t.dataset.img; $$('.thumbs img').forEach(i=>i.classList.toggle('on',i===t)); return; }
  if (t.id==='close'||t.id==='modal') $('#modal').classList.remove('on');
});

document.addEventListener('keydown', e=>{
  if (e.key==='Escape') { $('#modal').classList.remove('on'); closeFilterPopover(); }
});

// ── Inicio ────────────────────────────────────────────────────────────────────
loadData();

