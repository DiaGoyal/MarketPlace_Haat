const express = require('express');
const mongoose = require('mongoose');
const lib = require('./lib');
const { wrap, HttpError, need, round2 } = lib;

// ---------- models ----------
const Vendor = mongoose.model(
  'Vendor',
  new mongoose.Schema(
    {
      userId: { type: String, unique: true },
      storeName: String,
      slug: { type: String, unique: true },
      description: String,
      kycDocs: [{ name: String, url: String }],
      status: { type: String, enum: ['pending', 'verified', 'suspended'], default: 'pending' },
      commissionPct: { type: Number, default: 10 },
      payoutAccountId: String,
    },
    { timestamps: true }
  )
);

const Product = mongoose.model(
  'Product',
  new mongoose.Schema(
    {
      vendorId: { type: String, index: true }, // same as the vendor's userId
      storeName: String,
      title: String,
      description: String,
      category: String,
      price: Number,
      stock: Number,
      imageUrl: String,
      status: { type: String, enum: ['active', 'hidden'], default: 'active' },
    },
    { timestamps: true }
  )
);

// one record per order, so stock is never taken twice for the same order
const Reservation = mongoose.model(
  'Reservation',
  new mongoose.Schema({
    orderId: { type: String, unique: true },
    items: [{ productId: String, qty: Number }],
  })
);

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const app = express();
app.use(express.json());
app.use(lib.requestLogger);
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- vendors ----------
app.post('/api/vendors/onboard', need('vendor'), wrap(async (req, res) => {
  const { storeName, description, kycDocs, payoutAccountId } = req.body;
  if (!storeName) throw new HttpError(400, 'Store name is required');
  if (await Vendor.findOne({ userId: req.user.id })) throw new HttpError(409, 'You already applied');

  let slug = slugify(storeName);
  if (await Vendor.findOne({ slug })) slug = slug + '-' + Math.floor(Math.random() * 1000);

  const vendor = await Vendor.create({
    userId: req.user.id,
    storeName,
    slug,
    description,
    kycDocs: (kycDocs || []).map((d) => ({ name: d.name, url: d.url || '' })),
    payoutAccountId: payoutAccountId || 'acct_demo_' + req.user.id.slice(-6),
  });
  await lib.addEvent('vendor.onboarded', { userId: req.user.id, storeName }, req.cid);
  res.status(201).json(vendor);
}));

app.get('/api/vendors/me', need('vendor'), wrap(async (req, res) => {
  res.json(await Vendor.findOne({ userId: req.user.id }));
}));

app.get('/api/admin/vendors', need('admin'), wrap(async (req, res) => {
  const filter = req.query.status ? { status: req.query.status } : {};
  res.json(await Vendor.find(filter).sort({ createdAt: -1 }));
}));

app.patch('/api/admin/vendors/:id/verify', need('admin'), wrap(async (req, res) => {
  const { status, commissionPct } = req.body;
  if (!['verified', 'suspended'].includes(status)) throw new HttpError(400, 'Status must be verified or suspended');
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) throw new HttpError(404, 'Vendor not found');
  vendor.status = status;
  if (commissionPct !== undefined && commissionPct !== '') {
    const pct = Number(commissionPct);
    if (isNaN(pct) || pct < 0 || pct > 50) throw new HttpError(400, 'Commission must be between 0 and 50');
    vendor.commissionPct = pct;
  }
  await vendor.save();
  // hide products of suspended stores
  if (status === 'suspended') await Product.updateMany({ vendorId: vendor.userId }, { status: 'hidden' });
  await lib.addEvent('vendor.verified', { userId: vendor.userId, status, storeName: vendor.storeName }, req.cid);
  res.json(vendor);
}));

// Removing a store is only allowed after it was suspended, so a live shop is never deleted by one wrong click.
// Old orders and payout history stay, they keep the store name.
app.delete('/api/admin/vendors/:id', need('admin'), wrap(async (req, res) => {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) throw new HttpError(404, 'Vendor not found');
  if (vendor.status !== 'suspended') throw new HttpError(409, 'Suspend the store first, then delete it');
  await Product.deleteMany({ vendorId: vendor.userId });
  await vendor.deleteOne();
  res.json({ ok: true });
}));

// ---------- products ----------
app.get('/api/catalogue/products', wrap(async (req, res) => {
  // only show products of verified stores
  const verified = await Vendor.find({ status: 'verified' }).select('userId');
  const filter = { status: 'active', stock: { $gt: 0 }, vendorId: { $in: verified.map((v) => v.userId) } };
  if (req.query.category) filter.category = req.query.category;
  const verifiedIds = verified.map((v) => v.userId);
  // asking for a suspended store must not leak its products
  if (req.query.vendor) filter.vendorId = verifiedIds.includes(req.query.vendor) ? req.query.vendor : '__none__';
  if (req.query.q) {
    const safe = String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    filter.$or = [{ title: rx }, { description: rx }, { storeName: rx }, { category: rx }];
  }
  res.json(await Product.find(filter).sort({ createdAt: -1 }).limit(100));
}));

app.get('/api/catalogue/categories', wrap(async (req, res) => {
  const verified = await Vendor.find({ status: 'verified' }).select('userId');
  res.json(await Product.distinct('category', {
    status: 'active', stock: { $gt: 0 }, vendorId: { $in: verified.map((v) => v.userId) },
  }));
}));

