// app.js — El Halcón Presupuestos
// API: WooCommerce Store v1 (pública, sin autenticación)
// Proxy en server.js: /api/elhalcon/* → https://elhalcon.com.ni/*

const API  = '/api/elhalcon/wp-json/wc/store/v1/products';
const PAGE = 24;
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
// Precios en WooCommerce Store v1 vienen en centavos (entero) → dividir entre 100
const money = n => 'C$' + (Number(n) / 100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc   = s => String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pct   = (p,r) => r>p ? Math.round((1-p/r)*100) : 0;

let products=[], totalRecords=0, page=1, query='', sortKey=null, sortDir=1, ctrl=null, timer=null;
let showDiscOnly = false;
let selectedCats = null; // null = sin filtro (todas); Set = categorías seleccionadas
let activeFilterCol = null;
let activeFilterBtn = null;

let budget = JSON.parse(localStorage.getItem('halcon-budget')||'[]');
const pool = new Map(); // lookup global para modal

/* Normalizar producto de WooCommerce Store v1 */
function norm(p){
  const prices = p.prices || {};
  const price   = Number(prices.price ?? 0);       // centavos
  const regular = Number(prices.regular_price ?? 0); // centavos
  const onSale  = p.on_sale || price < regular;

  const cats = (p.categories||[]).map(c=>c.name).filter(Boolean);
  const img   = p.images?.[0];

  const raw = {
    id:      String(p.id),
    name:    p.name || '',
    sku:     p.sku  || '',
    price,
    regular,
    onSale,
    available: p.is_in_stock,
    stockText: p.stock_availability?.text || '',
    cat:   cats.join(' > '),
    cats,
    link:  p.permalink || '',
    image: img?.src       || '',
    thumb: img?.thumbnail || img?.src || '',
    desc:  p.short_description || p.description || '',
    dimensions: p.formatted_dimensions || '',
    weight:     p.formatted_weight || '',
  };
  pool.set(raw.id, raw);
  return raw;
}

/* Extraer total del header X-WP-Total */
let lastTotal = 0;

async function search(reset=true){
  if(reset){
    page=1; products=[];
    selectedCats=null;
    closeFilterPopover();
  }
  if(query.length<2){render();return;}
  ctrl?.abort(); ctrl=new AbortController();
  $('#count').textContent='Buscando…';
  try{
    // WooCommerce puede buscar la frase como secuencia exacta; buscar cada
    // palabra y cruzar localmente los resultados encuentra términos separados.
    const terms=[...new Set(query.toLocaleLowerCase('es').split(/\s+/).filter(Boolean))];
    const queries=terms.length>1?terms:[query];
    const responses=await Promise.all(queries.map(async term=>{
      const url=`${API}?search=${encodeURIComponent(term)}&per_page=${PAGE}&page=${page}`;
      const r=await fetch(url,{signal:ctrl.signal});
      if(!r.ok) throw new Error('HTTP '+r.status);
      return {items:await r.json(),total:Number(r.headers.get('X-WP-Total')||0)};
    }));
    lastTotal=Math.max(...responses.map(x=>x.total),0);
    const found=new Map();
    responses.forEach(x=>x.items.forEach(p=>found.set(String(p.id),p)));
    const normalized=[...found.values()].map(norm);
    const normalizedTerms=terms.map(t=>t.normalize('NFD').replace(/[\u0300-\u036f]/g,''));
    const matches=terms.length>1?normalized.filter(p=>{
      const text=`${p.name} ${p.sku} ${p.cat}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es');
      return normalizedTerms.every(term=>text.includes(term));
    }):normalized;
    products=products.concat(matches);
    totalRecords = terms.length>1?lastTotal:(responses[0].total||products.length);
    render();
  }catch(e){
    if(e.name==='AbortError') return;
    $('#results').innerHTML=`<div class="empty">Error: ${esc(e.message)}. Verifica que server.js está corriendo.</div>`;
    $('#count').textContent='';
  }
}

function render(){
  let list=products.slice();
  if(selectedCats!==null) list=list.filter(p=>selectedCats.has(p.cat||'Sin categoría'));
  if(showDiscOnly) list=list.filter(p=>p.onSale);
  if(sortKey){
    list.sort((a,b)=>{
      let va = a[sortKey]??'';
      let vb = b[sortKey]??'';
      if(typeof va==='string') va=va.toLowerCase();
      if(typeof vb==='string') vb=vb.toLowerCase();
      return (va>vb?1:-1)*sortDir;
    });
  }

  const filtersActive=[];
  if(showDiscOnly) filtersActive.push('con descuento');
  if(selectedCats!==null) filtersActive.push(`categorías (${selectedCats.size})`);

  const label = filtersActive.length ? ` (${filtersActive.join(', ')})` : '';
  $('#count').textContent=query.length<2?'':
    `${list.length}${label} de ${totalRecords}`;

  const empty=query.length<2?'Empieza a escribir para buscar productos.'
    :(filtersActive.length?'Ningún resultado coincide con los filtros aplicados.':'Sin resultados.');
  if(!list.length){
    $('#results').innerHTML=`<div class="empty">${empty}</div>`;
    $('#more').hidden=true; return;
  }
  const arrow=k=>sortKey===k?(sortDir>0?' ▲':' ▼'):'';
  const catActive = selectedCats !== null;

  $('#results').innerHTML=
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
      <th><span class="th-sort" data-k="sku">SKU${arrow('sku')}</span></th>
      <th style="text-align:right"><span class="th-sort" data-k="price">Precio${arrow('price')}</span></th>
      <th></th>
    </tr></thead><tbody>`+
    list.map(productRow).join('')+'</tbody></table>';
  $('#more').hidden=products.length>=totalRecords;
}

function productRow(p){
  const d=pct(p.price,p.regular);
  return `<tr>
    <td class="img-cell"><img loading="lazy" src="${esc(p.thumb)}" data-open="${p.id}" alt=""></td>
    <td>
      <div class="name">${esc(p.name)}</div>
      <div class="sub">${esc(p.cat)}</div>
    </td>
    <td style="font-size:11px;color:var(--mu)">${esc(p.cat||'—')}</td>
    <td><span class="unit-badge">${esc(p.sku||'—')}</span></td>
    <td class="price-col">
      ${money(p.price)}${d>0?`<span class="badge-disc">-${d}%</span>`:''}
      ${p.onSale?`<div class="list-price">${money(p.regular)}</div>`:''}
      <div>${!p.available?'<span class="badge-avail avail-no">Agotado</span>':'<span class="badge-avail avail-yes">Disponible</span>'}</div>
    </td>
    <td style="white-space:nowrap">
      <button class="btn btn-sec btn-table-ver" data-open="${p.id}">Ver</button>
      <button class="btn btn-primary btn-table-add" data-add="${p.id}" title="Añadir al presupuesto">+</button>
    </td>
  </tr>`;
}

/* POPOVER FILTROS DE ENCABEZADO */
function getColItems(col){
  const counts=new Map();
  products.forEach(p=>{
    const val = p.cat||'Sin categoría';
    counts.set(val, (counts.get(val)||0) + 1);
  });
  return [...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0],'es'));
}

function openFilterPopover(col, btn){
  const pop=$('#col-filter-popover');
  if(activeFilterCol===col && pop.classList.contains('on')){
    closeFilterPopover();
    return;
  }
  activeFilterCol=col;
  activeFilterBtn=btn;
  $('#popover-title').textContent = 'Filtrar por Categoría';
  $('#popover-search').value = '';
  renderFilterItems();
  pop.classList.add('on');
  positionPopover();
}

function positionPopover(){
  const pop=$('#col-filter-popover');
  if(!activeFilterBtn || !pop.classList.contains('on')) return;
  const rect=activeFilterBtn.getBoundingClientRect();
  pop.style.top=(rect.bottom + 5)+'px';
  let left=rect.left;
  if(left+270 > window.innerWidth){
    left = window.innerWidth - 280;
  }
  pop.style.left=Math.max(10, left)+'px';
}

function closeFilterPopover(){
  const pop=$('#col-filter-popover');
  pop.classList.remove('on');
  activeFilterCol=null;
  activeFilterBtn=null;
}

function renderFilterItems(){
  const col=activeFilterCol;
  if(!col) return;
  const items=getColItems(col);
  const filterSet = selectedCats;
  const qFilter = $('#popover-search').value.toLowerCase().trim();

  const filtered = items.filter(([name]) => !qFilter || name.toLowerCase().includes(qFilter));

  if(!filtered.length){
    $('#popover-list').innerHTML='<div style="padding:10px;text-align:center;color:var(--mu);font-size:11px">Sin opciones</div>';
    return;
  }

  $('#popover-list').innerHTML=filtered.map(([name, count])=>{
    const isChecked = filterSet===null ? true : filterSet.has(name);
    return `<label class="filter-item">
      <input type="checkbox" value="${esc(name)}" ${isChecked?'checked':''} data-filter-item="cat">
      <span class="filter-item-name" title="${esc(name)}">${esc(name)}</span>
      <span class="filter-item-count">(${count})</span>
    </label>`;
  }).join('');
}

$('#popover-close').onclick = closeFilterPopover;
$('#popover-all').onclick = () => { selectedCats=null; renderFilterItems(); render(); };
$('#popover-none').onclick = () => { selectedCats=new Set(); renderFilterItems(); render(); };
$('#popover-reset').onclick = () => { selectedCats=null; renderFilterItems(); render(); };
$('#popover-search').addEventListener('input', renderFilterItems);

$('#popover-list').addEventListener('change', e=>{
  if(!e.target.dataset.filterItem) return;
  const allItems=getColItems('cat').map(i=>i[0]);
  let filterSet = selectedCats;

  if(filterSet===null){
    filterSet = new Set(allItems);
  }

  const val=e.target.value;
  if(e.target.checked){ filterSet.add(val); }
  else{ filterSet.delete(val); }

  if(filterSet.size===allItems.length){ filterSet=null; }
  selectedCats=filterSet;
  render();
});

window.addEventListener('resize', positionPopover);
window.addEventListener('scroll', positionPopover, true);

/* MODAL */
function openModal(id){
  const p=pool.get(id)||budget.find(x=>x.id===id); if(!p) return;
  const d=pct(p.price,p.regular), saving=p.onSale?p.regular-p.price:0;

  $('#mbox').innerHTML=`
    <div class="modal-top">
      <div class="modal-gallery">
        <img class="big-img" id="big" src="${esc(p.image||p.thumb)}" alt="">
        <div class="thumbs">${p.image?`<img src="${esc(p.thumb)}" data-img="${esc(p.image)}" class="on" alt="">`:''}</div>
      </div>
      <div class="modal-info">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="modal-brand">${esc(p.cat)}</div>
          <button class="btn btn-sec btn-sm" id="close">✕ Cerrar</button>
        </div>
        <div class="modal-name">${esc(p.name)}</div>
        <div class="modal-price-block">
          <div class="modal-price">${money(p.price)}</div>
          ${d>0?`<span class="badge-disc">-${d}%</span>`:''}
        </div>
        ${p.onSale?`<div>
          <div class="modal-list-price">Lista: ${money(p.regular)}</div>
          <div class="modal-disc-pct">Ahorras ${money(saving)}</div>
        </div>`:''}
        <div>
          <span class="badge-avail ${p.available?'avail-yes':'avail-no'}">${p.available?'✔ Disponible':'✖ Agotado'}</span>
          ${p.stockText?`<span class="sub" style="margin-left:6px">${esc(p.stockText)}</span>`:''}
        </div>
        <div class="modal-top-actions">
          <button class="btn btn-primary" data-add="${p.id}">+ Añadir al presupuesto</button>
          <a href="${esc(p.link)}" target="_blank" rel="noopener" class="btn btn-sec">Abrir en El Halcón ↗</a>
        </div>
      </div>
    </div>
    <div class="modal-bottom">
      <div class="section-label">Identificación</div>
      <table class="specs-table">
        ${p.sku?`<tr><td>SKU</td><td><code>${esc(p.sku)}</code></td></tr>`:''}
        ${p.cat?`<tr><td>Categoría</td><td>${esc(p.cat)}</td></tr>`:''}
        ${p.dimensions&&p.dimensions!=='N/D'?`<tr><td>Dimensiones</td><td>${esc(p.dimensions)}</td></tr>`:''}
        ${p.weight&&p.weight!=='N/D'?`<tr><td>Peso</td><td>${esc(p.weight)}</td></tr>`:''}
      </table>
      ${p.desc?`<div class="section-label">Descripción</div><div class="modal-desc">${p.desc}</div>`:''}
    </div>`;
  $('#modal').classList.add('on');
}

/* PRESUPUESTO */
function save(){localStorage.setItem('halcon-budget',JSON.stringify(budget));renderBudget();}
function add(id){
  const ex=budget.find(b=>b.id===id);
  if(ex){ex.qty++;}else{const p=pool.get(id);if(p)budget.push({...p,qty:1});}
  save();
  const panel=$('#budget-panel');
  panel.style.boxShadow='0 0 0 3px #0055d4';
  setTimeout(()=>panel.style.boxShadow='',700);
}
function renderBudget(){
  const grand=budget.reduce((s,b)=>s+(b.price/100)*b.qty,0);
  const discSave=budget.reduce((s,b)=>b.onSale?s+((b.regular-b.price)/100)*b.qty:s,0);
  $('#nitems').textContent=budget.length+(budget.length===1?' ítem':' ítems');
  $('#total').textContent='C$'+grand.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  if(!budget.length){$('#budget').innerHTML='<div class="empty">Añade productos con "+".</div>';return;}
  $('#budget').innerHTML=`
    <table>
      <thead><tr>
        <th></th><th>Producto</th>
        <th style="text-align:center">Precio<br>c/u</th>
        <th style="text-align:center">Cant.</th>
        <th style="text-align:right">Subtotal</th>
        <th></th>
      </tr></thead>
      <tbody>${budget.map(b=>{
        const d=pct(b.price,b.regular);
        const cu=(b.price/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
        const sub=((b.price/100)*b.qty).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
        return `<tr>
          <td class="img-cell"><img src="${esc(b.thumb)}" data-open="${b.id}" alt=""></td>
          <td>
            <div class="name" style="font-size:11px">${esc(b.name)}</div>
            <div class="sub">${esc(b.cat||'')}${d>0?` <span class="badge-disc">-${d}%</span>`:''}</div>
          </td>
          <td class="budget-unit-cell">
            <div class="bud-cu">C$${cu}</div>
          </td>
          <td style="text-align:center">
            <input class="qty-input" type="number" min="1" value="${b.qty}" data-qty="${b.id}">
          </td>
          <td class="budget-subtotal">C$${sub}</td>
          <td><button class="x-btn" data-del="${b.id}" title="Quitar">✕</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    ${discSave>0?`<div style="padding:7px 14px;font-size:11px;color:var(--od);font-weight:600;background:var(--ob);border-top:1px solid #f5cba7">🏷️ Ahorras C$${discSave.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} en descuentos</div>`:''}`;
}

/* TOGGLE SOLO DESCUENTO */
$('#toggle-disc').addEventListener('click',()=>{
  showDiscOnly=!showDiscOnly;
  $('#toggle-disc').classList.toggle('on',showDiscOnly);
  render();
});

/* EVENTOS */
$('#q').addEventListener('input',e=>{clearTimeout(timer);timer=setTimeout(()=>{query=e.target.value.trim();search(true);},300);});
$('#more').addEventListener('click',()=>{page++;search(false);});

document.addEventListener('click',e=>{
  const t=e.target;

  if(t.id==='popover-close' || t.closest('#popover-close')){
    closeFilterPopover();
    return;
  }

  const filterBtn = t.closest('[data-filter-col]');
  if(filterBtn){
    openFilterPopover(filterBtn.dataset.filterCol, filterBtn);
    return;
  }
  if(!t.closest('#col-filter-popover') && !t.closest('[data-filter-col]')){
    closeFilterPopover();
  }

  if(t.dataset.open){openModal(t.dataset.open);return;}
  if(t.dataset.add){add(t.dataset.add);return;}
  if(t.dataset.del){budget=budget.filter(b=>b.id!==t.dataset.del);save();return;}
  if(t.dataset.k){sortDir=sortKey===t.dataset.k?-sortDir:1;sortKey=t.dataset.k;render();return;}
  if(t.dataset.img){$('#big').src=t.dataset.img;$$('.thumbs img').forEach(i=>i.classList.toggle('on',i===t));return;}
  if(t.id==='close'||t.id==='modal')$('#modal').classList.remove('on');
});

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    $('#modal').classList.remove('on');
    closeFilterPopover();
  }
});

document.addEventListener('change',e=>{
  if(e.target.dataset.qty){
    const b=budget.find(x=>x.id===e.target.dataset.qty);
    if(b){b.qty=Math.max(1,+e.target.value||1);save();}
  }
});

/* BOTONES PRESUPUESTO */
$('#clear').onclick=()=>{if(confirm('¿Vaciar presupuesto?')){budget=[];save();}};
$('#print').onclick=()=>window.print();

renderBudget();

