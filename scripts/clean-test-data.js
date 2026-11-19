// Removes everything the automated test left behind (stores, products, orders, money rows, test accounts).
// Run from the project folder, with the site running:
//   docker compose exec -T mongo mongosh --quiet < scripts\clean-test-data.js
// Real stores and real users are not touched: only names starting with "Test Store" and emails ending in @test.local.

const t = /^Test Store/;
const auth = db.getSiblingDB('auth_db');
const orders = db.getSiblingDB('orders_db');
const payments = db.getSiblingDB('payments_db');
const catalogue = db.getSiblingDB('catalogue_db');

// .toArray() matters: in mongosh a cursor is not a plain list
const users = auth.users.find({ email: /@test\.local$/ }).toArray().map((u) => u._id.toString());
const orderIds = orders.orders.find({ $or: [{ customerId: { $in: users } }, { 'subOrders.vendorName': t }] })
  .toArray().map((o) => o._id.toString())
  .concat(payments.ledgerentries.distinct('orderId', { vendorName: t }));

payments.payments.deleteMany({ $or: [{ orderId: { $in: orderIds } }, { customerId: { $in: users } }] });
payments.ledgerentries.deleteMany({ $or: [{ vendorName: t }, { orderId: { $in: orderIds } }] });
payments.payouts.deleteMany({ vendorName: t });
orders.orders.deleteMany({ $or: [{ customerId: { $in: users } }, { 'subOrders.vendorName': t }] });
catalogue.reservations.deleteMany({ orderId: { $in: orderIds } });
catalogue.vendors.deleteMany({ storeName: t });
catalogue.products.deleteMany({ storeName: t });
auth.users.deleteMany({ email: /@test\.local$/ });

print('done');
