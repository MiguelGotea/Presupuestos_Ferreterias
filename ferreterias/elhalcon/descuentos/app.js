// app.js — El Halcón Descuentos
// Usa WooCommerce Store v1 con on_sale=true para traer productos en oferta

const API = '/api/elhalcon/wp-json/wc/store/v1/products';
const PAGE = 100;

const $  = s => document.querySelector(s);
const money = n => 'C$' + (Number(n) / 100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc   = s => String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pct   = (p,r) => r>p ? Math.round((1-p/r)*100) : 0;

let allProducts = []; // todos los con descuento
let filtered    = [];
let scanning    = false;
let currentPage = 1;
let totalPages  = 1;

/* ── Cargar todos los productos en oferta ── */
async function loadOnSale(){
  if(scanning) return;
  scanning = true;
  allProducts = [];
  currentPage = 1;
  totalPages  = 1;
  $('#status-msg').textContent = 'Buscando ofertas…';
  setLoadFill(0);

  while(currentPage <= totalPages){
    try{
      const url = `${API}?on_sale=true&per_page=${PAGE}&page=${currentPage}`;
      const r = await fetch(url);
      if(!r.ok) throw new Error('HTTP '+r.status);
      const total = Number(r.headers.get('X-WP-Total')||0);
      const tp    = Number(r.headers.get('X-WP-TotalPages')||1);
      if(currentPage===1) totalPages = tp;
      const items = await r.json();
      allProducts = allProducts.concat((items||[]).map(norm).filter(p=>p.onSale));
      const progress = Math.round((currentPage/totalPages)*100);
      setLoadFill(progress);
      $('#status-msg').textContent = `Página ${currentPage}/${totalPages} — ${allProducts.length} ofertas encontradas`;
      currentPage++;
    }catch(e){
      $('#status-msg').textContent = 'Error: '+e.message;
      break;
    }
  }

  scanning = false;
  setLoadFill(100);
  $('#status-msg').textContent = `✔ ${allProducts.length} productos en oferta`;
  renderDiscount();
}

function setLoadFill(pct){
  $('#load-fill').style.width = pct+'%';
}

function norm(p){
  const prices  = p.prices || {};
  const price   = Number(prices.price ?? 0);
  const regular = Number(prices.regular_price ?? 0);
  const onSale  = p.on_sale || price < regular;
  const cats    = (p.categories||[]).map(c=>c.name).filter(Boolean);
  const img     = p.images?.[0];
  return {
    id:      String(p.id),
    name:    p.name || '',
    sku:     p.sku  || '',
    price, regular, onSale,
    cat:     cats.join(' > '),
    link:    p.permalink || '',
    thumb:   img?.thumbnail || img?.src || '',
    image:   img?.src || '',
    available: p.is_in_stock,
  };
}

function renderDiscount(){
  const q = $('#q').value.toLowerCase().trim();
  const sortVal = $('#sort-sel').value;

  const terms=q.normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/\s+/).filter(Boolean);
  filtered = allProducts.filter(p => {
    if(!terms.length) return true;
    const text=`${p.name} ${p.cat}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es');
    return terms.every(term=>text.includes(term));
  });

  filtered.sort((a,b)=>{
    if(sortVal==='disc')       return pct(b.price,b.regular) - pct(a.price,a.regular);
    if(sortVal==='saving')     return (b.regular-b.price) - (a.regular-a.price);
    if(sortVal==='price-asc')  return a.price - b.price;
    if(sortVal==='price-desc') return b.price - a.price;
    return 0;
  });

  // Estadísticas
  const discList = filtered.map(p=>pct(p.price,p.regular)).filter(d=>d>0);
  $('#stat-total').textContent = filtered.length;
  $('#stat-max').textContent   = discList.length ? Math.max(...discList)+'%' : '—';
  $('#stat-avg').textContent   = discList.length ? Math.round(discList.reduce((s,d)=>s+d,0)/discList.length)+'%' : '—';
  $('#filter-count').textContent = q ? `${filtered.length} resultado${filtered.length!==1?'s':''} para "${q}"` : '';

  if(!filtered.length){
    $('#results').innerHTML='<div class="empty">Sin productos en oferta encontrados.</div>';
    return;
  }

  $('#results').innerHTML=`<table>
    <thead><tr>
      <th></th>
      <th>Producto</th>
      <th>Categoría</th>
      <th>SKU</th>
      <th style="text-align:right">Oferta</th>
      <th style="text-align:right">Regular</th>
      <th style="text-align:center">Desc.</th>
      <th style="text-align:right">Ahorro</th>
    </tr></thead>
    <tbody>${filtered.map(productRow).join('')}</tbody>
  </table>`;
}

function productRow(p){
  const d = pct(p.price, p.regular);
  const saving = p.regular - p.price;
  return `<tr>
    <td class="img-cell"><a href="${esc(p.link)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(p.thumb)}" alt=""></a></td>
    <td>
      <div class="name"><a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.name)}</a></div>
      <div class="sub">${esc(p.cat)}</div>
    </td>
    <td style="font-size:11px;color:var(--mu)">${esc(p.cat||'—')}</td>
    <td><span class="sku-badge">${esc(p.sku||'—')}</span></td>
    <td class="price-col">${money(p.price)}</td>
    <td class="list-col">${money(p.regular)}</td>
    <td style="text-align:center"><span class="badge-disc">-${d}%</span></td>
    <td class="saving-col">${money(saving)}</td>
  </tr>`;
}

/* ── Eventos ── */
$('#reload-btn').onclick = loadOnSale;
$('#q').addEventListener('input', ()=>{ clearTimeout(window._qt); window._qt=setTimeout(renderDiscount,250); });
$('#sort-sel').addEventListener('change', renderDiscount);

// Arrancar
loadOnSale();
