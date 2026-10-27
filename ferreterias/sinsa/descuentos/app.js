// ── CONFIGURACIÓN ────────────────────────────────────────
const API   = '/api/sinsa/io/_v/api/intelligent-search/product_search/';
const SCAN_TERMS = [
  'cemento','pintura','tubo','cable','madera','porcelanato','piso','grifo',
  'herramienta','pvc','eléctrico','tornillo','llave','válvula','vidrio',
  'plywood','malla','hierro','varilla','alambre','codo','tee','reductor',
  'pegamento','impermeabilizante','sellador','masilla','barniz','thinner',
  'interruptor','tomacorriente','breaker','panel','foco','lámpara',
  'cerámica','adhesivo','fragua','porcelana','grieta','anticorrosivo',
  'ventana','puerta','bisagra','chapa','candado','clavos','cinta',
  'manguera','bomba','tanque','inodoro','lavamanos','ducha','mezcladora',
  'bloque','ladrillo','arena','cal','aditivo','cubierta','techo','zinc',
  'polín','ángulo','canal','gotero','canoa'
];
const PAGE  = 50;
const DELAY = 150;

const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const money = n => 'C$' + Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc   = s => String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const thumb = u => u ? u.replace(/(\/ids\/\d+)\/[^?]*/,'$1-120-120/img.jpg') : '';
const pct   = (p,l) => l>p ? Math.round((1-p/l)*100) : 0;
const unitLabel = u => {
  if(!u) return 'Unidad';
  const m={m:'Metro',m2:'m²',m3:'m³',cm:'cm',kg:'kg',g:'gr',l:'Litro',ml:'ml',un:'Unidad',ud:'Unidad',pz:'Pieza',ft:'Pie','in':'Pulgada',gl:'Galón'};
  return m[u.toLowerCase()]||u;
};

// ── ESTADO ───────────────────────────────────────────────
const seen  = new Set();
const pool  = new Map();
let discAll = [];
let scanIdx = 0;
let scanActive = false;
let userQuery = '';
let selectedBrands = null; // null = sin filtro; Set = marcas seleccionadas
let selectedUnits  = null; // null = sin filtro; Set = unidades seleccionadas
let activeFilterCol = null;
let activeFilterBtn = null;
let sortKey = null, sortDir = 1;

// ── NORMALIZAR ───────────────────────────────────────────
function norm(p){
  const item=p.items?.[0]||{};
  const off=item.sellers?.[0]?.commertialOffer||{};
  const spec={};
  (p.properties||[]).forEach(x=>{
    if(x.name!=='sellerId'&&x.name!=='Unidad de medida') spec[x.name]=(x.values||[]).join(', ');
  });
  const cats=(p.categories||[]).map(c=>c.split('/').filter(Boolean).pop()).filter(Boolean);
  const collections=Object.values(p.productClusters||{}).filter(Boolean);
  const raw={
    id:p.productId, name:p.productName, brand:p.brand||'',
    ref:p.productReference||'',
    ean:item.ean||item.referenceId?.find(r=>r.Key==='RefId')?.Value||'',
    price:off.Price??0, list:off.ListPrice??0,
    available:(off.AvailableQuantity??0)>0,
    cat:cats.join(' > '), cats, collections,
    link:'https://www.sinsa.com.ni'+(p.link||''),
    images:(item.images||[]).map(i=>i.imageUrl),
    desc:p.description||'', spec,
    unit:item.measurementUnit||'ud',
  };
  pool.set(raw.id, raw);
  return raw;
}

