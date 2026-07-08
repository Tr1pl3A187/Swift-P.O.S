const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');

const ALLOWED_PAYMENT_METHODS = ['cash', 'card', 'mobile'];

function validateObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// Convert dollar input (e.g., 12.34) to integer cents (1234)
function toCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

// Module-level safe emitter
function safeEmit(io, room, event, payload) {
  try {
    if (io && typeof io.to === 'function') {
      io.to(room).emit(event, payload);
    }
  } catch (err) {
    console.error(`Socket emit failed (${event} → ${room}):`, err.message);
  }
}

// ===== GET /api/sales — Paginated, Store-Scoped =====
router.get('/', async (req, res) => {
  try {
    const storeId = req.headers['x-store-id'] || 'default';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = { storeId };

    if (req.query.status) {
      if (!['completed', 'refunded', 'voided'].includes(req.query.status)) {
        return res.status(400).json({ success: false, message: 'Invalid status filter' });
      }
      filter.status = req.query.status;
    }

    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) {
        const fromDate = new Date(req.query.from);
        if (isNaN(fromDate.getTime())) {
          return res.status(400).json({ success: false, message: 'Invalid from date' });
        }
        filter.createdAt.$gte = fromDate;
      }
      if (req.query.to) {
        const toDate = new Date(req.query.to);
        if (isNaN(toDate.getTime())) {
          return res.status(400).json({ success: false, message: 'Invalid to date' });
        }
        toDate.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = toDate;
      }
    }

    const [sales, total] = await Promise.all([
      Sale.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Sale.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: sales,
      meta: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    });
  } catch (err) {
    console.error('GET /sales error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch sales' });
  }
});

// ===== GET /api/sales/:id =====
router.get('/:id', async (req, res) => {
  try {
    if (!validateObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid sale ID' });
    }

    const storeId = req.headers['x-store-id'] || 'default';
    const sale = await Sale.findOne({ _id: req.params.id, storeId });

    if (!sale) {
      return res.status(404).json({ success: false, message: 'Sale not found' });
    }

    res.json({ success: true, data: sale });
  } catch (err) {
    console.error('GET /sales/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch sale' });
  }
});

// ===== POST /api/sales — Transactional Checkout (Idempotent, Retryable) =====
router.post('/', async (req, res) => {
  const storeId = req.headers['x-store-id'] || 'default';
  const idempotencyKey = req.headers['idempotency-key'];

  const { items, discount, paymentMethod, amountPaid, cashier, note } = req.body;

  // === 1. VALIDATE EVERYTHING BEFORE TOUCHING A SESSION ===
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Sale must contain at least one item' });
  }
  if (!ALLOWED_PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({
      success: false,
      message: `Payment method must be one of: ${ALLOWED_PAYMENT_METHODS.join(', ')}`
    });
  }

  const discountCents = toCents(discount);
  const paidCents = toCents(amountPaid);
  if (isNaN(paidCents) || paidCents < 0) {
    return res.status(400).json({ success: false, message: 'Invalid amount paid' });
  }

  for (const item of items) {
    if (!validateObjectId(item.productId)) {
      return res.status(400).json({ success: false, message: `Invalid product ID: ${item.productId}` });
    }
    const qty = Number(item.quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      return res.status(400).json({ success: false, message: 'Quantity must be a positive integer' });
    }
  }

  // === 2. IDEMPOTENCY FAST PATH (no session — unique index is the real guard) ===
  if (idempotencyKey) {
    try {
      // NOTE: .lean() removed so model toJSON transform applies (cents → dollars)
      const existing = await Sale.findOne({ idempotencyKey, storeId });
      if (existing) {
        console.log(`[Idempotency] Returning cached sale ${existing.receiptNumber}`);
        return res.status(200).json({ success: true, data: existing, cached: true });
      }
    } catch (err) {
      console.error('[Idempotency] Check failed:', err);
      // Continue — unique index will enforce correctness
    }
  }

  // === 3. TRANSACTIONAL CHECKOUT (retryable) ===
  const session = await mongoose.startSession();

  async function executeCheckout() {
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority', j: true, wtimeout: 5000 }
    });

    try {
      const saleItems = [];
      let subtotalCents = 0;
      const stockUpdates = [];

      for (const item of items) {
        const quantity = Number(item.quantity);
        const stockResult = await Product.decrementStock(item.productId, quantity, session);

        if (!stockResult.success) {
          await session.abortTransaction();
          return {
            error: {
              status: 409,
              body: { success: false, message: stockResult.error, productId: item.productId }
            }
          };
        }

        const product = stockResult.product;
        const itemDiscountCents = toCents(item.discount);
        const itemSubtotalCents = (quantity * product.price) - itemDiscountCents;
        const itemTaxCents = Math.round(itemSubtotalCents * (product.taxRate || 0) / 100);

        subtotalCents += itemSubtotalCents;

        saleItems.push({
          product: product._id,
          productName: product.name,
          sku: product.sku,
          quantity,
          unitPrice: product.price,      // cents
          discount: itemDiscountCents,   // cents
          taxRate: product.taxRate,
          tax: itemTaxCents,             // cents
          subtotal: itemSubtotalCents    // cents
        });

        stockUpdates.push({
          product,
          previousStock: product.stock + quantity,
          newStock: product.stock,
          quantity,
          reason: 'Sale checkout'
        });
      }

      const taxCents = saleItems.reduce((acc, item) => acc + item.tax, 0);
      const totalCents = subtotalCents - discountCents + taxCents;

      if (paidCents < totalCents) {
        await session.abortTransaction();
        return {
          error: {
            status: 400,
            body: {
              success: false,
              message: `Amount paid ($${(paidCents / 100).toFixed(2)}) is less than total ($${(totalCents / 100).toFixed(2)})`
            }
          }
        };
      }

      const receiptNumber = await Sale.generateReceiptNumber(storeId, session);

      const sale = new Sale({
        storeId,
        receiptNumber,
        idempotencyKey: idempotencyKey || undefined,
        items: saleItems,
        subtotal: subtotalCents,
        discount: discountCents,
        tax: taxCents,
        total: totalCents,
        paymentMethod,
        amountPaid: paidCents,
        change: Math.max(0, paidCents - totalCents),
        cashier: (cashier || 'Admin').trim().substring(0, 100),
        note: (note || '').trim().substring(0, 1000),
        status: 'completed'
      });

      await sale.save({ session });

      // Audit trail
      for (const update of stockUpdates) {
        const movement = new StockMovement({
          storeId,
          product: update.product._id,
          type: 'sale',
          quantity: update.quantity,
          previousStock: update.previousStock,
          newStock: update.newStock,
          reason: `Sale: ${receiptNumber}`,
          reference: sale._id,              // ObjectId — NOT .toString()
          referenceModel: 'Sale',
          referenceNumber: receiptNumber,
          performedBy: (cashier || 'Admin').trim().substring(0, 100)
        });
        await movement.save({ session });
      }

      await session.commitTransaction();
      return { sale, stockUpdates };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    }
  }

  // Retry loop
  let result;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result = await executeCheckout();
        if (result.error) {
          session.endSession();
          return res.status(result.error.status).json(result.error.body);
        }
        break;
      } catch (err) {
        // Another request with same idempotencyKey won the race
        if (err.code === 11000 && idempotencyKey) {
          const existing = await Sale.findOne({ idempotencyKey, storeId });
          if (existing) {
            session.endSession();
            return res.status(200).json({ success: true, data: existing, cached: true });
          }
        }

        const isTransient = err.errorLabels?.includes('TransientTransactionError');
        const isUnknownCommit = err.errorLabels?.includes('UnknownTransactionCommitResult');
        if ((isTransient || isUnknownCommit) && attempt < 3) {
          console.warn(`Transient transaction error on checkout attempt ${attempt}, retrying...`);
          await new Promise(r => setTimeout(r, 100 * attempt));
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    console.error('POST /sales checkout error:', err);
    session.endSession();
    return res.status(500).json({ success: false, message: 'Checkout failed. Please try again.' });
  }

  // === 4. POST-COMMIT SIDE EFFECTS (never inside transaction) ===
  const { sale, stockUpdates } = result;

  for (const update of stockUpdates) {
    safeEmit(req.io, `store:${storeId}`, 'product:stockUpdated', update.product);
  }
  safeEmit(req.io, `store:${storeId}`, 'sale:created', sale);
  safeEmit(req.io, `store:${storeId}`, 'dashboard:refresh', {
    storeId,
    timestamp: new Date().toISOString()
  });

  session.endSession();
  res.status(201).json({ success: true, data: sale });
});

