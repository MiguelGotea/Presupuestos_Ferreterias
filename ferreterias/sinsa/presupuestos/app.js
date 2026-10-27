const API  = '/api/sinsa/io/_v/api/intelligent-search/product_search/';
const PAGE = 24;
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const money = n => 'C$' + Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc   = s => String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const thumb = u => u ? u.replace(/(\/ids\/\d+)\/[^?]*/,'$1-120-120/img.jpg') : '';
const pct   = (p,l) => l>p ? Math.round((1-p/l)*100) : 0;
const unitLabel = u => {
  if(!u) return 'Unidad';
  const m={m:'Metro',m2:'m²',m3:'m³',cm:'cm',kg:'kg',g:'gr',l:'Litro',ml:'ml',un:'Unidad',ud:'Unidad',pz:'Pieza',ft:'Pie','in':'Pulgada',gl:'Galón'};
  return m[u.toLowerCase()] || u;
};

let products=[], totalRecords=0, page=1, query='', sortKey=null, sortDir=1, ctrl=null, timer=null;
let showDiscOnly = false;
let selectedBrands = null; // null = sin filtro (todas); Set = marcas seleccionadas
let selectedUnits  = null; // null = sin filtro (todas); Set = unidades seleccionadas
let activeFilterCol = null;
let activeFilterBtn = null;

let budget = JSON.parse(localStorage.getItem('sinsa-budget')||'[]');
const pool = new Map(); // lookup global para modal

function norm(p){
  const item=p.items?.[0]||{};
  const off=item.sellers?.[0]?.commertialOffer||{};
  const spec={};
  (p.properties||[]).forEach(x=>{ if(x.name!=='sellerId' && x.name!=='Unidad de medida') spec[x.name]=(x.values||[]).join(', '); });
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
    teasers:off.Teasers||[],
  };
  pool.set(raw.id, raw);
  return raw;
}