// ── SCAN ─────────────────────────────────────────────────
async function scanNext(){
  if(scanIdx >= SCAN_TERMS.length){ finishScan(); return; }
  const term = SCAN_TERMS[scanIdx++];
  updateProgress();
  try{
    const url=`${API}?query=${encodeURIComponent(term)}&count=${PAGE}&page=1`;
    const r=await fetch(url);
    if(!r.ok) throw new Error('HTTP '+r.status);
    const j=await r.json();
    const prods=(j.products||[]).map(norm);
    let added=0;
    prods.forEach(p=>{
      if(!seen.has(p.id)&&p.list>p.price){seen.add(p.id);discAll.push(p);added++;}
      else if(!seen.has(p.id)){seen.add(p.id);}
    });
    if(added>0) renderAll();
  }catch(e){}
  await sleep(DELAY);
  if(scanActive) scanNext();
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function updateProgress(){
  const pct=(scanIdx/SCAN_TERMS.length)*100;
  $('#load-fill').style.width=pct+'%';
  $('#status-msg').textContent=`Explorando catálogo… ${scanIdx}/${SCAN_TERMS.length} categorías · ${discAll.length} descuentos encontrados`;
}

function finishScan(){
  scanActive=false;
  $('#load-fill').style.width='100%';
  $('#status-msg').textContent=`✔ Exploración completa · ${discAll.length} productos con descuento encontrados`;
  renderAll();
}

function startScan(){
  discAll=[]; seen.clear(); scanIdx=0; scanActive=true;
  selectedBrands=null; selectedUnits=null;
  closeFilterPopover();
  $('#load-fill').style.width='0%';
  updateProgress();
  scanNext();
}

// ── FILTROS Y RENDER ─────────────────────────────────────
function getFiltered(){
  const terms=userQuery.toLocaleLowerCase('es').split(/\s+/).filter(Boolean).map(t=>t.normalize('NFD').replace(/[\u0300-\u036f]/g,''));
  let list=discAll.filter(p=>
    !terms.length||terms.every(t=>`${p.name} ${p.brand}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es').includes(t))
  );

  if(selectedBrands!==null) list=list.filter(p=>selectedBrands.has(p.brand||'Sin marca'));
  if(selectedUnits!==null)  list=list.filter(p=>selectedUnits.has(unitLabel(p.unit)));

  if(sortKey){
    list.sort((a,b)=>{
      let va = a[sortKey]??'';
      let vb = b[sortKey]??'';
      if(sortKey==='unit'){ va=unitLabel(a.unit); vb=unitLabel(b.unit); }
      else if(sortKey==='disc'){ va=pct(a.price,a.list); vb=pct(b.price,b.list); }
      if(typeof va==='string') va=va.toLowerCase();
      if(typeof vb==='string') vb=vb.toLowerCase();
      return (va>vb?1:-1)*sortDir;
    });
  }else{
    const sort=$('#sort-sel').value;
    if(sort==='disc')       list.sort((a,b)=>pct(b.price,b.list)-pct(a.price,a.list));
    else if(sort==='saving')     list.sort((a,b)=>(b.list-b.price)-(a.list-a.price));
    else if(sort==='price-asc')  list.sort((a,b)=>a.price-b.price);
    else if(sort==='price-desc') list.sort((a,b)=>b.price-a.price);
  }

  return list;
}

function renderAll(){
  const list=getFiltered();
  $('#stat-total').textContent=discAll.length;
  if(discAll.length){
    const maxD=Math.max(...discAll.map(p=>pct(p.price,p.list)));
    const avgD=Math.round(discAll.reduce((s,p)=>s+pct(p.price,p.list),0)/discAll.length);
    $('#stat-max').textContent=maxD+'%';
    $('#stat-avg').textContent=avgD+'%';
  }

  const filtersActive=[];
  if(selectedBrands!==null) filtersActive.push(`marcas (${selectedBrands.size})`);
  if(selectedUnits!==null)  filtersActive.push(`unidades (${selectedUnits.size})`);
  const filterExtra = filtersActive.length ? ` · ${filtersActive.join(', ')}` : '';

  $('#filter-count').textContent=`Mostrando ${list.length} de ${discAll.length}${filterExtra}`;
  if(!list.length){
    $('#results').innerHTML=userQuery||filtersActive.length
      ?`<div class="empty">Sin resultados con los filtros actuales. Prueba cambiando la búsqueda o los filtros.</div>`
      :'<div class="empty">Buscando productos con descuento…</div>';
    return;
  }

  const arrow=k=>sortKey===k?(sortDir>0?' ▲':' ▼'):'';
  const brandActive = selectedBrands !== null;
  const unitActive  = selectedUnits !== null;

  $('#results').innerHTML=`
    <table><thead><tr>
      <th></th>
      <th><span class="th-sort" data-k="name">Producto${arrow('name')}</span></th>
      <th>
        <div class="th-content">
          <span class="th-sort" data-k="brand">Marca${arrow('brand')}</span>
          <button type="button" class="th-filter-btn ${brandActive?'active':''}" data-filter-col="brand" title="Filtrar por marca">
            <span>Filtrar</span> <span>▾</span>
            ${brandActive ? `<span class="filter-badge">${selectedBrands.size}</span>` : ''}
          </button>
        </div>
      </th>
      <th>
        <div class="th-content">
          <span class="th-sort" data-k="unit">Unidad${arrow('unit')}</span>
          <button type="button" class="th-filter-btn ${unitActive?'active':''}" data-filter-col="unit" title="Filtrar por unidad">
            <span>Filtrar</span> <span>▾</span>
            ${unitActive ? `<span class="filter-badge">${selectedUnits.size}</span>` : ''}
          </button>
        </div>
      </th>
      <th style="text-align:right"><span class="th-sort" data-k="price">Precio${arrow('price')}</span></th>
      <th style="text-align:right"><span class="th-sort" data-k="list">Precio lista${arrow('list')}</span></th>
      <th style="text-align:center"><span class="th-sort" data-k="disc">Descuento${arrow('disc')}</span></th>
      <th></th>
    </tr></thead><tbody>
    ${list.map(discRow).join('')}
    </tbody></table>`;
}

function discRow(p){
  const d=pct(p.price,p.list), saving=p.list-p.price, ul=unitLabel(p.unit);
  return `<tr>
    <td class="img-cell"><img loading="lazy" src="${esc(thumb(p.images[0]))}" data-open="${p.id}" alt=""></td>
    <td>
      <div class="name">${esc(p.name)}</div>
      <div class="sub">Ref ${esc(p.ref)} · ${esc(p.cat)}</div>
      ${p.collections.length?`<div class="sub">📂 ${esc(p.collections[0])}</div>`:''}
    </td>
    <td style="font-size:12px">${esc(p.brand||'Sin marca')}</td>
    <td><span class="unit-badge">${esc(ul)}</span></td>
    <td class="price-col">${money(p.price)}</td>
    <td class="list-price" style="text-align:right">${money(p.list)}</td>
    <td class="disc-cell">
      <div class="disc-pct">-${d}%</div>
      <div class="disc-save">Ahorras ${money(saving)}</div>
    </td>
    <td style="white-space:nowrap">
      <button class="btn btn-sec btn-table-ver" data-open="${p.id}">Ver</button>
    </td>
  </tr>`;
}

/* POPOVER FILTROS DE ENCABEZADO */
function getColItems(col){
  const counts=new Map();
  discAll.forEach(p=>{
    const val = col==='brand' ? (p.brand||'Sin marca') : unitLabel(p.unit);
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
  $('#popover-title').textContent = col==='brand' ? 'Filtrar por Marca' : 'Filtrar por Unidad';
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
  const filterSet = col==='brand' ? selectedBrands : selectedUnits;
  const qFilter = $('#popover-search').value.toLowerCase().trim();

  const filtered = items.filter(([name]) => !qFilter || name.toLowerCase().includes(qFilter));

  if(!filtered.length){
    $('#popover-list').innerHTML='<div style="padding:10px;text-align:center;color:var(--mu);font-size:11px">Sin opciones</div>';
    return;
  }

  $('#popover-list').innerHTML=filtered.map(([name, count])=>{
    const isChecked = filterSet===null ? true : filterSet.has(name);
    return `<label class="filter-item">
      <input type="checkbox" value="${esc(name)}" ${isChecked?'checked':''} data-filter-item="${col}">
      <span class="filter-item-name" title="${esc(name)}">${esc(name)}</span>
      <span class="filter-item-count">(${count})</span>
    </label>`;
  }).join('');
}

$('#popover-close').onclick = closeFilterPopover;
$('#popover-all').onclick = () => {
  if(activeFilterCol==='brand') selectedBrands=null;
  else if(activeFilterCol==='unit') selectedUnits=null;
  renderFilterItems();
  renderAll();
};
$('#popover-none').onclick = () => {
  if(activeFilterCol==='brand') selectedBrands=new Set();
  else if(activeFilterCol==='unit') selectedUnits=new Set();
  renderFilterItems();
  renderAll();
};
$('#popover-reset').onclick = () => {
  if(activeFilterCol==='brand') selectedBrands=null;
  else if(activeFilterCol==='unit') selectedUnits=null;
  renderFilterItems();
  renderAll();
};
$('#popover-search').addEventListener('input', renderFilterItems);

$('#popover-list').addEventListener('change', e=>{
  if(!e.target.dataset.filterItem) return;
  const col=e.target.dataset.filterItem;
  const allItems=getColItems(col).map(i=>i[0]);
  let filterSet = col==='brand' ? selectedBrands : selectedUnits;

  if(filterSet===null){
    filterSet = new Set(allItems);
  }

  const val=e.target.value;
  if(e.target.checked){
    filterSet.add(val);
  }else{
    filterSet.delete(val);
  }

  if(filterSet.size===allItems.length){
    filterSet=null;
  }

  if(col==='brand') selectedBrands=filterSet;
  else selectedUnits=filterSet;

  renderAll();
});

window.addEventListener('resize', positionPopover);
window.addEventListener('scroll', positionPopover, true);

// ── MODAL REESTRUCTURADO ─────────────────────────────────
function openModal(id){
  const p=pool.get(id); if(!p) return;
  const imgs=p.images?.length?p.images:[];
  const d=pct(p.price,p.list), saving=p.list>p.price?p.list-p.price:0;
  const ul=unitLabel(p.unit);
  const specRows=Object.entries(p.spec||{}).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  const eanRow=p.ean?`<tr><td>EAN</td><td><code>${esc(p.ean)}</code></td></tr>`:'';
  const colRow=p.collections?.length?`<tr><td>Colección</td><td>${p.collections.map(c=>`<strong>${esc(c)}</strong>`).join(', ')}</td></tr>`:'';

  $('#mbox').innerHTML=`
    <div class="modal-top">
      <div class="modal-gallery">
        <img class="big-img" id="big" src="${esc(imgs[0]||'')}" alt="">
        <div class="thumbs">${imgs.map((u,i)=>`<img src="${esc(thumb(u))}" data-img="${esc(u)}" class="${i===0?'on':''}" alt="">`).join('')}</div>
      </div>
      <div class="modal-info">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="modal-brand">${esc(p.brand)}</div>
          <button class="btn btn-sec btn-sm" id="close">✕ Cerrar</button>
        </div>
        <div class="modal-name">${esc(p.name)}</div>
        <div class="modal-price-block">
          <div class="modal-price">${money(p.price)}</div>
          <div class="modal-unit-label">por ${esc(ul)}</div>
          ${d>0?`<span style="background:linear-gradient(135deg,#e67e22,#d35400);color:#fff;font-size:14px;font-weight:800;padding:4px 10px;border-radius:8px">-${d}%</span>`:''}
        </div>
        ${p.list>p.price?`<div>
          <div class="modal-list-price">Lista: ${money(p.list)}</div>
          <div class="modal-disc-pct">Ahorras ${money(saving)} por ${esc(ul)}</div>
        </div>`:''}
        <div>
          <span class="badge-avail ${p.available?'avail-yes':'avail-no'}">${p.available?'✔ Disponible':'✖ Agotado'}</span>
          ${p.cat?`<span class="sub" style="margin-left:6px">${esc(p.cat)}</span>`:''}
        </div>
        ${p.collections?.length?`<div class="sub">📂 ${p.collections.map(c=>esc(c)).join(', ')}</div>`:''}
        <div class="modal-top-actions">
          <a href="${esc(p.link)}" target="_blank" rel="noopener" class="btn btn-primary" style="display:inline-flex;align-items:center;gap:6px">Abrir en Sinsa ↗</a>
        </div>
      </div>
    </div>
    <div class="modal-bottom">
      <div class="section-label">Identificación</div>
      <table class="specs-table">
        ${p.ref?`<tr><td>Referencia</td><td>${esc(p.ref)}</td></tr>`:''}
        ${eanRow}
        <tr><td>Unidad de medida</td><td><span class="unit-badge" style="font-size:12px;padding:3px 8px">${esc(ul)}</span></td></tr>
        ${colRow}
      </table>
      ${Object.keys(p.spec||{}).length?`<div class="section-label">Especificaciones</div><table class="specs-table">${specRows}</table>`:''}
      ${p.desc?`<div class="section-label">Descripción</div><div class="modal-desc">${p.desc}</div>`:''}
    </div>`;
  $('#modal').classList.add('on');
}

// ── EVENTOS ──────────────────────────────────────────────
let searchTimer=null;
$('#q').addEventListener('input',e=>{
  clearTimeout(searchTimer);
  searchTimer=setTimeout(()=>{userQuery=e.target.value.trim();renderAll();},200);
});
$('#sort-sel').addEventListener('change',()=>{
  sortKey=null;
  renderAll();
});
$('#reload-btn').addEventListener('click',startScan);
$('#more').hidden=true;

document.addEventListener('click',e=>{
  const t=e.target;

  // Botón cerrar popover
  if(t.id==='popover-close' || t.closest('#popover-close')){
    closeFilterPopover();
    return;
  }

  // Filtro de columnas
  const filterBtn = t.closest('[data-filter-col]');
  if(filterBtn){
    openFilterPopover(filterBtn.dataset.filterCol, filterBtn);
    return;
  }
  if(!t.closest('#col-filter-popover') && !t.closest('[data-filter-col]')){
    closeFilterPopover();
  }

  if(t.dataset.open){openModal(t.dataset.open);return;}
  if(t.dataset.k){sortDir=sortKey===t.dataset.k?-sortDir:1;sortKey=t.dataset.k;renderAll();return;}
  if(t.dataset.img){$('#big').src=t.dataset.img;$$('.thumbs img').forEach(i=>i.classList.toggle('on',i===t));return;}
  if(t.id==='close'||t.id==='modal')$('#modal').classList.remove('on');
});

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    $('#modal').classList.remove('on');
    closeFilterPopover();
  }
});

// ── INICIO ───────────────────────────────────────────────
startScan();
