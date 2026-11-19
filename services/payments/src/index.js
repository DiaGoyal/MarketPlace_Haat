const express = require('express');
const mongoose = require('mongoose');
const lib = require('./lib');
const { wrap, HttpError, need, round2 } = lib;

// ---------- models ----------
const Payment = mongoose.model(
  'Payment',
  new mongoose.Schema(
    {
      orderId: { type: String, unique: true },
      customerId: String,
      amount: Number,
      method: String,
      status: { type: String, enum: ['succeeded', 'failed', 'refunded', 'partially_refunded'] },
      refundedAmount: { type: Number, default: 0 },
      providerRef: String,
      failureReason: String,
      eventEmitted: { type: Boolean, default: false }, // true once payment.succeeded / failed was queued
    },
    { timestamps: true }
  )
);

// Every rupee that belongs to a vendor is written here.
// held = money is with the platform (escrow), available = can be paid out, paid = already transferred
const Ledger = mongoose.model(
  'LedgerEntry',
  new mongoose.Schema(
    {
      vendorId: { type: String, index: true },
      vendorName: String,
      orderId: String,
      type: { type: String, enum: ['sale', 'refund'] },
      gross: Number,
      commission: Number,
      net: Number, // negative for refunds
      status: { type: String, enum: ['held', 'available', 'paid', 'void'], index: true },
      payoutId: String,
    },
    { timestamps: true }
  )
);

const Payout = mongoose.model(
  'Payout',
  new mongoose.Schema(
    {
      vendorId: String,
      vendorName: String,
      periodStart: Date,
      periodEnd: Date,
      grossAmount: Number,
      commission: Number,
      refunds: Number,
      netAmount: Number,
      status: { type: String, default: 'pending' },
      transferId: String,
    },
    { timestamps: true }
  )
);

const app = express();
app.use(express.json());
app.use(lib.requestLogger);
app.get('/health', (req, res) => res.json({ ok: true }));

// Sales per day for the last 7 days (used by the charts). Days with no sales come back as 0.
async function lastSevenDays(match, field) {
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6));
  const rows = await Ledger.aggregate([
    { $match: { ...match, createdAt: { $gte: since } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: '$' + field }, count: { $sum: 1 } } },
  ]);
  const byDay = Object.fromEntries(rows.map((r) => [r._id, r]));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(since.getTime() + i * 86400000).toISOString().slice(0, 10);
    days.push({ day, amount: round2(byDay[day] ? byDay[day].total : 0), orders: byDay[day] ? byDay[day].count : 0 });
  }
  return days;
}

// ---------- vendor earnings ----------
app.get('/api/payouts/me', need('vendor'), wrap(async (req, res) => {
  const sum = async (status) => {
    const rows = await Ledger.aggregate([
      { $match: { vendorId: req.user.id, status } },
      { $group: { _id: null, total: { $sum: '$net' } } },
    ]);
    return round2(rows[0] ? rows[0].total : 0);
  };
  res.json({
    held: await sum('held'),
    available: await sum('available'),
    paid: await sum('paid'),
    payouts: await Payout.find({ vendorId: req.user.id }).sort({ createdAt: -1 }).limit(20),
    daily: await lastSevenDays({ vendorId: req.user.id, type: 'sale', status: { $ne: 'void' } }, 'net'),
  });
}));

// ---------- admin: payouts and platform numbers ----------
app.get('/api/payouts', need('admin'), wrap(async (req, res) => {
  res.json(await Payout.find().sort({ createdAt: -1 }).limit(100));
}));

app.get('/api/payments/summary', need('admin'), wrap(async (req, res) => {
  const sales = await Ledger.aggregate([
    { $match: { type: 'sale', status: { $ne: 'void' } } },
    { $group: { _id: null, gross: { $sum: '$gross' }, commission: { $sum: '$commission' } } },
  ]);
  const refunds = await Ledger.aggregate([
    { $match: { type: 'refund' } },
    { $group: { _id: null, gross: { $sum: '$gross' }, commission: { $sum: '$commission' } } },
  ]);
  const gross = sales[0] ? sales[0].gross : 0;
  const commission = sales[0] ? sales[0].commission : 0;
  const refundGross = refunds[0] ? Math.abs(refunds[0].gross) : 0;
  const refundCommission = refunds[0] ? Math.abs(refunds[0].commission) : 0;
  res.json({
    orders: await Payment.countDocuments({ status: { $in: ['succeeded', 'partially_refunded'] } }),
    grossSales: round2(gross),
    refunds: round2(refundGross),
    platformCommission: round2(commission - refundCommission),
    held: round2((await Ledger.aggregate([{ $match: { status: 'held' } }, { $group: { _id: null, t: { $sum: '$net' } } }]))[0]?.t || 0),
  });
}));

