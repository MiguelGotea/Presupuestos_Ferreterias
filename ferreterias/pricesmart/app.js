const DATA_URL = '/ferreterias/pricesmart/data/productos.json';
const isDiscountPage = document.body.classList.contains('discount-only');
const $ = selector => document.querySelector(selector);
const money = value => `C$${Number(value || 0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const percent = product => product.listPrice > product.price ? Math.round((1 - product.price / product.listPrice) * 100) : 0;

let all = [];
let shown = [];
let budget = JSON.parse(localStorage.getItem('pricesmart-budget') || '[]');

function saveBudget() {
  localStorage.setItem('pricesmart-budget', JSON.stringify(budget));
  renderBudget();
}

function add(id) {
  const product = all.find(item => item.id === id);
  if (!product) return;
  const existing = budget.find(item => item.id === id);
  if (existing) existing.qty++;
  else budget.push({...product, qty: 1});
  saveBudget();
}

function renderBudget() {
  const container = $('#budget-items');
  if (!container) return;
  const total = budget.reduce((sum,item) => sum + item.price * item.qty, 0);
  $('#budget-total').textContent = money(total);
  $('#budget-count').textContent = `${budget.length} ${budget.length === 1 ? 'producto' : 'productos'}`;
  container.innerHTML = budget.length ? budget.map(item => `<div class="item">
    <img src="${esc(item.image)}" alt="" onerror="this.style.visibility='hidden'">
    <div class="item-main"><div class="item-name">${esc(item.name)}</div><div class="sub">${money(item.price)}</div></div>
    <input class="qty" type="number" min="1" value="${item.qty}" data-qty="${esc(item.id)}">
    <button class="btn" data-remove="${esc(item.id)}" title="Quitar">×</button>
  </div>`).join('') : '<div class="empty">Añade productos para preparar un presupuesto.</div>';
}

function productRow(product) {
  const saving = product.listPrice - product.price;
  return `<tr>
    <td><img class="pic" src="${esc(product.image)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"></td>
    <td><div class="name">${esc(product.name)}</div><div class="sub">${esc(product.promotion || product.cat || '')}</div></td>
    <td><span class="${product.available ? 'available':'unavailable'}">${product.available ? 'Disponible':'Fuera de inventario'}</span></td>
    <td class="price">${money(product.price)}${product.listPrice > product.price ? `<span class="old">${money(product.listPrice)}</span>`:''}</td>
    ${isDiscountPage ? `<td class="sale">${product.listPrice > product.price ? `-${percent(product)}%<span class="sub">Ahorras ${money(saving)}</span>` : esc(product.promotion || 'Promoción vigente')}</td>`:''}
    <td><button class="btn" data-view="${esc(product.id)}">Ver</button>${!isDiscountPage ? ` <button class="btn action" data-add="${esc(product.id)}">+</button>`:''}</td>
  </tr>`;
}

function render() {
  const term = ($('#search').value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  shown = all.filter(product => {
    const haystack = `${product.name} ${product.sku} ${product.cat} ${product.promotion}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    return (!isDiscountPage || product.isPromotion || product.listPrice > product.price) && (!term || haystack.includes(term));
  });
  $('#count').textContent = `${shown.length} ${shown.length === 1 ? 'producto' : 'productos'}`;
  $('#results').innerHTML = shown.length ? `<table><thead><tr><th></th><th>Producto</th><th>Estado</th><th>Precio</th>${isDiscountPage ? '<th>Ahorro</th>':''}<th></th></tr></thead><tbody>${shown.map(productRow).join('')}</tbody></table>` : '<div class="empty">No hay productos para mostrar. Ejecuta el descargador o cambia la búsqueda.</div>';
}

function openModal(id) {
  const product = all.find(item => item.id === id);
  if (!product) return;
  const discount = product.listPrice > product.price;
  $('#modal-content').innerHTML = `<button class="close" data-close>×</button><div class="detail">
    <img src="${esc(product.image)}" alt="${esc(product.name)}" onerror="this.style.visibility='hidden'">
    <div><div class="sub">PriceSmart Nicaragua · ${esc(product.promotion || product.cat || '')}</div><h2>${esc(product.name)}</h2>
    <div class="price">${money(product.price)}</div>${discount ? `<div class="old">Precio anterior: ${money(product.listPrice)}</div><p class="sale">Ahorras ${money(product.listPrice-product.price)} (${percent(product)}%)</p>`:''}
    <p class="${product.available?'available':'unavailable'}">${product.available ? 'Disponible al momento de la descarga':'Fuera de inventario al momento de la descarga'}</p>
    ${!isDiscountPage ? `<button class="btn action" data-add="${esc(product.id)}">Añadir al presupuesto</button> `:''}<a class="btn" href="${esc(product.link)}" target="_blank" rel="noopener">Abrir en PriceSmart ↗</a></div>
  </div>`;
  $('#modal').classList.add('on');
}

async function load() {
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    all = data.products || [];
    if (data.generatedAt) $('#updated').textContent = `Última descarga: ${new Date(data.generatedAt).toLocaleString('es-NI')}`;
    render(); renderBudget();
  } catch (error) {
    $('#results').innerHTML = `<div class="empty">No se pudo leer el catálogo: ${esc(error.message)}.</div>`;
  }
}

$('#search').addEventListener('input', render);
document.addEventListener('click', event => {
  const target = event.target;
  if (target.dataset.add) add(target.dataset.add);
  if (target.dataset.view) openModal(target.dataset.view);
  if (target.dataset.remove) { budget = budget.filter(item => item.id !== target.dataset.remove); saveBudget(); }
  if (target.dataset.close || target.id === 'modal') $('#modal').classList.remove('on');
});
document.addEventListener('change', event => {
  if (!event.target.dataset.qty) return;
  const item = budget.find(product => product.id === event.target.dataset.qty);
  if (item) { item.qty = Math.max(1, Number(event.target.value) || 1); saveBudget(); }
});
$('#clear-budget')?.addEventListener('click', () => { budget = []; saveBudget(); });
load();
