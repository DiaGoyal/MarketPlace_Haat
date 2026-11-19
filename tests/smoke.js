// End to end test. It talks to the gateway like a real browser would
// and checks the order saga, refunds, idempotency, payouts and permissions.
// Run:  docker compose --profile test run --rm tests

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@haat.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const run = Date.now(); // makes every email unique, so the test can be run again and again

let passed = 0;
let failed = 0;

function check(name, ok, extra) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> got: ' + JSON.stringify(extra) : '')); }
}

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// keeps asking until the order reaches one of the wanted statuses (events take a moment)
async function waitForOrder(orderId, token, wanted, seconds = 25) {
  for (let i = 0; i < seconds; i++) {
    const r = await call('/orders/' + orderId, { token });
    if (r.data && wanted.includes(r.data.status)) return r.data;
    await sleep(1000);
  }
  return (await call('/orders/' + orderId, { token })).data;
}

async function newUser(name, role) {
  const email = `${name.toLowerCase().replace(/\s/g, '')}.${run}@test.local`;
  const r = await call('/auth/register', { method: 'POST', body: { name, email, password: 'secret123', role } });
  return { ...r.data, email };
}

async function newSeller(name, store, commission) {
  const seller = await newUser(name, 'vendor');
  const v = await call('/vendors/onboard', { method: 'POST', token: seller.token, body: { storeName: store, description: 'test', kycDocs: [{ name: 'PAN' }] } });
  seller.vendorDocId = v.data._id;
  return { seller, commission };
}

async function waitForGateway() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(BASE + '/api/catalogue/categories'); if (r.ok) return true; } catch (e) { /* not up yet */ }
    await sleep(2000);
  }
  return false;
}