app.get('/api/payments/daily', need('admin'), wrap(async (req, res) => {
  res.json(await lastSevenDays({ type: 'sale', status: { $ne: 'void' } }, 'gross'));
}));

// Settlement job. Groups every "available" ledger row per vendor and pays the net amount.
// Safe to press twice: rows are claimed with status filter, so nothing is paid two times.
app.post('/api/payouts/run', need('admin'), wrap(async (req, res) => {
  const entries = await Ledger.find({ status: 'available' });
  const byVendor = {};
  for (const e of entries) (byVendor[e.vendorId] = byVendor[e.vendorId] || []).push(e);

  const created = [];
  const carried = [];
  for (const [vendorId, rows] of Object.entries(byVendor)) {
    const net = round2(rows.reduce((s, r) => s + r.net, 0));
    if (net <= 0) {
      // refunds are bigger than sales, so we carry the debt into the next run
      carried.push({ vendorId, net });
      continue;
    }
    const sales = rows.filter((r) => r.type === 'sale');
    const refundRows = rows.filter((r) => r.type === 'refund');
    const grossAmount = round2(sales.reduce((s, r) => s + r.gross, 0));
    const commission = round2(
      sales.reduce((s, r) => s + r.commission, 0) - refundRows.reduce((s, r) => s + Math.abs(r.commission), 0));
    const refunds = round2(refundRows.reduce((s, r) => s + Math.abs(r.gross), 0));

    const payout = await Payout.create({
      vendorId,
      vendorName: rows[0].vendorName,
      periodStart: rows.reduce((d, r) => (r.createdAt < d ? r.createdAt : d), rows[0].createdAt),
      periodEnd: new Date(),
      grossAmount, commission, refunds, netAmount: net,
    });

    const ids = rows.map((r) => r._id);
    const claim = await Ledger.updateMany({ _id: { $in: ids }, status: 'available' },
      { status: 'paid', payoutId: payout._id.toString() });
    if (claim.modifiedCount !== ids.length) {
      // someone else touched these rows, undo and skip
      await Ledger.updateMany({ payoutId: payout._id.toString() }, { status: 'available', payoutId: null });
      await Payout.deleteOne({ _id: payout._id });
      continue;
    }

    // this is where Stripe Connect / Razorpay Route transfer would be called
    payout.transferId = 'tr_demo_' + payout._id.toString().slice(-8);
    payout.status = 'paid';
    await payout.save();
    await lib.addEvent('payout.completed',
      { vendorId, payoutId: payout._id.toString(), netAmount: net }, req.cid);
    created.push(payout);
  }
  res.json({ paidOut: created.length, carriedForward: carried.length, payouts: created });
}));

app.use(lib.errorHandler);

