const express = require('express');
const mongoose = require('mongoose');
const lib = require('./lib');
const { wrap, HttpError, need, round2 } = lib;

const subOrderSchema = new mongoose.Schema({
  vendorId: String,
  vendorName: String,
  commissionPct: Number,
  items: [{ productId: String, title: String, price: Number, qty: Number }],
  amount: Number,
  status: {
    type: String,
    enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'returned'],
    default: 'pending',
  },
  trackingNo: String,
});

const orderSchema = new mongoose.Schema(
  {
    customerId: String,
    customerName: String,
    address: String,
    paymentMethod: String,
    subOrders: [subOrderSchema],
    totalAmount: Number,
    status: {
      type: String,
      enum: ['pending_payment', 'payment_received', 'confirmed', 'completed', 'failed', 'cancelled'],
      default: 'pending_payment',
    },
    failureReason: String,
    paymentId: String,
    idempotencyKey: String,
  },
  { timestamps: true }
);
// same customer + same key can only ever create one order
orderSchema.index({ customerId: 1, idempotencyKey: 1 }, { unique: true });
const Order = mongoose.model('Order', orderSchema);

const app = express();
app.use(express.json());
app.use(lib.requestLogger);
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- place an order ----------
app.post('/api/orders', need('customer'), wrap(async (req, res) => {
  const key = req.headers['idempotency-key'];
  if (!key) throw new HttpError(400, 'Idempotency-Key header is required');

  // if the customer double clicks or the network retries, we return the same order
  const existing = await Order.findOne({ customerId: req.user.id, idempotencyKey: key });
  if (existing) return res.status(200).json(existing);

  const { items, paymentMethod, address } = req.body;
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Your cart is empty');
  if (!address || address.trim().length < 5) throw new HttpError(400, 'Please enter a delivery address');

  // merge repeated products
  const merged = {};
  for (const it of items) {
    const qty = parseInt(it.qty, 10);
    if (!it.productId || !(qty > 0)) throw new HttpError(400, 'Invalid item in cart');
    merged[it.productId] = (merged[it.productId] || 0) + qty;
  }
  const cleanItems = Object.entries(merged).map(([productId, qty]) => ({ productId, qty }));

  // ask catalogue for the real prices
  let quote;
  try {
    const r = await fetch(process.env.CATALOGUE_URL + '/internal/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: cleanItems }),
    });
    quote = await r.json();
    if (!r.ok) throw new HttpError(r.status, quote.error);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, 'Catalogue is not reachable right now, please try again in a moment');
  }

  // split into one sub-order per vendor
  const byVendor = {};
  for (const line of quote.lines) {
    if (!byVendor[line.vendorId]) {
      byVendor[line.vendorId] = {
        vendorId: line.vendorId,
        vendorName: line.vendorName,
        commissionPct: line.commissionPct,
        items: [],
        amount: 0,
      };
    }
    const sub = byVendor[line.vendorId];
    sub.items.push({ productId: line.productId, title: line.title, price: line.price, qty: line.qty });
    sub.amount = round2(sub.amount + line.price * line.qty);
  }
  const subOrders = Object.values(byVendor);
  const totalAmount = round2(subOrders.reduce((sum, s) => sum + s.amount, 0));

  let order;
  try {
    order = await Order.create({
      customerId: req.user.id,
      customerName: req.user.name,
      address,
      paymentMethod: paymentMethod || 'card',
      subOrders,
      totalAmount,
      idempotencyKey: key,
    });
  } catch (e) {
    // two identical requests arrived at the same moment
    if (e.code === 11000) {
      return res.status(200).json(await Order.findOne({ customerId: req.user.id, idempotencyKey: key }));
    }
    throw e;
  }

  await lib.addEvent('order.created', {
    orderId: order._id.toString(),
    customerId: order.customerId,
    amount: totalAmount,
    method: order.paymentMethod,
    items: cleanItems,
    subOrders: subOrders.map((s) => ({
      vendorId: s.vendorId,
      vendorName: s.vendorName,
      commissionPct: s.commissionPct,
      amount: s.amount,
    })),
  }, req.cid);

  res.status(201).json(order);
}));

// ---------- reading orders ----------
app.get('/api/orders', need('customer'), wrap(async (req, res) => {
  res.json(await Order.find({ customerId: req.user.id }).sort({ createdAt: -1 }));
}));

app.get('/api/orders/admin/all', need('admin'), wrap(async (req, res) => {
  res.json(await Order.find().sort({ createdAt: -1 }).limit(100));
}));