app.get('/api/catalogue/my-products', need('vendor'), wrap(async (req, res) => {
  res.json(await Product.find({ vendorId: req.user.id }).sort({ createdAt: -1 }));
}));

async function verifiedVendorFor(userId) {
  const vendor = await Vendor.findOne({ userId });
  if (!vendor || vendor.status !== 'verified') {
    throw new HttpError(403, 'Your store has to be verified by the admin before you can sell');
  }
  return vendor;
}

app.post('/api/catalogue/products', need('vendor'), wrap(async (req, res) => {
  const vendor = await verifiedVendorFor(req.user.id);
  const { title, description, category, price, stock, imageUrl } = req.body;
  if (!title || !(Number(price) > 0)) throw new HttpError(400, 'Title and a price above 0 are required');
  const product = await Product.create({
    vendorId: req.user.id,
    storeName: vendor.storeName,
    title,
    description,
    category: category || 'General',
    price: round2(Number(price)),
    stock: Math.max(0, parseInt(stock, 10) || 0),
    imageUrl,
  });
  res.status(201).json(product);
}));

app.put('/api/catalogue/products/:id', need('vendor'), wrap(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, vendorId: req.user.id });
  if (!product) throw new HttpError(404, 'Product not found');
  const { title, description, category, price, stock, imageUrl, status } = req.body;
  if (title !== undefined) product.title = title;
  if (description !== undefined) product.description = description;
  if (category !== undefined) product.category = category;
  if (price !== undefined) {
    if (!(Number(price) > 0)) throw new HttpError(400, 'Price must be above 0');
    product.price = round2(Number(price));
  }
  if (stock !== undefined) {
    const n = parseInt(stock, 10);
    if (isNaN(n) || n < 0) throw new HttpError(400, 'Stock must be 0 or more');
    product.stock = n;
  }
  if (imageUrl !== undefined) product.imageUrl = imageUrl;
  if (status && ['active', 'hidden'].includes(status)) product.status = status;
  await product.save();
  res.json(product);
}));

app.delete('/api/catalogue/products/:id', need('vendor'), wrap(async (req, res) => {
  // we hide instead of deleting so old orders still make sense
  const product = await Product.findOneAndUpdate(
    { _id: req.params.id, vendorId: req.user.id }, { status: 'hidden' }, { new: true });
  if (!product) throw new HttpError(404, 'Product not found');
  res.json(product);
}));

// ---------- internal (only reachable inside the docker network, gateway does not proxy it) ----------
// The order service calls this to get real prices, so the client can never send its own price.
app.post('/internal/quote', wrap(async (req, res) => {
  const lines = [];
  for (const item of req.body.items || []) {
    const product = await Product.findById(item.productId);
    if (!product || product.status !== 'active') throw new HttpError(404, 'A product in your cart is no longer available');
    const vendor = await Vendor.findOne({ userId: product.vendorId });
    if (!vendor || vendor.status !== 'verified') throw new HttpError(409, `${product.title} is not available right now`);
    if (product.stock < item.qty) throw new HttpError(409, `Only ${product.stock} left of ${product.title}`);
    lines.push({
      productId: product._id.toString(),
      title: product.title,
      price: product.price,
      qty: item.qty,
      vendorId: vendor.userId,
      vendorName: vendor.storeName,
      commissionPct: vendor.commissionPct,
    });
  }
  res.json({ lines });
}));

app.use(lib.errorHandler);

// ---------- event handlers ----------
// Saga step: payment went through, now try to take stock for the whole order.
async function onPaymentSucceeded(evt) {
  const { orderId, customerId, items, vendorIds } = evt.payload;
  const cid = evt.correlationId;

  if (await Reservation.findOne({ orderId })) {
    // we already did this one (replay), just make sure the answer event exists
    return lib.addEvent('stock.reserved', { orderId, customerId, vendorIds }, cid);
  }

  const taken = [];
  let failedTitle = null;
  for (const item of items) {
    const result = await Product.findOneAndUpdate(
      { _id: item.productId, stock: { $gte: item.qty } },
      { $inc: { stock: -item.qty } }
    );
    if (!result) {
      const p = await Product.findById(item.productId);
      failedTitle = p ? p.title : 'an item';
      break;
    }
    taken.push(item);
  }

  if (failedTitle) {
    // put back what we already took, then tell everyone it failed
    for (const item of taken) await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.qty } });
    return lib.addEvent('stock.failed', { orderId, customerId, reason: `${failedTitle} just went out of stock` }, cid);
  }

  try {
    await Reservation.create({ orderId, items });
  } catch (e) {
    if (e.code !== 11000) throw e;
  }
  await lib.addEvent('stock.reserved', { orderId, customerId, vendorIds }, cid);
}

// A vendor cancelled their part of an order, so we give the stock back.
async function onSubOrderCancelled(evt) {
  for (const item of evt.payload.items) {
    await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.qty } });
  }
}

async function start() {
  await lib.connectMongo(process.env.MONGO_URL);
  await lib.connectBroker(process.env.RABBIT_URL);
  await lib.subscribe('catalogue.events', ['payment.succeeded', 'suborder.cancelled'], async (evt) => {
    if (evt.type === 'payment.succeeded') return onPaymentSucceeded(evt);
    if (evt.type === 'suborder.cancelled') return onSubOrderCancelled(evt);
  });
  lib.startRelay();
  app.listen(process.env.PORT, () => lib.log(null, 'catalogue service on', process.env.PORT));
}
start();