// ---------- event handlers ----------
async function onOrderCreated(evt) {
  const p = evt.payload;
  const cid = evt.correlationId;

  // Every step below can be repeated safely. If this handler crashed halfway before,
  // the replay continues where it stopped instead of leaving the order stuck.
  let payment = await Payment.findOne({ orderId: p.orderId });
  if (!payment) {
    // pretend card capture. Paying with the "test-fail" method is declined on purpose for the demo.
    const declined = p.method === 'test-fail';
    try {
      payment = await Payment.create({
        orderId: p.orderId, customerId: p.customerId, amount: p.amount, method: p.method,
        status: declined ? 'failed' : 'succeeded',
        failureReason: declined ? 'Card was declined' : undefined,
        providerRef: declined ? undefined : 'ch_demo_' + Date.now(),
      });
    } catch (e) {
      if (e.code !== 11000) throw e;
      payment = await Payment.findOne({ orderId: p.orderId });
    }
  }
  if (payment.eventEmitted) return; // already finished

  if (payment.status === 'failed') {
    await lib.addEvent('payment.failed',
      { orderId: p.orderId, customerId: p.customerId, reason: 'Your card was declined' }, cid);
  } else if (payment.status === 'succeeded') {
    // split the money: platform commission and vendor share, held until delivery
    for (const sub of p.subOrders) {
      if (await Ledger.findOne({ orderId: p.orderId, vendorId: sub.vendorId, type: 'sale' })) continue;
      const commission = round2((sub.amount * sub.commissionPct) / 100);
      await Ledger.create({
        vendorId: sub.vendorId, vendorName: sub.vendorName, orderId: p.orderId, type: 'sale',
        gross: sub.amount, commission, net: round2(sub.amount - commission), status: 'held',
      });
    }
    await lib.addEvent('payment.succeeded', {
      orderId: p.orderId,
      paymentId: payment._id.toString(),
      customerId: p.customerId,
      amount: p.amount,
      items: p.items,
      vendorIds: p.subOrders.map((s) => s.vendorId),
    }, cid);
  } else {
    return; // already refunded
  }
  await Payment.updateOne({ _id: payment._id }, { eventEmitted: true });
}

// Compensating action of the saga: stock ran out after we took the money, so we give it back.
async function onStockFailed(evt) {
  const { orderId, customerId, reason } = evt.payload;
  const payment = await Payment.findOne({ orderId });
  if (!payment || payment.status === 'refunded') return;
  payment.status = 'refunded';
  payment.refundedAmount = payment.amount;
  await payment.save();
  await Ledger.updateMany({ orderId, type: 'sale', status: 'held' }, { status: 'void' });
  await lib.addEvent('payment.refunded',
    { orderId, customerId, amount: payment.amount, reason }, evt.correlationId);
}

async function onDelivered(evt) {
  // delivery done -> the vendor's money is released from escrow
  await Ledger.updateOne(
    { orderId: evt.payload.orderId, vendorId: evt.payload.vendorId, type: 'sale', status: 'held' },
    { status: 'available' });
}

async function onCancelled(evt) {
  const { orderId, vendorId, customerId, amount } = evt.payload;
  const voided = await Ledger.updateOne({ orderId, vendorId, type: 'sale', status: 'held' }, { status: 'void' });
  if (voided.modifiedCount === 0) return;
  await Payment.updateOne({ orderId },
    { $inc: { refundedAmount: amount }, status: 'partially_refunded' });
  await lib.addEvent('payment.refunded',
    { orderId, customerId, amount, reason: 'The seller cancelled part of your order' }, evt.correlationId);
}

async function onReturned(evt) {
  const { orderId, vendorId, customerId, amount } = evt.payload;
  if (await Ledger.findOne({ orderId, vendorId, type: 'refund' })) return; // replay
  const sale = await Ledger.findOne({ orderId, vendorId, type: 'sale' });
  if (!sale) return;
  // negative entry; it will be subtracted from the vendor's next payout
  await Ledger.create({
    vendorId, vendorName: sale.vendorName, orderId, type: 'refund',
    gross: -amount, commission: -sale.commission, net: -sale.net, status: 'available',
  });
  await Payment.updateOne({ orderId }, { $inc: { refundedAmount: amount }, status: 'partially_refunded' });
  await lib.addEvent('payment.refunded',
    { orderId, customerId, amount, reason: 'Your return was accepted' }, evt.correlationId);
}

async function onEvent(evt) {
  if (evt.type === 'order.created') return onOrderCreated(evt);
  if (evt.type === 'stock.failed') return onStockFailed(evt);
  if (evt.type === 'suborder.delivered') return onDelivered(evt);
  if (evt.type === 'suborder.cancelled') return onCancelled(evt);
  if (evt.type === 'suborder.returned') return onReturned(evt);
}

async function start() {
  await lib.connectMongo(process.env.MONGO_URL);
  await Payment.init();
  await lib.connectBroker(process.env.RABBIT_URL);
  await lib.subscribe('payments.events',
    ['order.created', 'stock.failed', 'suborder.delivered', 'suborder.cancelled', 'suborder.returned'], onEvent);
  lib.startRelay();
  app.listen(process.env.PORT, () => lib.log(null, 'payment service on', process.env.PORT));
}
start();
