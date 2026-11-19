const express = require('express');
const mongoose = require('mongoose');
const lib = require('./lib');
const { wrap, need } = lib;

const Notification = mongoose.model(
  'Notification',
  new mongoose.Schema(
    {
      userId: { type: String, index: true },
      type: String,
      message: String,
      read: { type: Boolean, default: false },
    },
    { timestamps: true }
  )
);

const app = express();
app.use(express.json());
app.use(lib.requestLogger);
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/notifications', need(), wrap(async (req, res) => {
  res.json(await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(30));
}));

app.post('/api/notifications/read-all', need(), wrap(async (req, res) => {
  await Notification.updateMany({ userId: req.user.id, read: false }, { read: true });
  res.json({ ok: true });
}));

app.use(lib.errorHandler);

// A real version would send an email through SendGrid here. For now we save it and print it.
async function notify(userId, type, message) {
  await Notification.create({ userId, type, message });
  lib.log(null, `EMAIL to ${userId}: ${message}`);
}

const shortId = (id) => String(id).slice(-6).toUpperCase();

async function onEvent(evt) {
  const p = evt.payload;
  switch (evt.type) {
    case 'user.registered':
      return notify(p.userId, evt.type, `Welcome to Haat, ${p.name}!`);
    case 'vendor.verified':
      return notify(p.userId, evt.type, p.status === 'verified'
        ? `Good news, ${p.storeName} is verified. You can start listing products.`
        : `${p.storeName} has been suspended. Please contact support.`);
    case 'payment.failed':
      return notify(p.customerId, evt.type, `Order #${shortId(p.orderId)} was not placed: ${p.reason}.`);
    case 'stock.failed':
      return notify(p.customerId, evt.type, `Order #${shortId(p.orderId)} was cancelled: ${p.reason}. Your money is being refunded.`);
    case 'stock.reserved':
      await notify(p.customerId, evt.type, `Order #${shortId(p.orderId)} is confirmed. Sellers are getting it ready.`);
      for (const v of p.vendorIds) await notify(v, evt.type, `New order #${shortId(p.orderId)} is waiting for you to ship.`);
      return;
    case 'suborder.shipped':
      return notify(p.customerId, evt.type, `Part of order #${shortId(p.orderId)} has shipped${p.trackingNo ? ' (tracking ' + p.trackingNo + ')' : ''}.`);
    case 'suborder.delivered':
      return notify(p.customerId, evt.type, `Part of order #${shortId(p.orderId)} was delivered.`);
    case 'payment.refunded':
      return notify(p.customerId, evt.type, `We refunded ₹${p.amount} for order #${shortId(p.orderId)}.`);
    case 'payout.completed':
      return notify(p.vendorId, evt.type, `A payout of ₹${p.netAmount} was sent to your account.`);
  }
}

async function start() {
  await lib.connectMongo(process.env.MONGO_URL);
  await lib.connectBroker(process.env.RABBIT_URL);
  await lib.subscribe('notifications.events', [
    'user.registered', 'vendor.verified', 'payment.failed', 'stock.failed', 'stock.reserved',
    'suborder.shipped', 'suborder.delivered', 'payment.refunded', 'payout.completed',
  ], onEvent);
  app.listen(process.env.PORT, () => lib.log(null, 'notification service on', process.env.PORT));
}
start();
