const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const lib = require('./lib');
const { wrap, HttpError, need } = lib;

const User = mongoose.model(
  'User',
  new mongoose.Schema(
    {
      name: String,
      email: { type: String, unique: true, lowercase: true, trim: true },
      passwordHash: String,
      role: { type: String, enum: ['customer', 'vendor', 'admin'], default: 'customer' },
    },
    { timestamps: true }
  )
);

function makeToken(user) {
  return jwt.sign(
    { id: user._id.toString(), role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

const publicUser = (u) => ({ id: u._id, name: u.name, email: u.email, role: u.role });

const app = express();
app.use(express.json());
app.use(lib.requestLogger);

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/register', wrap(async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) throw new HttpError(400, 'Name, email and password are required');
  if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  if (await User.findOne({ email: email.toLowerCase() })) {
    throw new HttpError(409, 'This email is already registered');
  }
  // people can only sign up as customer or vendor, admin is created at startup
  const safeRole = role === 'vendor' ? 'vendor' : 'customer';
  const user = await User.create({
    name,
    email,
    role: safeRole,
    passwordHash: await bcrypt.hash(password, 10),
  });
  await lib.addEvent('user.registered', { userId: user._id.toString(), name, email, role: safeRole }, req.cid);
  res.status(201).json({ token: makeToken(user), user: publicUser(user) });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  const user = email && (await User.findOne({ email: email.toLowerCase() }));
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
    throw new HttpError(401, 'Wrong email or password');
  }
  res.json({ token: makeToken(user), user: publicUser(user) });
}));

app.get('/api/auth/me', need(), wrap(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) throw new HttpError(404, 'User not found');
  res.json(publicUser(user));
}));

app.use(lib.errorHandler);

async function start() {
  await lib.connectMongo(process.env.MONGO_URL);
  // make sure there is always one admin account
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail && !(await User.findOne({ email: adminEmail }))) {
    await User.create({
      name: 'Platform Admin',
      email: adminEmail,
      role: 'admin',
      passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 10),
    });
    lib.log(null, 'admin account created');
  }
  await lib.connectBroker(process.env.RABBIT_URL);
  lib.startRelay();
  app.listen(process.env.PORT, () => lib.log(null, 'auth service on', process.env.PORT));
}
start();