// ===== GET /api/sales/reports/summary =====
router.get('/reports/summary', async (req, res) => {
  try {
    const storeId = req.headers['x-store-id'] || 'default';

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [todayAgg, monthAgg, totalAgg, topProductsAgg, paymentAgg] = await Promise.all([
      Sale.aggregate([
        { $match: { storeId, status: 'completed', createdAt: { $gte: today, $lte: endOfDay } } },
        { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$total' } } }
      ]),
      Sale.aggregate([
        { $match: { storeId, status: 'completed', createdAt: { $gte: startOfMonth } } },
        { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$total' } } }
      ]),
      Sale.aggregate([
        { $match: { storeId, status: 'completed' } },
        { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$total' } } }
      ]),
      Sale.aggregate([
        { $match: { storeId, status: 'completed', createdAt: { $gte: startOfMonth } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.productName', qty: { $sum: '$items.quantity' }, revenue: { $sum: '$items.subtotal' } } },
        { $sort: { revenue: -1 } },
        { $limit: 5 },
        { $project: { _id: 0, name: '$_id', qty: 1, revenue: 1 } }
      ]),
      Sale.aggregate([
        { $match: { storeId, status: 'completed', createdAt: { $gte: today, $lte: endOfDay } } },
        { $group: { _id: '$paymentMethod', total: { $sum: '$total' } } }
      ])
    ]);

    const paymentBreakdown = { cash: 0, card: 0, mobile: 0 };
    paymentAgg.forEach(p => { paymentBreakdown[p._id] = (p.total || 0) / 100; });

    // Helper to convert cents to dollars for report display
    const $ = (cents) => (cents || 0) / 100;

    res.json({
      success: true,
      data: {
        today: { sales: todayAgg[0]?.count || 0, revenue: $(todayAgg[0]?.revenue) },
        month: { sales: monthAgg[0]?.count || 0, revenue: $(monthAgg[0]?.revenue) },
        total: { sales: totalAgg[0]?.count || 0, revenue: $(totalAgg[0]?.revenue) },
        topProducts: topProductsAgg.map(p => ({ ...p, revenue: $(p.revenue) })),
        paymentBreakdown
      }
    });
  } catch (err) {
    console.error('GET /sales/reports/summary error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate report' });
  }
});

module.exports = router;