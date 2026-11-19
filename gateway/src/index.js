// The only thing the browser talks to. It checks the login token,
// adds a correlation id and forwards the request to the right service.
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

const routes = [
  ['/api/auth', 'http://auth:4001'],
  ['/api/catalogue', 'http://catalogue:4002'],
  ['/api/vendors', 'http://catalogue:4002'],
  ['/api/admin/vendors', 'http://catalogue:4002'],
  ['/api/orders', 'http://orders:4003'],
  ['/api/payments', 'http://payments:4004'],
  ['/api/payouts', 'http://payments:4004'],
  ['/api/notifications', 'http://notifications:4005'],
];

// ---------- very small rate limiter (per ip, per minute) ----------
const hits = new Map();
setInterval(() => hits.clear(), 60 * 1000);
app.use('/api', (req, res, next) => {
  const count = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, count);
  if (count > 300) return res.status(429).json({ error: 'Too many requests, slow down a little' });
  next();
});

// ---------- correlation id + logging ----------
app.use('/api', (req, res, next) => {
  req.cid = req.headers['x-correlation-id'] || crypto.randomUUID();
  console.log(`[${new Date().toISOString()}] [gateway] [${req.cid}] ${req.method} ${req.originalUrl}`);
  next();
});

// ---------- login check ----------
const isPublic = (req) =>
  (req.method === 'POST' && ['/api/auth/login', '/api/auth/register'].includes(req.originalUrl)) ||
  (req.method === 'GET' && req.originalUrl.startsWith('/api/catalogue/') && !req.originalUrl.includes('my-products'));

app.use('/api', (req, res, next) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Your session expired, please log in again' });
    }
  }
  if (!req.user && !isPublic(req)) return res.status(401).json({ error: 'Please log in first' });
  next();
});

// ---------- forwarding ----------
function forward(target) {
  return async (req, res) => {
    // only these headers go through, so nobody can fake x-user-id from the browser
    const headers = { 'content-type': 'application/json', 'x-correlation-id': req.cid };
    if (req.headers['idempotency-key']) headers['idempotency-key'] = req.headers['idempotency-key'];
    if (req.user) {
      headers['x-user-id'] = req.user.id;
      headers['x-user-role'] = req.user.role;
      headers['x-user-name'] = encodeURIComponent(req.user.name || '');
    }
    try {
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const r = await fetch(target + req.originalUrl, {
        method: req.method,
        headers,
        body: hasBody ? JSON.stringify(req.body || {}) : undefined,
      });
      res.status(r.status).type('application/json').send(await r.text());
    } catch (e) {
      console.log(`[gateway] [${req.cid}] ${target} unreachable`);
      res.status(503).json({ error: 'That part of the shop is restarting, please try again in a few seconds' });
    }
  };
}

// ---------- system health (admin page uses this to show which services are up) ----------
const healthTargets = {
  auth: 'http://auth:4001', catalogue: 'http://catalogue:4002', orders: 'http://orders:4003',
  payments: 'http://payments:4004', notifications: 'http://notifications:4005',
};

app.get('/api/system/health', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const result = { gateway: 'up', services: {}, queues: [] };
  await Promise.all(Object.entries(healthTargets).map(async ([name, url]) => {
    try {
      const r = await fetch(url + '/health', { signal: AbortSignal.timeout(1500) });
      result.services[name] = r.ok ? 'up' : 'down';
    } catch (e) {
      result.services[name] = 'down';
    }
  }));
  // how many events are waiting in each queue (grows while a service is down)
  try {
    const r = await fetch('http://rabbitmq:15672/api/queues', {
      headers: { Authorization: 'Basic ' + Buffer.from('guest:guest').toString('base64') },
      signal: AbortSignal.timeout(1500),
    });
    const queues = await r.json();
    result.queues = queues.map((q) => ({ name: q.name, waiting: q.messages_ready || 0 }));
  } catch (e) { /* rabbit stats are optional */ }
  res.json(result);
});

for (const [prefix, target] of routes) app.use(prefix, forward(target));

app.use('/api', (req, res) => res.status(404).json({ error: 'No such endpoint' }));

// ---------- the website ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

// bad JSON from a client should be a clean 400, not an HTML error page
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.status === 400 ? 'That request was not valid JSON' : 'Something went wrong' });
});

app.listen(process.env.PORT || 8080, () => console.log('gateway on', process.env.PORT || 8080));
