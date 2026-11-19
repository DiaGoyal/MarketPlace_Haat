// Small helper file that every service carries its own copy of.
// It has: logging, mongo/rabbit connection retry, the outbox relay and an idempotent consumer.
const amqp = require('amqplib');
const mongoose = require('mongoose');
const crypto = require('crypto');

const EXCHANGE = 'marketplace';
const SERVICE = process.env.SERVICE_NAME || 'service';

function log(cid, ...args) {
  console.log(`[${new Date().toISOString()}] [${SERVICE}] [${cid || '-'}]`, ...args);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- express helpers ----------
function requestLogger(req, res, next) {
  req.cid = req.headers['x-correlation-id'] || crypto.randomUUID();
  log(req.cid, req.method, req.originalUrl);
  next();
}

// The gateway checks the JWT and passes the user in these headers.
// Services are not exposed to the internet, so they can trust them.
function currentUser(req) {
  if (!req.headers['x-user-id']) return null;
  return {
    id: req.headers['x-user-id'],
    role: req.headers['x-user-role'],
    name: decodeURIComponent(req.headers['x-user-name'] || ''),
  };
}

function need(...roles) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in first' });
    if (roles.length && !roles.includes(user.role)) {
      return res.status(403).json({ error: 'You do not have access to this' });
    }
    req.user = user;
    next();
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, req, res, next) {
  log(req.cid, 'ERROR', err.message);
  const status = err.status || 500;
  res.status(status).json({ error: err.status ? err.message : 'Something went wrong on our side' });
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---------- connections ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectMongo(url) {
  for (let i = 1; i <= 30; i++) {
    try {
      await mongoose.connect(url);
      log(null, 'mongo connected');
      return;
    } catch (e) {
      log(null, `mongo not ready (try ${i}), waiting...`);
      await sleep(2000);
    }
  }
  throw new Error('could not connect to mongo');
}

// ---------- outbox ----------
// Events are first saved in our own database and then pushed to RabbitMQ by a small loop.
// So if RabbitMQ is down the event is not lost, it just waits in the outbox.
const Outbox = mongoose.model(
  'OutboxEvent',
  new mongoose.Schema(
    {
      eventId: { type: String, unique: true },
      type: String,
      payload: Object,
      correlationId: String,
      publishedAt: Date,
      attempts: { type: Number, default: 0 },
    },
    { timestamps: true }
  )
);

// remembers which events this service already handled (so replays are harmless)
const Processed = mongoose.model(
  'ProcessedEvent',
  new mongoose.Schema({ eventId: { type: String, unique: true } }, { timestamps: true })
);

let channel = null;
let rabbitUrl = null;

async function connectBroker(url, tries = 30) {
  rabbitUrl = url;
  for (let i = 1; i <= tries; i++) {
    try {
      const conn = await amqp.connect(url);
      conn.on('close', () => {
        log(null, 'rabbit connection closed, will reconnect');
        channel = null;
        // keep trying for as long as it takes, a broker restart must never leave a service deaf
        setTimeout(() => connectBroker(rabbitUrl, Infinity).then(resubscribe).catch(() => {}), 3000);
      });
      conn.on('error', () => {});
      channel = await conn.createChannel();
      await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
      log(null, 'rabbit connected');
      return;
    } catch (e) {
      log(null, `rabbit not ready (try ${i}), waiting...`);
      await sleep(2000);
    }
  }
  throw new Error('could not connect to rabbit');
}

async function addEvent(type, payload, correlationId) {
  return Outbox.create({ eventId: crypto.randomUUID(), type, payload, correlationId });
}

function startRelay() {
  setInterval(async () => {
    if (!channel) return;
    try {
      const pending = await Outbox.find({ publishedAt: null }).sort({ createdAt: 1 }).limit(50);
      for (const evt of pending) {
        try {
          const msg = { eventId: evt.eventId, type: evt.type, payload: evt.payload, correlationId: evt.correlationId };
          channel.publish(EXCHANGE, evt.type, Buffer.from(JSON.stringify(msg)), { persistent: true });
          evt.publishedAt = new Date();
        } catch (e) {
          evt.attempts += 1;
        }
        await evt.save();
      }
    } catch (e) {
      log(null, 'relay error', e.message);
    }
  }, 1000);
}

// ---------- consumer ----------
const subscriptions = [];
const failures = new Map(); // how many times each event failed

async function subscribe(queue, keys, handler) {
  subscriptions.push({ queue, keys, handler });
  await bindQueue(queue, keys, handler);
}

async function resubscribe() {
  for (const s of subscriptions) await bindQueue(s.queue, s.keys, s.handler);
}

async function bindQueue(queue, keys, handler) {
  await channel.assertQueue(queue, { durable: true });
  for (const k of keys) await channel.bindQueue(queue, EXCHANGE, k);
  const ch = channel;
  ch.prefetch(5);
  ch.consume(queue, async (raw) => {
    if (!raw) return;
    const evt = JSON.parse(raw.content.toString());
    try {
      // claim the event first; a duplicate key means we already did it
      await Processed.create({ eventId: evt.eventId });
    } catch (e) {
      if (e.code === 11000) {
        log(evt.correlationId, 'duplicate event skipped', evt.type);
        return ch.ack(raw);
      }
      return ch.nack(raw, false, true);
    }
    try {
      log(evt.correlationId, 'handling', evt.type);
      await handler(evt);
      ch.ack(raw);
    } catch (err) {
      const tries = (failures.get(evt.eventId) || 0) + 1;
      failures.set(evt.eventId, tries);
      if (tries >= 10) {
        // a broken event must not block the queue forever
        log(evt.correlationId, 'giving up on', evt.type, err.message);
        failures.delete(evt.eventId);
        return ch.ack(raw);
      }
      log(evt.correlationId, `handler failed (try ${tries}), will retry:`, err.message);
      await Processed.deleteOne({ eventId: evt.eventId });
      setTimeout(() => { try { ch.nack(raw, false, true); } catch (e) {} }, 3000);
    }
  });
}

module.exports = {
  log, HttpError, requestLogger, currentUser, need, wrap, errorHandler, round2,
  connectMongo, connectBroker, addEvent, startRelay, subscribe,
};
