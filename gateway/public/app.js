// Frontend for Haat. Plain JavaScript, no build step, so it works as soon as the gateway starts.

const state = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  cart: [],
  epoch: 0,
  wish: JSON.parse(localStorage.getItem('wish') || '[]'),
  q: '',
  category: '',
  sort: 'new',
  showSaved: false,
  products: [],
  cats: [],
  checkoutKey: null,
  poll: null,
};

// each account has its own cart, so switching users in one window does not mix carts
const cartKey = () => 'cart:' + (state.user ? state.user.id : 'guest');
function loadCart() {
  try { return JSON.parse(localStorage.getItem(cartKey()) || '[]'); } catch (e) { return []; }
}
state.cart = loadCart();

// go to a page, and make sure it is drawn even if we are already on that hash
function go(hash) {
  if (location.hash === hash) render(); else location.hash = hash;
}

const $ = (s) => document.querySelector(s);
const view = $('#view');
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (state.token) h.Authorization = 'Bearer ' + state.token;
  const res = await fetch('/api' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) {
    logout(true);
    throw new Error(data.error || 'Please log in again');
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

let toastTimer;
function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3200);
}

// wraps an action so errors show up as a toast
async function attempt(fn) {
  try { return await fn(); } catch (e) { toast(e.message, true); }
}

function saveCart() { localStorage.setItem(cartKey(), JSON.stringify(state.cart)); }
function saveWish() { localStorage.setItem('wish', JSON.stringify(state.wish)); }
function cartCount() { return state.cart.reduce((n, i) => n + i.qty, 0); }

function logout(expired) {
  state.token = null; state.user = null;
  localStorage.removeItem('token'); localStorage.removeItem('user');
  state.cart = [];
  go('#/login');
  if (expired) toast('Your session expired, please log in again', true);
}

// ---------- small ui helpers ----------
const emojiFor = { Clothing: '👕', Food: '🍯', Home: '🏺', Electronics: '🎧', Books: '📚', Beauty: '🌿', Toys: '🪁', Jewellery: '📿' };
const colours = ['#fde7b0', '#cfe8e4', '#f6d3d9', '#d9e4f5', '#e4dcf3', '#dcefd2'];
function thumb(p) {
  const bg = colours[(p.title || '').length % colours.length];
  const emoji = emojiFor[p.category] || '🛍️';
  const url = (p.imageUrl || '').trim();
  if (url) {
    // the emoji sits behind the photo: if the photo loads it is removed, if the link is broken the photo is removed
    return `<div class="thumb" style="background:${bg}">
      <img src="${esc(url)}" alt="${esc(p.title)}" referrerpolicy="no-referrer" loading="lazy"
        onload="this.nextElementSibling.remove()" onerror="this.remove()"><span>${emoji}</span></div>`;
  }
  return `<div class="thumb" style="background:${bg}">${emoji}</div>`;
}

function statusTag(s) {
  const kind = { confirmed: 'good', completed: 'good', delivered: 'good', shipped: 'good', verified: 'good', paid: 'good',
    failed: 'bad', cancelled: 'bad', suspended: 'bad', returned: 'bad',
    pending_payment: 'warn', payment_received: 'warn', pending: 'warn', processing: 'warn' }[s] || '';
  return `<span class="tag ${kind}">${esc(String(s).replace('_', ' '))}</span>`;
}

// little progress line for a seller's part of an order
function stepper(status) {
  if (status === 'cancelled' || status === 'returned') return '';
  const order = ['pending', 'processing', 'shipped', 'delivered'];
  const labels = ['Placed', 'Packing', 'Shipped', 'Delivered'];
  const at = order.indexOf(status);
  return `<div class="steps">${labels.map((l, i) => `<div class="step ${i < at || status === 'delivered' ? 'done' : i === at ? 'now' : ''}">${l}</div>`).join('')}</div>`;
}

function barChart(rows, label) {
  const max = Math.max(...rows.map((r) => r.amount), 1);
  return `<div class="chart" role="img" aria-label="${esc(label)}">${rows.map((r) => `
    <div class="bar-col" title="${r.day}: ${money(r.amount)} (${r.orders} sale${r.orders === 1 ? '' : 's'})">
      <div class="bar-val">${r.amount ? '₹' + Math.round(r.amount) : ''}</div>
      <div class="cbar" style="height:${Math.max((r.amount / max) * 100, 2)}%"></div>
      <div class="bar-lab">${r.day.slice(8)}/${r.day.slice(5, 7)}</div>
    </div>`).join('')}</div>`;
}

// every page change bumps the epoch, so a slow reply or old timer from the previous page does nothing
function clearPoll() { clearTimeout(state.poll); state.poll = null; state.epoch++; }
function later(fn, ms) {
  const e = state.epoch;
  state.poll = setTimeout(() => { if (e === state.epoch) fn(); }, ms);
}