async function main() {
  console.log('\nTesting ' + BASE + '\n');
  if (!(await waitForGateway())) { console.log('Gateway is not reachable. Is docker compose running?'); process.exit(1); }

  // ---------- setup ----------
  console.log('Setup');
  let admin;
  for (let i = 0; i < 15; i++) { // the admin account is created a few seconds after start
    const r = await call('/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    if (r.status === 200) { admin = r.data; break; }
    await sleep(2000);
  }
  check('admin can log in', !!admin);
  if (!admin) return;

  const a = await newSeller('Seller A', 'Test Store A ' + run, 10);
  const b = await newSeller('Seller B', 'Test Store B ' + run, 20);
  for (const s of [a, b]) {
    const v = await call(`/admin/vendors/${s.seller.vendorDocId}/verify`, { method: 'PATCH', token: admin.token, body: { status: 'verified', commissionPct: s.commission } });
    check('admin verifies ' + v.data.storeName, v.status === 200 && v.data.status === 'verified', v.data);
  }

  const mk = async (s, title, price, stock) =>
    (await call('/catalogue/products', { method: 'POST', token: s.seller.token, body: { title, price, stock, category: 'Home' } })).data;
  const p1 = await mk(a, 'Test item A', 1000, 10);   // seller A, 10% commission
  const p2 = await mk(b, 'Test item B', 500, 5);     // seller B, 20% commission
  const last = await mk(b, 'Last piece', 200, 1);    // only 1 in stock, used for the race test
  check('products were created', !!(p1._id && p2._id && last._id));

  const cust = await newUser('Customer One', 'customer');
  const cust2 = await newUser('Customer Two', 'customer');

  // ---------- 1. happy path + idempotency ----------
  console.log('\n1. Order from two sellers');
  const key = 'key-' + run;
  const body = { items: [{ productId: p1._id, qty: 1 }, { productId: p2._id, qty: 1 }], address: '12 Test Street, Chandigarh', paymentMethod: 'card' };
  const o1 = await call('/orders', { method: 'POST', token: cust.token, body, headers: { 'Idempotency-Key': key } });
  const o1again = await call('/orders', { method: 'POST', token: cust.token, body, headers: { 'Idempotency-Key': key } });
  check('order is created', o1.status === 201, o1.data);
  check('order is split into 2 sub-orders', o1.data.subOrders && o1.data.subOrders.length === 2);
  check('total is 1500 (prices come from the server)', o1.data.totalAmount === 1500, o1.data.totalAmount);
  check('same Idempotency-Key returns the SAME order', o1again.data._id === o1.data._id, [o1.data._id, o1again.data._id]);
  const noKey = await call('/orders', { method: 'POST', token: cust.token, body });
  check('order without Idempotency-Key is rejected (400)', noKey.status === 400, noKey.status);

  const confirmed = await waitForOrder(o1.data._id, cust.token, ['confirmed']);
  check('saga finishes: order becomes confirmed', confirmed.status === 'confirmed', confirmed.status);
  check('sub-orders move to processing', confirmed.subOrders.every((s) => s.status === 'processing'));
  const stock = (await call('/catalogue/products')).data.find((p) => p._id === p1._id);
  check('stock was reduced from 10 to 9', stock && stock.stock === 9, stock && stock.stock);

  // ---------- 2. declined card ----------
  console.log('\n2. Declined card');
  const od = await call('/orders', { method: 'POST', token: cust.token, headers: { 'Idempotency-Key': 'decl-' + run },
    body: { ...body, items: [{ productId: p1._id, qty: 1 }], paymentMethod: 'test-fail' } });
  const failedOrder = await waitForOrder(od.data._id, cust.token, ['failed']);
  check('declined payment marks the order failed', failedOrder.status === 'failed', failedOrder.status);
  const stockAfter = (await call('/catalogue/products')).data.find((p) => p._id === p1._id);
  check('stock is NOT taken for a failed payment', stockAfter.stock === 9, stockAfter.stock);

  // ---------- 3. two people buy the last piece ----------
  console.log('\n3. Race for the last item (saga compensation)');
  const mkOrder = (c, k) => call('/orders', { method: 'POST', token: c.token, headers: { 'Idempotency-Key': k },
    body: { items: [{ productId: last._id, qty: 1 }], address: 'Somewhere 12345', paymentMethod: 'card' } });
  const [r1, r2] = await Promise.all([mkOrder(cust, 'race1-' + run), mkOrder(cust2, 'race2-' + run)]);
  const final = [
    await waitForOrder(r1.data._id, cust.token, ['confirmed', 'cancelled']),
    await waitForOrder(r2.data._id, cust2.token, ['confirmed', 'cancelled']),
  ];
  const wins = final.filter((o) => o.status === 'confirmed').length;
  const losses = final.filter((o) => o.status === 'cancelled').length;
  check('exactly one customer gets the last item', wins === 1, final.map((o) => o.status));
  check('the other order is cancelled (no overselling)', losses === 1, final.map((o) => o.status));
  const loser = final.find((o) => o.status === 'cancelled');
  if (loser) {
    const who = loser.customerId === cust.user.id ? cust : cust2;
    await sleep(2000);
    const alerts = (await call('/notifications', { token: who.token })).data || [];
    check('the losing customer is told about the refund', alerts.some((n) => n.type === 'payment.refunded'), alerts.map((n) => n.type));
  }

  // ---------- 4. fulfilment ----------
  console.log('\n4. Fulfilment and permissions');
  const status = (s, orderId, st) => call(`/orders/${orderId}/suborders/${s.seller.user.id}/status`, { method: 'PATCH', token: s.seller.token, body: { status: st } });
  const skip = await status(a, o1.data._id, 'delivered');
  check('cannot jump from processing straight to delivered (409)', skip.status === 409, skip.status);
  const wrongSeller = await call(`/orders/${o1.data._id}/suborders/${b.seller.user.id}/status`, { method: 'PATCH', token: a.seller.token, body: { status: 'shipped' } });
  check("a seller cannot change another seller's sub-order (403)", wrongSeller.status === 403, wrongSeller.status);
  check('seller A ships', (await status(a, o1.data._id, 'shipped')).status === 200);
  check('seller A delivers', (await status(a, o1.data._id, 'delivered')).status === 200);
  check('seller B ships', (await status(b, o1.data._id, 'shipped')).status === 200);
  check('seller B delivers', (await status(b, o1.data._id, 'delivered')).status === 200);

  check('customer cannot open the admin summary (403)', (await call('/payments/summary', { token: cust.token })).status === 403);
  check('no token means 401', (await call('/orders')).status === 401);
  check('customer cannot approve vendors (403)', (await call(`/admin/vendors/${a.seller.vendorDocId}/verify`, { method: 'PATCH', token: cust.token, body: { status: 'verified' } })).status === 403);

  // ---------- 5. payouts ----------
  console.log('\n5. Money');
  await sleep(1500);
  const earnA = (await call('/payouts/me', { token: a.seller.token })).data;
  check('seller A: 900 is ready for payout (1000 - 10% commission)', earnA.available === 900, earnA.available);
  const run1 = await call('/payouts/run', { method: 'POST', token: admin.token });
  check('payout run works', run1.status === 200, run1.data);
  const paidA = (await call('/payouts/me', { token: a.seller.token })).data;
  check('seller A is paid 900', paidA.paid === 900 && paidA.payouts[0] && paidA.payouts[0].netAmount === 900, paidA.paid);
  const paidB = (await call('/payouts/me', { token: b.seller.token })).data;
  check('seller B is paid 400 (500 - 20% commission)', paidB.paid === 400, paidB.paid);
  const run2 = await call('/payouts/run', { method: 'POST', token: admin.token });
  const after2 = (await call('/payouts/me', { token: a.seller.token })).data;
  check('running payouts twice does not pay twice', after2.payouts.length === 1 && after2.paid === 900, after2.payouts.length);

  // ---------- 6. return after payout ----------
  console.log('\n6. Return after payout');
  const ret = await call(`/orders/${o1.data._id}/suborders/${a.seller.user.id}/return`, { method: 'POST', token: cust.token });
  check('customer can return a delivered item', ret.status === 200, ret.data);
  await sleep(2000);
  const owes = (await call('/payouts/me', { token: a.seller.token })).data;
  check("the refund is taken from seller A's next payout (-900)", owes.available === -900, owes.available);
  await call('/payouts/run', { method: 'POST', token: admin.token });
  const stillOwes = (await call('/payouts/me', { token: a.seller.token })).data;
  check('a negative balance is carried forward, not paid out', stillOwes.available === -900 && stillOwes.payouts.length === 1, [stillOwes.available, stillOwes.payouts.length]);

  // tidy up, so the test products and stores do not stay in the real shop
  for (const [s, p] of [[a, p1], [b, p2], [b, last]]) {
    await call('/catalogue/products/' + p._id, { method: 'DELETE', token: s.seller.token });
  }
  for (const s of [a, b]) {
    await call(`/admin/vendors/${s.seller.vendorDocId}/verify`, { method: 'PATCH', token: admin.token, body: { status: 'suspended' } });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.log('Test crashed:', e.message); process.exit(1); });
