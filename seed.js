const mongoose = require('mongoose');
require('dotenv').config();

const Category = require('./models/Category');
const Product = require('./models/Product');

const categories = [
  { name: 'Beverages', icon: '🥤', color: '#3b82f6' },
  { name: 'Food', icon: '🍔', color: '#f59e0b' },
  { name: 'Electronics', icon: '💻', color: '#8b5cf6' },
  { name: 'Clothing', icon: '👕', color: '#ec4899' },
  { name: 'Health & Beauty', icon: '💊', color: '#10b981' },
  { name: 'Stationery', icon: '✏️', color: '#6366f1' }
];

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  await Category.deleteMany({});
  await Product.deleteMany({});

  const savedCats = await Category.insertMany(categories);
  console.log(`Seeded ${savedCats.length} categories`);

  const catMap = {};
  savedCats.forEach(c => { catMap[c.name] = c._id; });

  const products = [
    { name: 'Coca-Cola 330ml', sku: 'BEV001', category: catMap['Beverages'], price: 1.99, costPrice: 0.80, stock: 150, lowStockThreshold: 20, unit: 'can', taxRate: 5 },
    { name: 'Pepsi 330ml', sku: 'BEV002', category: catMap['Beverages'], price: 1.99, costPrice: 0.80, stock: 120, lowStockThreshold: 20, unit: 'can', taxRate: 5 },
    { name: 'Water 500ml', sku: 'BEV003', category: catMap['Beverages'], price: 0.99, costPrice: 0.30, stock: 200, lowStockThreshold: 30, unit: 'bottle', taxRate: 0 },
    { name: 'Orange Juice 1L', sku: 'BEV004', category: catMap['Beverages'], price: 3.49, costPrice: 1.50, stock: 80, lowStockThreshold: 15, unit: 'bottle', taxRate: 5 },
    { name: 'Red Bull 250ml', sku: 'BEV005', category: catMap['Beverages'], price: 2.99, costPrice: 1.20, stock: 8, lowStockThreshold: 20, unit: 'can', taxRate: 5 },
    { name: 'Sandwich - BLT', sku: 'FOOD001', category: catMap['Food'], price: 5.99, costPrice: 2.50, stock: 30, lowStockThreshold: 5, unit: 'pcs', taxRate: 8 },
    { name: 'Chips - Classic', sku: 'FOOD002', category: catMap['Food'], price: 1.49, costPrice: 0.60, stock: 100, lowStockThreshold: 15, unit: 'bag', taxRate: 8 },
    { name: 'Chocolate Bar', sku: 'FOOD003', category: catMap['Food'], price: 1.99, costPrice: 0.75, stock: 5, lowStockThreshold: 20, unit: 'pcs', taxRate: 8 },
    { name: 'USB-C Cable 1m', sku: 'ELEC001', category: catMap['Electronics'], price: 12.99, costPrice: 4.00, stock: 45, lowStockThreshold: 10, unit: 'pcs', taxRate: 10 },
    { name: 'Wireless Earbuds', sku: 'ELEC002', category: catMap['Electronics'], price: 49.99, costPrice: 18.00, stock: 20, lowStockThreshold: 5, unit: 'pcs', taxRate: 10 },
    { name: 'Phone Case', sku: 'ELEC003', category: catMap['Electronics'], price: 14.99, costPrice: 3.50, stock: 60, lowStockThreshold: 10, unit: 'pcs', taxRate: 10 },
    { name: 'T-Shirt (M)', sku: 'CLO001', category: catMap['Clothing'], price: 19.99, costPrice: 7.00, stock: 40, lowStockThreshold: 8, unit: 'pcs', taxRate: 0 },
    { name: 'Jeans (32x32)', sku: 'CLO002', category: catMap['Clothing'], price: 49.99, costPrice: 18.00, stock: 25, lowStockThreshold: 5, unit: 'pcs', taxRate: 0 },
    { name: 'Paracetamol 500mg', sku: 'HB001', category: catMap['Health & Beauty'], price: 3.99, costPrice: 1.00, stock: 80, lowStockThreshold: 15, unit: 'box', taxRate: 0 },
    { name: 'Hand Sanitizer 100ml', sku: 'HB002', category: catMap['Health & Beauty'], price: 4.99, costPrice: 1.50, stock: 55, lowStockThreshold: 10, unit: 'bottle', taxRate: 0 },
    { name: 'A4 Notebook', sku: 'STA001', category: catMap['Stationery'], price: 3.49, costPrice: 1.00, stock: 70, lowStockThreshold: 10, unit: 'pcs', taxRate: 0 },
    { name: 'Ballpoint Pen (10pk)', sku: 'STA002', category: catMap['Stationery'], price: 2.99, costPrice: 0.80, stock: 90, lowStockThreshold: 15, unit: 'pack', taxRate: 0 },
    { name: 'Sticky Notes', sku: 'STA003', category: catMap['Stationery'], price: 1.99, costPrice: 0.50, stock: 3, lowStockThreshold: 20, unit: 'pad', taxRate: 0 }
  ];

  const savedProducts = await Product.insertMany(products);
  console.log(`Seeded ${savedProducts.length} products`);
  console.log('Database seeded successfully!');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