// ---------- nav ----------
async function renderNav() {
  const u = state.user;
  const here = location.hash || '#/';
  const link = (href, text) => `<a href="${href}" class="${here === href ? 'on' : ''}">${text}</a>`;
  let html = link('#/', 'Shop');
  if (!u || u.role === 'customer') html += link('#/cart', `Cart${cartCount() ? `<span class="pill">${cartCount()}</span>` : ''}`);
  if (u && u.role === 'customer') html += link('#/orders', 'My orders');
  if (u && u.role === 'vendor') html += link('#/vendor', 'Seller dashboard');
  if (u && u.role === 'admin') html += link('#/admin', 'Admin');
  if (u) html += `<a href="#/alerts" id="bell" class="${here === '#/alerts' ? 'on' : ''}">Alerts</a><button data-act="logout">Log out (${esc(u.name.split(' ')[0])})</button>`;
  else html += link('#/login', 'Log in') + link('#/signup', 'Sign up');
  $('#nav').innerHTML = html;

  if (u) {
    try {
      const list = await api('/notifications');
      const unread = list.filter((n) => !n.read).length;
      if (unread && $('#bell')) $('#bell').insertAdjacentHTML('beforeend', `<span class="pill">${unread}</span>`);
    } catch (e) { /* nav should never break the page */ }
  }
}

// ---------- shop ----------
function renderChips() {
  $('#chips').innerHTML =
    ['', ...state.cats].map((c) => `<button class="chip ${!state.showSaved && state.category === c ? 'on' : ''}" data-act="category" data-c="${esc(c)}">${c || 'All'}</button>`).join('') +
    `<button class="chip ${state.showSaved ? 'on' : ''}" data-act="saved">♥ Saved (${state.wish.length})</button>`;
}