// vendor sees only their own sub-order of each order
app.get('/api/orders/vendor/list', need('vendor'), wrap(async (req, res) => {
  const orders = await Order.find({ 'subOrders.vendorId': req.user.id, status: { $in: ['confirmed', 'completed'] } })
    .sort({ createdAt: -1 });
  res.json(orders.map((o) => ({
    orderId: o._id,
    customerName: o.customerName,
    address: o.address,
    createdAt: o.createdAt,
    subOrder: o.subOrders.find((s) => s.vendorId === req.user.id),
  })));
}));

app.get('/api/orders/:id', need(), wrap(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new HttpError(404, 'Order not found');
  const isOwner = order.customerId === req.user.id;
  if (!isOwner && req.user.role !== 'admin') throw new HttpError(403, 'Not your order');
  res.json(order);
}));

// ---------- vendor fulfilment ----------
const nextSteps = {
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
};

app.patch('/api/orders/:id/suborders/:vendorId/status', need('vendor'), wrap(async (req, res) => {
  if (req.params.vendorId !== req.user.id) throw new HttpError(403, 'That is not your sub-order');
  const { status, trackingNo } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) throw new HttpError(404, 'Order not found');
  const sub = order.subOrders.find((s) => s.vendorId === req.user.id);
  if (!sub) throw new HttpError(404, 'You have no items in this order');

  if (!(nextSteps[sub.status] || []).includes(status)) {
    throw new HttpError(409, `Cannot move from ${sub.status} to ${status}`);
  }
  sub.status = status;
  if (trackingNo) sub.trackingNo = trackingNo;

  // if everything is finished, mark the whole order complete
  const done = order.subOrders.every((s) => ['delivered', 'cancelled', 'returned'].includes(s.status));
  if (done && order.subOrders.some((s) => s.status === 'delivered')) order.status = 'completed';
  if (order.subOrders.every((s) => s.status === 'cancelled')) order.status = 'cancelled';
  await order.save();

  const base = { orderId: order._id.toString(), customerId: order.customerId, vendorId: sub.vendorId };
  if (status === 'shipped') await lib.addEvent('suborder.shipped', { ...base, trackingNo: sub.trackingNo }, req.cid);
  if (status === 'delivered') await lib.addEvent('suborder.delivered', base, req.cid);
  if (status === 'cancelled') {
    await lib.addEvent('suborder.cancelled', {
      ...base,
      amount: sub.amount,
      items: sub.items.map((i) => ({ productId: i.productId, qty: i.qty })),
    }, req.cid);
  }
  res.json(order);
}));

// ---------- returns ----------
app.post('/api/orders/:id/suborders/:vendorId/return', need('customer'), wrap(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, customerId: req.user.id });
  if (!order) throw new HttpError(404, 'Order not found');
  const sub = order.subOrders.find((s) => s.vendorId === req.params.vendorId);
  if (!sub) throw new HttpError(404, 'Sub-order not found');
  if (sub.status !== 'delivered') throw new HttpError(409, 'Only delivered items can be returned');
  sub.status = 'returned';
  await order.save();
  await lib.addEvent('suborder.returned', {
    orderId: order._id.toString(),
    customerId: order.customerId,
    vendorId: sub.vendorId,
    amount: sub.amount,
  }, req.cid);
  res.json(order);
}));

app.use(lib.errorHandler);

// ---------- saga: react to what payments and catalogue decided ----------
async function onEvent(evt) {
  const p = evt.payload;
  if (evt.type === 'payment.succeeded') {
    await Order.updateOne({ _id: p.orderId, status: 'pending_payment' },
      { status: 'payment_received', paymentId: p.paymentId });
  }
  if (evt.type === 'payment.failed') {
    await Order.updateOne({ _id: p.orderId, status: 'pending_payment' },
      { status: 'failed', failureReason: p.reason, 'subOrders.$[].status': 'cancelled' });
  }
  if (evt.type === 'stock.reserved') {
    await Order.updateOne({ _id: p.orderId, status: { $in: ['pending_payment', 'payment_received'] } },
      { status: 'confirmed', 'subOrders.$[].status': 'processing' });
  }
  if (evt.type === 'stock.failed') {
    // compensation happens in the payments service (refund); here we just close the order
    await Order.updateOne({ _id: p.orderId, status: { $in: ['pending_payment', 'payment_received'] } },
      { status: 'cancelled', failureReason: p.reason, 'subOrders.$[].status': 'cancelled' });
  }
}

async function start() {
  await lib.connectMongo(process.env.MONGO_URL);
  await Order.init();
  await lib.connectBroker(process.env.RABBIT_URL);
  await lib.subscribe('orders.events',
    ['payment.succeeded', 'payment.failed', 'stock.reserved', 'stock.failed'], onEvent);
  lib.startRelay();
  app.listen(process.env.PORT, () => lib.log(null, 'order service on', process.env.PORT));
}
start();