async function search(reset=true){
  if(reset){
    page=1;products=[];
    selectedBrands=null;selectedUnits=null;
    closeFilterPopover();
  }
  if(query.length<2){render();return;}
  ctrl?.abort(); ctrl=new AbortController();
  $('#count').textContent='Buscando…';
  try{
    // El buscador de VTEX suele tratar la frase completa como una sola secuencia.
    // Consultar cada término por separado permite recuperar nombres con palabras
    // intermedias, por ejemplo "abanico de techo industrial".
    const terms=[...new Set(query.toLocaleLowerCase('es').split(/\s+/).filter(Boolean))];
    const queries=terms.length>1?terms:[query];
    const responses=await Promise.all(queries.map(async term=>{
      const url=`${API}?query=${encodeURIComponent(term)}&count=${PAGE}&page=${page}`;
      const r=await fetch(url,{signal:ctrl.signal});
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    }));
    const found=new Map();
    responses.forEach(j=>(j.products||[]).forEach(p=>found.set(String(p.productId),p)));
    const all=[...found.values()].map(norm);
    const wanted=terms.map(t=>t.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es'));
    const matches=terms.length>1?all.filter(p=>{
      const text=`${p.name} ${p.brand}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es');
      return wanted.every(t=>text.includes(t));
    }):all;
    products=products.concat(matches);
    totalRecords=Math.max(...responses.map(j=>j.recordsFiltered??0),products.length);
    render();
  }catch(e){
    if(e.name==='AbortError') return;
    $('#results').innerHTML=`<div class="empty">Error: ${esc(e.message)}. Verifica que server.js está corriendo.</div>`;
    $('#count').textContent='';
  }
}

function render(){
  let list=products.slice();
  if(selectedBrands!==null) list=list.filter(p=>selectedBrands.has(p.brand||'Sin marca'));
  if(selectedUnits!==null)  list=list.filter(p=>selectedUnits.has(unitLabel(p.unit)));
  if(showDiscOnly) list=list.filter(p=>p.list>p.price);
  if(sortKey){
    list.sort((a,b)=>{
      let va = sortKey==='unit' ? unitLabel(a.unit) : (a[sortKey]??'');
      let vb = sortKey==='unit' ? unitLabel(b.unit) : (b[sortKey]??'');
      if(typeof va==='string') va=va.toLowerCase();
      if(typeof vb==='string') vb=vb.toLowerCase();
      return (va>vb?1:-1)*sortDir;
    });
  }

  const filtersActive=[];
  if(showDiscOnly) filtersActive.push('con descuento');
  if(selectedBrands!==null) filtersActive.push(`marcas (${selectedBrands.size})`);
  if(selectedUnits!==null)  filtersActive.push(`unidades (${selectedUnits.size})`);

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
  const brandActive = selectedBrands !== null;
  const unitActive  = selectedUnits !== null;

  $('#results').innerHTML=
    `<table><thead><tr>
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
      <th></th>
    </tr></thead><tbody>`+
    list.map(productRow).join('')+'</tbody></table>';
  $('#more').hidden=products.length>=totalRecords;
}

function productRow(p){
  const d=pct(p.price,p.list);
  const ul=unitLabel(p.unit);
  return `<tr>
    <td class="img-cell"><img loading="lazy" src="${esc(thumb(p.images[0]))}" data-open="${p.id}" alt=""></td>
    <td>
      <div class="name">${esc(p.name)}</div>
      <div class="sub">Ref ${esc(p.ref)} · ${esc(p.cat)}${p.collections.length?' · '+esc(p.collections[0]):''}</div>
    </td>
    <td style="font-size:12px">${esc(p.brand||'Sin marca')}</td>
    <td><span class="unit-badge">${esc(ul)}</span></td>
    <td class="price-col">
      ${money(p.price)}${d>0?`<span class="badge-disc">-${d}%</span>`:''}
      ${p.list>p.price?`<div class="list-price">${money(p.list)}</div>`:''}
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
  render();
};
$('#popover-none').onclick = () => {
  if(activeFilterCol==='brand') selectedBrands=new Set();
  else if(activeFilterCol==='unit') selectedUnits=new Set();
  renderFilterItems();
  render();
};
$('#popover-reset').onclick = () => {
  if(activeFilterCol==='brand') selectedBrands=null;
  else if(activeFilterCol==='unit') selectedUnits=null;
  renderFilterItems();
  render();
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

  render();
});

window.addEventListener('resize', positionPopover);
window.addEventListener('scroll', positionPopover, true);

/* MODAL */
function openModal(id){
  const p=pool.get(id)||budget.find(x=>x.id===id); if(!p) return;
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
          ${d>0?`<span class="badge-disc">-${d}%</span>`:''}
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
          <button class="btn btn-primary" data-add="${p.id}">+ Añadir al presupuesto</button>
          <a href="${esc(p.link)}" target="_blank" rel="noopener" class="btn btn-sec">Abrir en Sinsa ↗</a>
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

/* PRESUPUESTO */
function save(){localStorage.setItem('sinsa-budget',JSON.stringify(budget));renderBudget();}
function add(id){
  const ex=budget.find(b=>b.id===id);
  if(ex){ex.qty++;}else{const p=pool.get(id);if(p)budget.push({...p,qty:1});}
  save();
  const panel=$('#budget-panel');
  panel.style.boxShadow='0 0 0 3px #28a745';
  setTimeout(()=>panel.style.boxShadow='',700);
}
function renderBudget(){
  const grand=budget.reduce((s,b)=>s+b.price*b.qty,0);
  const discSave=budget.reduce((s,b)=>b.list>b.price?s+(b.list-b.price)*b.qty:s,0);
  $('#nitems').textContent=budget.length+(budget.length===1?' ítem':' ítems');
  $('#total').textContent=money(grand);
  if(!budget.length){$('#budget').innerHTML='<div class="empty">Añade productos con "+".</div>';return;}
  $('#budget').innerHTML=`
    <table>
      <thead><tr>
        <th></th><th>Producto</th>
        <th style="text-align:center">Unidad<br>c/u</th>
        <th style="text-align:center">Cant.</th>
        <th style="text-align:right">Subtotal</th>
        <th></th>
      </tr></thead>
      <tbody>${budget.map(b=>{
        const d=pct(b.price,b.list), ul=unitLabel(b.unit);
        return `<tr>
          <td class="img-cell"><img src="${esc(thumb(b.images?.[0]))}" data-open="${b.id}" alt=""></td>
          <td>
            <div class="name" style="font-size:11px">${esc(b.name)}</div>
            <div class="sub">${esc(b.brand)}${d>0?` <span class="badge-disc">-${d}%</span>`:''}</div>
          </td>
          <td class="budget-unit-cell">
            <span class="unit-badge">${esc(ul)}</span>
            <div class="bud-cu">${money(b.price)}</div>
          </td>
          <td style="text-align:center">
            <input class="qty-input" type="number" min="1" value="${b.qty}" data-qty="${b.id}">
          </td>
          <td class="budget-subtotal">${money(b.price*b.qty)}</td>
          <td><button class="x-btn" data-del="${b.id}" title="Quitar">✕</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    ${discSave>0?`<div style="padding:7px 14px;font-size:11px;color:var(--od);font-weight:600;background:var(--ob);border-top:1px solid #f5cba7">🏷️ Ahorras ${money(discSave)} en descuentos</div>`:''}`;
}

/* TOGGLE SOLO DESCUENTO */
$('#toggle-disc').addEventListener('click',()=>{
  showDiscOnly=!showDiscOnly;
  $('#toggle-disc').classList.toggle('on',showDiscOnly);
  render();
});

/* EVENTOS */
$('#q').addEventListener('input',e=>{clearTimeout(timer);timer=setTimeout(()=>{query=e.target.value.trim();search(true);},280);});
$('#more').addEventListener('click',()=>{page++;search(false);});

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