async function shopView() {
  view.innerHTML = `
    <h1>Everything from independent sellers, in one cart</h1>
    <p class="muted">Order from several shops at once. Each seller ships their own part.</p>
    <div class="toolbar">
      <input id="q" placeholder="Search for honey, kurta, headphones..." value="${esc(state.q)}" aria-label="Search products" autocomplete="off">
      <select id="sort" aria-label="Sort products">
        <option value="new" ${state.sort === 'new' ? 'selected' : ''}>Newest first</option>
        <option value="low" ${state.sort === 'low' ? 'selected' : ''}>Price: low to high</option>
        <option value="high" ${state.sort === 'high' ? 'selected' : ''}>Price: high to low</option>
      </select>
    </div>
    <div class="chips" id="chips"></div>
    <div class="grid" id="grid">${'<div class="skeleton"></div>'.repeat(4)}</div>`;
  const e = state.epoch;
  await attempt(async () => {
    try {
      state.cats = await api('/catalogue/categories');
      if (e !== state.epoch) return;
      renderChips();
      await loadProducts();
    } catch (err) {
      if ($('#grid')) $('#grid').innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>Could not load products</h3><p>${esc(err.message)}</p></div>`;
      throw err;
    }
  });
}

async function loadProducts() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.category) params.set('category', state.category);
  state.products = await api('/catalogue/products?' + params);
  paintProducts();
}

function paintProducts() {
  const grid = $('#grid');
  if (!grid) return;
  let list = state.products.slice();
  if (state.showSaved) list = list.filter((p) => state.wish.includes(p._id));
  if (state.sort === 'low') list.sort((a, b) => a.price - b.price);
  if (state.sort === 'high') list.sort((a, b) => b.price - a.price);

  if (!list.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>Nothing found</h3>
      <p>${state.showSaved ? 'Tap the heart on a product to save it here.' : 'Try another word, or ask a seller to list something. Sellers appear here once the admin verifies them.'}</p></div>`;
    return;
  }
  const canBuy = !state.user || state.user.role === 'customer';
  grid.innerHTML = list.map((p) => `
    <article class="product" data-act="open" data-id="${p._id}">
      ${thumb(p)}
      <button class="heart ${state.wish.includes(p._id) ? 'on' : ''}" data-act="wish" data-id="${p._id}" aria-label="Save ${esc(p.title)}">♥</button>
      <div class="body">
        <h3>${esc(p.title)}</h3>
        <span class="store">by ${esc(p.storeName)}</span>
        <span class="muted">${esc((p.description || '').slice(0, 70))}</span>
        ${p.stock <= 5 ? `<span class="low">Only ${p.stock} left</span>` : ''}
        <div class="row">
          <span class="price">${money(p.price)}</span>
          ${canBuy ? `<button class="btn small" data-act="add" data-id="${p._id}">Add to cart</button>` : ''}
        </div>
      </div>
    </article>`).join('');
}

function addToCart(p, qty) {
  if (!state.user) { toast('Log in to add items to your cart', true); go('#/login'); return false; }
  if (state.user.role !== 'customer') { toast('Only customer accounts can buy', true); return false; }
  const found = state.cart.find((i) => i.productId === p._id);
  const have = found ? found.qty : 0;
  if (have + qty > p.stock) { toast(`Only ${p.stock} in stock`, true); return false; }
  if (found) found.qty += qty;
  else state.cart.push({ productId: p._id, title: p.title, price: p.price, storeName: p.storeName, stock: p.stock, qty });
  saveCart(); renderNav();
  toast(`${p.title} added to cart`);
  return true;
}

// product pop-up
function openModal(p) {
  const canBuy = !state.user || state.user.role === 'customer';
  const m = $('#modal');
  m.hidden = false;
  m.innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(p.title)}">
      ${thumb(p)}
      <div class="dbody">
        <button class="x" data-act="closemodal" aria-label="Close">×</button>
        <h2>${esc(p.title)}</h2>
        <p class="store">Sold by <b>${esc(p.storeName)}</b> · ${esc(p.category)}</p>
        <p>${esc(p.description || 'The seller has not added a description yet.')}</p>
        <p class="price" style="font-size:1.4rem;margin:6px 0">${money(p.price)}</p>
        <p class="${p.stock <= 5 ? 'low' : 'muted'}" style="margin:0">${p.stock <= 5 ? `Hurry, only ${p.stock} left` : `${p.stock} in stock`}</p>
        ${canBuy ? `<div class="buyrow">
          <input id="mqty" type="number" min="1" max="${p.stock}" value="1" aria-label="Quantity">
          <button class="btn" data-act="modaladd" data-id="${p._id}" style="flex:1">Add to cart</button>
        </div>` : '<p class="muted">Log in with a customer account to buy.</p>'}
      </div>
    </div>`;
}
function closeModal() { $('#modal').hidden = true; }

// ---------- cart + checkout ----------
function cartView() {
  if (!state.cart.length) {
    view.innerHTML = `<div class="empty"><h2>Your cart is empty</h2><p>Add something from the shop first.</p><a class="btn" href="#/">Browse products</a></div>`;
    return;
  }
  // group by seller so the customer can see the order will be split
  const groups = {};
  state.cart.forEach((i) => (groups[i.storeName] = groups[i.storeName] || []).push(i));
  const total = state.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const n = Object.keys(groups).length;

  view.innerHTML = `
    <h1>Your cart</h1>
    <div class="cols" style="grid-template-columns:1.4fr 1fr">
      <div>
        ${Object.entries(groups).map(([store, items]) => `
          <div class="panel">
            <h3>${esc(store)}</h3>
            ${items.map((i) => `
              <div class="line">
                <div><b>${esc(i.title)}</b><br><span class="muted">${money(i.price)} each</span></div>
                <div class="qty">
                  <button data-act="dec" data-id="${i.productId}" aria-label="One less">−</button>
                  <span>${i.qty}</span>
                  <button data-act="inc" data-id="${i.productId}" aria-label="One more">+</button>
                  <button class="btn ghost small" data-act="remove" data-id="${i.productId}">Remove</button>
                </div>
              </div>`).join('')}
            <p class="muted" style="margin:8px 0 0">Seller subtotal: ${money(items.reduce((s, i) => s + i.price * i.qty, 0))}</p>
          </div>`).join('')}
      </div>
      <form class="panel" data-form="checkout" style="align-self:start">
        <h2>Checkout</h2>
        <p style="font-size:1.3rem;margin:0"><b>${money(total)}</b></p>
        <p class="muted" style="margin-top:0">${n} seller${n > 1 ? 's' : ''}, ${n} separate parcel${n > 1 ? 's' : ''}</p>
        ${state.user ? '' : '<p class="muted">You need to log in before you can pay.</p>'}
        <label for="address">Delivery address</label>
        <textarea id="address" name="address" rows="3" required placeholder="House no, street, city, PIN"></textarea>
        <label for="method">Payment (demo)</label>
        <select id="method" name="method">
          <option value="card">Card ending 4242 (will succeed)</option>
          <option value="test-fail">Card that gets declined</option>
        </select>
        <button class="btn" style="width:100%;margin-top:16px">Pay ${money(total)}</button>
      </form>
    </div>`;
}

// ---------- customer orders ----------
function orderCards(orders) {
  return orders.map((o) => `
    <div class="order-card">
      <div class="order-head">
        <div><b>Order #${o._id.slice(-6).toUpperCase()}</b> <span class="muted">${new Date(o.createdAt).toLocaleString('en-IN')}</span></div>
        <div>${statusTag(o.status)} <b>${money(o.totalAmount)}</b></div>
      </div>
      ${o.failureReason ? `<p class="low">${esc(o.failureReason)}</p>` : ''}
      ${o.subOrders.map((s) => `
        <div class="sub">
          <div class="order-head" style="margin:0">
            <b>${esc(s.vendorName)}</b>
            <span>${statusTag(s.status)} ${money(s.amount)}</span>
          </div>
          <div class="muted">${s.items.map((i) => `${esc(i.title)} × ${i.qty}`).join(', ')}</div>
          ${stepper(s.status)}
          ${s.trackingNo ? `<div class="muted">Tracking: ${esc(s.trackingNo)}</div>` : ''}
          ${s.status === 'delivered' ? `<button class="btn ghost small" style="margin-top:6px" data-act="return" data-o="${o._id}" data-v="${s.vendorId}">Return this part</button>` : ''}
        </div>`).join('')}
    </div>`).join('');
}

async function ordersView(first = true) {
  if (first) view.innerHTML = '<h1>My orders</h1><p class="muted">Loading...</p>';
  const e = state.epoch;
  await attempt(async () => {
    const orders = await api('/orders');
    if (e !== state.epoch) return; // user already moved to another page
    if (!orders.length) {
      view.innerHTML = `<h1>My orders</h1><div class="empty"><p>You have not ordered anything yet.</p><a class="btn" href="#/">Start shopping</a></div>`;
      return;
    }
    view.innerHTML = `<h1>My orders</h1><p class="muted">This page updates by itself while sellers work on your order.</p>` + orderCards(orders);
    later(() => ordersView(false), 3000);
  });
}

// ---------- login / signup ----------
function authView(mode) {
  const signup = mode === 'signup';
  view.innerHTML = `
    <form class="panel narrow" data-form="${mode}">
      <h1>${signup ? 'Create your account' : 'Welcome back'}</h1>
      ${signup ? `<label for="name">Your name</label><input id="name" name="name" required>` : ''}
      <label for="email">Email</label><input id="email" name="email" type="email" required>
      <label for="password">Password</label><input id="password" name="password" type="password" minlength="6" required>
      ${signup ? `<label for="role">I want to</label>
        <select id="role" name="role"><option value="customer">Buy things</option><option value="vendor">Sell things</option></select>` : ''}
      <button class="btn" style="width:100%;margin-top:18px">${signup ? 'Sign up' : 'Log in'}</button>
      <p class="muted" style="text-align:center">${signup ? 'Already have an account? <a href="#/login">Log in</a>' : 'New here? <a href="#/signup">Sign up</a>'}</p>
      ${signup ? '' : '<p class="muted" style="font-size:.85rem">Demo admin: admin@haat.local / admin123</p>'}
    </form>`;
}

// ---------- seller dashboard ----------
function vendorOrdersHtml(orders) {
  if (!orders.length) return '<p class="muted">No orders yet. They show up here after a customer pays.</p>';
  return orders.map((o) => `
    <div class="order-card">
      <div class="order-head">
        <div><b>Order #${String(o.orderId).slice(-6).toUpperCase()}</b> for ${esc(o.customerName)}</div>
        ${statusTag(o.subOrder.status)}
      </div>
      <div>${o.subOrder.items.map((i) => `${esc(i.title)} × ${i.qty}`).join(', ')} <b>· ${money(o.subOrder.amount)}</b></div>
      <div class="muted">Ship to: ${esc(o.address)}</div>
      ${stepper(o.subOrder.status)}
      <div style="margin-top:8px;display:flex;gap:8px">
        ${o.subOrder.status === 'processing' ? `
          <button class="btn small" data-act="ship" data-o="${o.orderId}">Mark as shipped</button>
          <button class="btn danger small" data-act="cancelsub" data-o="${o.orderId}">Cancel my part</button>` : ''}
        ${o.subOrder.status === 'shipped' ? `<button class="btn small" data-act="deliver" data-o="${o.orderId}">Mark as delivered</button>` : ''}
      </div>
    </div>`).join('');
}

function earningsHtml(earn) {
  return `<div class="stats">
    <div class="stat"><b>${money(earn.held)}</b><span>Held until delivery</span></div>
    <div class="stat"><b>${money(earn.available)}</b><span>Ready for next payout</span></div>
    <div class="stat"><b>${money(earn.paid)}</b><span>Paid to your account</span></div>
  </div>`;
}

// refreshes only the parts that change by themselves, so forms are not wiped while typing
async function refreshVendorLive() {
  if (!$('#vorders')) return;
  const e = state.epoch;
  try {
    const [earn, orders] = await Promise.all([api('/payouts/me'), api('/orders/vendor/list')]);
    if (e !== state.epoch) return;
    if ($('#vstats')) $('#vstats').innerHTML = earningsHtml(earn);
    if ($('#vchart')) $('#vchart').innerHTML = barChart(earn.daily, 'Your earnings in the last 7 days');
    $('#vorders').innerHTML = vendorOrdersHtml(orders);
  } catch (err) { /* ignore, try again next time */ }
  later(refreshVendorLive, 4000);
}

async function vendorView() {
  view.innerHTML = '<h1>Seller dashboard</h1><p class="muted">Loading...</p>';
  const e = state.epoch;
  await attempt(async () => {
    const vendor = await api('/vendors/me');
    if (e !== state.epoch) return;

    if (!vendor) {
      view.innerHTML = `
        <h1>Open your store</h1>
        <p class="muted">Tell us about your shop. The admin checks your documents before you can sell.</p>
        <form class="panel" data-form="onboard" style="max-width:560px">
          <label for="storeName">Store name</label><input id="storeName" name="storeName" required>
          <label for="description">What do you sell?</label><textarea id="description" name="description" rows="2"></textarea>
          <label for="kyc">KYC documents (names, separated by commas)</label>
          <input id="kyc" name="kyc" placeholder="PAN card, GST certificate, Cancelled cheque">
          <label for="acct">Payout account id</label>
          <input id="acct" name="acct" placeholder="Leave empty to use a demo account">
          <button class="btn" style="margin-top:16px">Send for verification</button>
        </form>`;
      return;
    }
    if (vendor.status !== 'verified') {
      view.innerHTML = `<h1>${esc(vendor.storeName)}</h1>
        <div class="panel">${statusTag(vendor.status)}
        <p>${vendor.status === 'pending'
          ? 'Your documents are with the admin. You can start listing products as soon as they verify your store. This page checks again every few seconds.'
          : 'Your store is suspended. Contact the platform admin.'}</p></div>`;
      if (vendor.status === 'pending') later(vendorView, 4000);
      return;
    }

    const [earn, products, orders] = await Promise.all([
      api('/payouts/me'), api('/catalogue/my-products'), api('/orders/vendor/list')]);
    if (e !== state.epoch) return;

    view.innerHTML = `
      <h1>${esc(vendor.storeName)}</h1>
      <p class="muted">Platform commission on your sales: ${vendor.commissionPct}%</p>
      <div id="vstats">${earningsHtml(earn)}</div>

      <div class="panel"><h2>Your earnings, last 7 days</h2><div id="vchart">${barChart(earn.daily, 'Your earnings in the last 7 days')}</div></div>

      <div class="panel"><h2>Orders to fulfil</h2><div id="vorders">${vendorOrdersHtml(orders)}</div></div>

      <div class="cols">
        <form class="panel" data-form="product">
          <h2>Add a product</h2>
          <label for="title">Title</label><input id="title" name="title" required>
          <label for="pdesc">Description</label><input id="pdesc" name="description">
          <label for="category">Category</label>
          <select id="category" name="category">${Object.keys(emojiFor).map((c) => `<option>${c}</option>`).join('')}</select>
          <div class="cols" style="gap:12px">
            <div><label for="price">Price (₹)</label><input id="price" name="price" type="number" min="1" step="0.01" required></div>
            <div><label for="stock">Stock</label><input id="stock" name="stock" type="number" min="0" required></div>
          </div>
          <label for="img">Image link (optional)</label><input id="img" name="imageUrl" placeholder="https://...">
          <button class="btn" style="margin-top:16px">List product</button>
        </form>

        <div class="panel"><h2>Payouts</h2>
          ${earn.payouts.length ? earn.payouts.map((p) => `
            <div class="line"><div><b>${money(p.netAmount)}</b><br><span class="muted">Sales ${money(p.grossAmount)} − commission ${money(p.commission)} − refunds ${money(p.refunds)}</span></div>
            <span class="muted">${new Date(p.createdAt).toLocaleDateString('en-IN')}</span></div>`).join('')
            : '<p class="muted">No payouts yet. The admin runs settlement for delivered orders.</p>'}
        </div>
      </div>

      <div class="panel"><h2>Your products</h2>
        ${products.length ? `<div class="scroll"><table>
          <tr><th>Product</th><th>Price</th><th>Stock</th><th>Status</th><th></th></tr>
          ${products.map((p) => `<tr>
            <td>${esc(p.title)}</td><td>${money(p.price)}</td><td>${p.stock}</td>
            <td><span class="tag ${p.status === 'active' ? 'good' : ''}">${p.status}</span></td>
            <td><button class="btn ghost small" data-act="restock" data-id="${p._id}" data-stock="${p.stock}">Change stock</button>
            <button class="btn ghost small" data-act="setimage" data-id="${p._id}">Change image</button>
            ${p.status === 'active'
              ? `<button class="btn ghost small" data-act="hide" data-id="${p._id}">Hide</button>`
              : `<button class="btn small" data-act="show" data-id="${p._id}">Show in shop</button>`}</td>
          </tr>`).join('')}</table></div>` : '<p class="muted">You have not listed anything yet.</p>'}
      </div>`;
    later(refreshVendorLive, 4000);
  });
}

// ---------- admin ----------
function healthHtml(h) {
  const names = { gateway: h.gateway, ...h.services };
  const dots = Object.entries(names).map(([n, v]) => `<div class="svc"><span class="dot ${v === 'up' ? '' : 'down'}"></span>${n}</div>`).join('');
  const queues = (h.queues || []).filter((q) => !q.name.startsWith('amq.')).map((q) =>
    `<span class="tag ${q.waiting ? 'warn' : ''}">${esc(q.name.replace('.events', ''))}: ${q.waiting} waiting</span>`).join('');
  return `<div class="health">${dots}</div><div class="queues">${queues}</div>`;
}

async function refreshHealth() {
  const box = $('#health');
  if (!box) return;
  const e = state.epoch;
  try {
    const h = await api('/system/health');
    if (e !== state.epoch) return;
    box.innerHTML = healthHtml(h);
  } catch (err) { /* keep last view */ }
  later(refreshHealth, 3000);
}

async function adminView() {
  view.innerHTML = '<h1>Admin</h1><p class="muted">Loading...</p>';
  const e = state.epoch;
  await attempt(async () => {
    const [vendors, summary, payouts, daily] = await Promise.all([
      api('/admin/vendors'), api('/payments/summary'), api('/payouts'), api('/payments/daily')]);
    if (e !== state.epoch) return;

    view.innerHTML = `
      <div class="order-head"><h1 style="margin:0">Admin</h1>
        <button class="btn ghost" data-act="seed">Load demo data</button></div>
      <div class="stats" style="margin-top:14px">
        <div class="stat"><b>${summary.orders}</b><span>Paid orders</span></div>
        <div class="stat"><b>${money(summary.grossSales)}</b><span>Gross sales</span></div>
        <div class="stat"><b>${money(summary.platformCommission)}</b><span>Platform commission</span></div>
        <div class="stat"><b>${money(summary.refunds)}</b><span>Refunded</span></div>
        <div class="stat"><b>${money(summary.held)}</b><span>Held in escrow</span></div>
      </div>

      <div class="cols">
        <div class="panel"><h2>Sales, last 7 days</h2>${barChart(daily, 'Gross sales in the last 7 days')}</div>
        <div class="panel"><h2>System health</h2>
          <div id="health"><p class="muted">Checking services...</p></div>
          <p class="muted" style="font-size:.85rem;margin-bottom:0">Try <code>docker compose stop payments</code>, place an order, and watch the queue grow. Start it again and it drains.</p>
        </div>
      </div>

      <div class="panel"><h2>Sellers</h2>
        ${vendors.length ? vendors.map((v) => `
          <div class="order-card">
            <div class="order-head"><div><b>${esc(v.storeName)}</b> <span class="muted">${esc(v.description || '')}</span></div>${statusTag(v.status)}</div>
            <div class="muted">Documents: ${v.kycDocs.length ? v.kycDocs.map((d) => esc(d.name)).join(', ') : 'none sent'} · Payout account: ${esc(v.payoutAccountId)}</div>
            <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
              <label style="margin:0" for="c-${v._id}">Commission %</label>
              <input id="c-${v._id}" type="number" min="0" max="50" value="${v.commissionPct}" style="width:80px">
              ${v.status !== 'verified' ? `<button class="btn small" data-act="verify" data-id="${v._id}" data-s="verified">Approve</button>` : ''}
              ${v.status === 'verified' ? `<button class="btn small ghost" data-act="verify" data-id="${v._id}" data-s="verified">Save commission</button>` : ''}
              ${v.status !== 'suspended' ? `<button class="btn danger small" data-act="verify" data-id="${v._id}" data-s="suspended">Suspend</button>` : ''}
              ${v.status === 'suspended' ? `<button class="btn danger small" data-act="delvendor" data-id="${v._id}" data-n="${esc(v.storeName)}">Delete store</button>` : ''}
            </div>
          </div>`).join('') : '<p class="muted">No seller has applied yet. Use "Load demo data" to add three sample stores.</p>'}
      </div>

      <div class="panel">
        <div class="order-head"><h2 style="margin:0">Settlement</h2><button class="btn dark" data-act="runpayouts">Run payouts now</button></div>
        <p class="muted">Pays every seller for delivered orders after commission and refunds. Running it twice never pays the same order twice.</p>
        ${payouts.length ? `<div class="scroll"><table>
          <tr><th>Seller</th><th>Sales</th><th>Commission</th><th>Refunds</th><th>Paid out</th><th>Transfer</th></tr>
          ${payouts.map((p) => `<tr><td>${esc(p.vendorName)}</td><td>${money(p.grossAmount)}</td><td>${money(p.commission)}</td><td>${money(p.refunds)}</td><td><b>${money(p.netAmount)}</b></td><td class="muted">${esc(p.transferId)}</td></tr>`).join('')}
        </table></div>` : ''}
      </div>`;
    refreshHealth();
  });
}

// ---------- demo data ----------
// Uses the normal public API, so it also shows that the whole system works end to end.
const DEMO_SELLERS = [
  { name: 'Gurleen Kaur', email: 'seller1@haat.demo', store: 'Phulkari House', desc: 'Handmade Punjabi textiles', commission: 12, products: [
    { title: 'Phulkari dupatta', description: 'Hand embroidered on soft cotton', category: 'Clothing', price: 1299, stock: 15 },
    { title: 'Cotton kurta', description: 'Everyday kurta, breathable cotton', category: 'Clothing', price: 899, stock: 30 },
    { title: 'Punjabi jutti', description: 'Leather juttis with thread work', category: 'Clothing', price: 749, stock: 20 },
    { title: 'Handloom shawl (last piece)', description: 'Only one made this season', category: 'Clothing', price: 1999, stock: 1 } ] },
  { name: 'Harpreet Singh', email: 'seller2@haat.demo', store: 'Amritsar Pantry', desc: 'Pickles, ghee and honey from local farms', commission: 10, products: [
    { title: 'Mango pickle 500g', description: 'Sun cured, mustard oil', category: 'Food', price: 350, stock: 40 },
    { title: 'Desi ghee 500ml', description: 'Bilona method ghee', category: 'Food', price: 750, stock: 25 },
    { title: 'Wild honey 350g', description: 'Raw, unfiltered', category: 'Food', price: 420, stock: 35 },
    { title: 'Makki atta 1kg', description: 'Stone ground corn flour', category: 'Food', price: 180, stock: 50 } ] },
  { name: 'Aman Verma', email: 'seller3@haat.demo', store: 'Chandigarh Gadgets', desc: 'Small electronics that just work', commission: 8, products: [
    { title: 'Wireless earbuds', description: '24 hour battery with case', category: 'Electronics', price: 1499, stock: 18 },
    { title: 'Power bank 10000mAh', description: 'Fast charging, two ports', category: 'Electronics', price: 999, stock: 22 },
    { title: 'Smart plug', description: 'Control from your phone', category: 'Electronics', price: 699, stock: 30 },
    { title: 'USB-C cable 1m', description: 'Braided, 60W', category: 'Electronics', price: 299, stock: 60 } ] },
];

async function raw(path, { method = 'GET', body, token } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || 'Request failed');
  return data;
}

async function loginOrRegister(name, email, role) {
  try { return await raw('/auth/login', { method: 'POST', body: { email, password: 'demo123' } }); }
  catch (e) { return raw('/auth/register', { method: 'POST', body: { name, email, password: 'demo123', role } }); }
}

async function seedDemo() {
  toast('Loading demo data, this takes a few seconds...');
  for (const s of DEMO_SELLERS) {
    const auth = await loginOrRegister(s.name, s.email, 'vendor');
    let vendor = await raw('/vendors/me', { token: auth.token });
    if (!vendor) {
      vendor = await raw('/vendors/onboard', { method: 'POST', token: auth.token,
        body: { storeName: s.store, description: s.desc, kycDocs: [{ name: 'PAN card' }, { name: 'GST certificate' }] } });
    }
    if (vendor.status === 'pending') {
      await raw(`/admin/vendors/${vendor._id}/verify`, { method: 'PATCH', token: state.token,
        body: { status: 'verified', commissionPct: s.commission } });
    }
    const mine = await raw('/catalogue/my-products', { token: auth.token });
    if (!mine.length) for (const p of s.products) await raw('/catalogue/products', { method: 'POST', token: auth.token, body: p });
  }
  await loginOrRegister('Demo Customer', 'customer@haat.demo', 'customer');
  toast('Demo data ready. Customer login: customer@haat.demo / demo123');
  adminView();
}

// ---------- alerts ----------
async function alertsView() {
  view.innerHTML = '<h1>Alerts</h1><p class="muted">Loading...</p>';
  const e = state.epoch;
  await attempt(async () => {
    const list = await api('/notifications');
    if (e !== state.epoch) return;
    view.innerHTML = `<h1>Alerts</h1><div class="panel">
      ${list.length ? list.map((n) => `<div class="line"><span>${n.read ? '' : '<span class="pill" style="margin:0 8px 0 0">new</span>'}${esc(n.message)}</span>
        <span class="muted">${new Date(n.createdAt).toLocaleString('en-IN')}</span></div>`).join('') : '<p class="muted">Nothing yet.</p>'}</div>`;
    if (list.some((n) => !n.read)) {
      await api('/notifications/read-all', { method: 'POST' });
      renderNav();
    }
  });
}

// ---------- router ----------
async function render() {
  clearPoll();
  closeModal();
  const route = (location.hash.replace('#/', '') || '').split('?')[0];
  const needsLogin = ['orders', 'vendor', 'admin', 'alerts'];
  if (needsLogin.includes(route) && !state.user) { go('#/login'); return; }

  if (route === '') await shopView();
  else if (route === 'cart') cartView();
  else if (route === 'orders') await ordersView();
  else if (route === 'login') authView('login');
  else if (route === 'signup') authView('signup');
  else if (route === 'vendor') await vendorView();
  else if (route === 'admin') await adminView();
  else if (route === 'alerts') await alertsView();
  else view.innerHTML = '<div class="empty"><h2>Page not found</h2><a href="#/">Back to the shop</a></div>';
  renderNav();
}
window.addEventListener('hashchange', render);

// ---------- clicks ----------
const findProduct = (id) => state.products.find((p) => p._id === id);

document.addEventListener('click', (e) => {
  if (e.target.id === 'modal') return closeModal(); // click on the dark area
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const d = b.dataset;
  attempt(async () => {
    switch (d.act) {
      case 'logout': return logout();
      case 'category': state.category = d.c; state.showSaved = false; renderChips(); return loadProducts();
      case 'saved': state.showSaved = !state.showSaved; renderChips(); return paintProducts();
      case 'open': return openModal(findProduct(d.id));
      case 'closemodal': return closeModal();
      case 'wish': {
        const i = state.wish.indexOf(d.id);
        if (i >= 0) state.wish.splice(i, 1); else state.wish.push(d.id);
        saveWish(); renderChips(); return paintProducts();
      }
      case 'add': return addToCart(findProduct(d.id), 1);
      case 'modaladd': {
        const qty = Math.max(1, parseInt($('#mqty').value, 10) || 1);
        if (addToCart(findProduct(d.id), qty)) closeModal();
        return;
      }
      case 'inc': { const i = state.cart.find((x) => x.productId === d.id); if (i.qty < i.stock) i.qty++; else toast('That is all the stock we have', true); saveCart(); cartView(); return renderNav(); }
      case 'dec': { const i = state.cart.find((x) => x.productId === d.id); i.qty--; if (i.qty < 1) state.cart = state.cart.filter((x) => x !== i); saveCart(); cartView(); return renderNav(); }
      case 'remove': state.cart = state.cart.filter((x) => x.productId !== d.id); saveCart(); cartView(); return renderNav();
      case 'return':
        if (!confirm('Return this part of the order? The seller payout is adjusted and you get a refund.')) return;
        await api(`/orders/${d.o}/suborders/${d.v}/return`, { method: 'POST' });
        toast('Return accepted, refund on the way'); clearPoll(); return ordersView();
      case 'ship': {
        const trackingNo = prompt('Tracking number (optional)') || '';
        await api(`/orders/${d.o}/suborders/${state.user.id}/status`, { method: 'PATCH', body: { status: 'shipped', trackingNo } });
        toast('Marked as shipped'); clearPoll(); return vendorView();
      }
      case 'deliver':
        await api(`/orders/${d.o}/suborders/${state.user.id}/status`, { method: 'PATCH', body: { status: 'delivered' } });
        toast('Marked as delivered, your money moves out of escrow'); clearPoll(); return vendorView();
      case 'cancelsub':
        if (!confirm('Cancel your part of this order? The customer is refunded.')) return;
        await api(`/orders/${d.o}/suborders/${state.user.id}/status`, { method: 'PATCH', body: { status: 'cancelled' } });
        toast('Cancelled'); clearPoll(); return vendorView();
      case 'restock': {
        const n = prompt('New stock count', d.stock);
        if (n === null) return;
        await api('/catalogue/products/' + d.id, { method: 'PUT', body: { stock: n } });
        toast('Stock updated'); clearPoll(); return vendorView();
      }
      case 'setimage': {
        const url = prompt('Paste the image link (right click an image, then "Copy image address")');
        if (url === null) return;
        await api('/catalogue/products/' + d.id, { method: 'PUT', body: { imageUrl: url.trim() } });
        toast('Image updated'); clearPoll(); return vendorView();
      }
      case 'show':
        await api('/catalogue/products/' + d.id, { method: 'PUT', body: { status: 'active' } });
        toast('Product is visible in the shop again'); clearPoll(); return vendorView();
      case 'hide':
        await api('/catalogue/products/' + d.id, { method: 'DELETE' });
        toast('Product hidden'); clearPoll(); return vendorView();
      case 'verify': {
        const commissionPct = $('#c-' + d.id).value;
        await api(`/admin/vendors/${d.id}/verify`, { method: 'PATCH', body: { status: d.s, commissionPct } });
        toast(d.s === 'verified' ? 'Seller saved' : 'Seller suspended'); clearPoll(); return adminView();
      }
      case 'delvendor':
        if (!confirm(`Delete "${d.n}" and all its products? This cannot be undone.`)) return;
        await api('/admin/vendors/' + d.id, { method: 'DELETE' });
        toast('Store deleted'); clearPoll(); return adminView();
      case 'runpayouts': {
        const r = await api('/payouts/run', { method: 'POST' });
        toast(`${r.paidOut} payout(s) sent, ${r.carriedForward} carried forward`); clearPoll(); return adminView();
      }
      case 'seed': clearPoll(); return seedDemo();
    }
  });
});

// search while typing, sort when changed, Esc closes the pop-up
let searchTimer;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => attempt(async () => { state.q = e.target.value.trim(); await loadProducts(); }), 300);
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'sort') { state.sort = e.target.value; paintProducts(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------- forms ----------
document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));

  attempt(async () => {
    switch (form.dataset.form) {
      case 'login':
      case 'signup': {
        const data = await api('/auth/' + form.dataset.form.replace('signup', 'register'), { method: 'POST', body: f });
        state.token = data.token; state.user = data.user;
        localStorage.setItem('token', data.token); localStorage.setItem('user', JSON.stringify(data.user));
        toast('Hi ' + data.user.name.split(' ')[0] + '!');
        state.cart = loadCart();
        return go(data.user.role === 'vendor' ? '#/vendor' : data.user.role === 'admin' ? '#/admin' : '#/');
      }
      case 'checkout': {
        if (!state.user) { toast('Please log in to pay', true); return go('#/login'); }
        if (state.user.role !== 'customer') return toast('Only customer accounts can place orders', true);
        // same key is reused if the request is retried, so a retry can never create a second order
        if (!state.checkoutKey) state.checkoutKey = crypto.randomUUID();
        await api('/orders', {
          method: 'POST',
          headers: { 'Idempotency-Key': state.checkoutKey },
          body: { items: state.cart.map((i) => ({ productId: i.productId, qty: i.qty })), address: f.address, paymentMethod: f.method },
        });
        state.checkoutKey = null; state.cart = []; saveCart();
        toast('Order placed, confirming payment...');
        return go('#/orders');
      }
      case 'onboard':
        await api('/vendors/onboard', {
          method: 'POST',
          body: { storeName: f.storeName, description: f.description, payoutAccountId: f.acct,
            kycDocs: f.kyc.split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name })) },
        });
        toast('Sent for verification'); return vendorView();
      case 'product':
        await api('/catalogue/products', { method: 'POST', body: f });
        toast('Product listed'); clearPoll(); return vendorView();
    }
  });
});

render();
