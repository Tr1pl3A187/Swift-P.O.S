const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');

// ===== Validation Helpers =====
const ALLOWED_PRODUCT_FIELDS = [
  'name', 'sku', 'barcode', 'category', 'price', 'costPrice',
  'stock', 'lowStockThreshold', 'unit', 'image', 'description', 'isActive', 'storeId'
];

const ALLOWED_STOCK_TYPES = ['in', 'out', 'adjustment'];

function sanitizeBody(body, allowed) {
  const clean = {};
  for (const key of allowed) {
    if (body[key] !== undefined) clean[key] = body[key];
  }
  return clean;
}

function validateObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// ===== GET /api/products/alerts/low-stock — MUST be before /:id =====
router.get('/alerts/low-stock', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const storeId = req.headers['x-store-id'] || 'default';

    const filter = {
      isActive: true,
      storeId,
      $expr: { $lte: ['$stock', '$lowStockThreshold'] }
    };

    const [products, total] = await Promise.all([
      Product.find(filter)
        .sort({ stock: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter)
    ]);

    await Product.populate(products, { path: 'category', select: 'name icon color' });

    res.json({
      success: true,
      data: products,
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
    console.error('GET /products/alerts/low-stock error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch low stock alerts' });
  }
});

// ===== GET /api/products — Paginated, Indexed Search =====
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const storeId = req.headers['x-store-id'] || 'default';

    const filter = { isActive: true };

    if (req.query.scope !== 'global') {
      filter.$or = [{ storeId }, { storeId: { $exists: false } }];
    }

    if (req.query.category) {
      if (!validateObjectId(req.query.category)) {
        return res.status(400).json({ success: false, message: 'Invalid category ID' });
      }
      filter.category = req.query.category;
    }

    if (req.query.search) {
      const search = req.query.search.trim();
      if (search.length > 0) {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const searchConditions = [
          { name: { $regex: escaped, $options: 'i' } },
          { sku: { $regex: escaped, $options: 'i' } },
          { barcode: { $regex: escaped, $options: 'i' } }
        ];

        if (filter.$or) {
          filter.$and = [
            { $or: filter.$or },
            { $or: searchConditions }
          ];
          delete filter.$or;
        } else {
          filter.$or = searchConditions;
        }
      }
    }

    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate('category', 'name icon color')
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: products,
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
    console.error('GET /products error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch products' });
  }
});

// ===== GET /api/products/:id =====
router.get('/:id', async (req, res) => {
  try {
    if (!validateObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    const storeId = req.headers['x-store-id'] || 'default';
    const filter = { _id: req.params.id, isActive: true };

    const product = await Product.findOne(filter)
      .populate('category', 'name icon color')
      .lean();

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.json({ success: true, data: product });
  } catch (err) {
    console.error('GET /products/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch product' });
  }
});

// ===== POST /api/products — Create =====
router.post('/', async (req, res) => {
  try {
    const cleanBody = sanitizeBody(req.body, ALLOWED_PRODUCT_FIELDS);
    const storeId = req.headers['x-store-id'] || 'default';
    cleanBody.storeId = storeId;

    if (!cleanBody.name || cleanBody.name.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Product name is required (min 2 chars)' });
    }
    if (cleanBody.price !== undefined && cleanBody.price < 0) {
      return res.status(400).json({ success: false, message: 'Price cannot be negative' });
    }
    if (cleanBody.stock !== undefined && cleanBody.stock < 0) {
      return res.status(400).json({ success: false, message: 'Stock cannot be negative' });
    }

    if (cleanBody.sku) {
      const existing = await Product.findOne({
        sku: cleanBody.sku,
        isActive: true,
        storeId
      }).lean();
      if (existing) {
        return res.status(409).json({ success: false, message: 'SKU already exists for this store' });
      }
    }

    const product = new Product(cleanBody);
    await product.save();
    await product.populate('category', 'name icon color');

    safeEmit(req.io, `store:${storeId}`, 'product:created', product);

    res.status(201).json({ success: true, data: product });
  } catch (err) {
    console.error('POST /products error:', err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Duplicate SKU or barcode' });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ===== PUT /api/products/:id — Update =====
router.put('/:id', async (req, res) => {
  try {
    if (!validateObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    const cleanBody = sanitizeBody(req.body, ALLOWED_PRODUCT_FIELDS);
    delete cleanBody._id;
    delete cleanBody.createdAt;
    delete cleanBody.storeId;

    if (cleanBody.price !== undefined && cleanBody.price < 0) {
      return res.status(400).json({ success: false, message: 'Price cannot be negative' });
    }

    const storeId = req.headers['x-store-id'] || 'default';

    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, isActive: true, storeId },
      cleanBody,
      { new: true, runValidators: true }
    ).populate('category', 'name icon color');

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    safeEmit(req.io, `store:${storeId}`, 'product:updated', product);

    res.json({ success: true, data: product });
  } catch (err) {
    console.error('PUT /products/:id error:', err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Duplicate SKU or barcode' });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ===== PATCH /api/products/:id/stock — Atomic, Transactional, Race-Safe =====
router.patch('/:id/stock', async (req, res) => {
  if (!validateObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID' });
  }

  const { quantity, type, reason } = req.body;

  if (!ALLOWED_STOCK_TYPES.includes(type)) {
    return res.status(400).json({
      success: false,
      message: `Type must be one of: ${ALLOWED_STOCK_TYPES.join(', ')}`
    });
  }
  if (typeof quantity !== 'number' || quantity < 0 || !Number.isFinite(quantity)) {
    return res.status(400).json({ success: false, message: 'Quantity must be a non-negative number' });
  }

  const storeId = req.headers['x-store-id'] || 'default';

  async function executeStockUpdate(session) {
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority', j: true, wtimeout: 5000 }
    });

    try {
      let previousStock;
      let updatedProduct;

      if (type === 'adjustment') {
        const product = await Product.findOne(
          { _id: req.params.id, isActive: true, storeId },
          'stock',
          { session }
        ).lean();

        if (!product) {
          await session.abortTransaction();
          return { status: 404, body: { success: false, message: 'Product not found' } };
        }

        previousStock = product.stock;

        updatedProduct = await Product.findOneAndUpdate(
          { _id: req.params.id, isActive: true, storeId },
          { $set: { stock: quantity, updatedAt: new Date() } },
          { new: true, session, runValidators: true }
        ).populate('category', 'name icon color');
      } else {
        const incAmount = type === 'in' ? quantity : -quantity;
        const filter = type === 'out'
          ? { _id: req.params.id, isActive: true, storeId, stock: { $gte: quantity } }
          : { _id: req.params.id, isActive: true, storeId };

        updatedProduct = await Product.findOneAndUpdate(
          filter,
          { $inc: { stock: incAmount }, $set: { updatedAt: new Date() } },
          { new: true, session, runValidators: true }
        ).populate('category', 'name icon color');

        if (!updatedProduct) {
          const exists = await Product.findOne(
            { _id: req.params.id, isActive: true, storeId },
            'stock',
            { session }
          ).lean();

          if (!exists) {
            await session.abortTransaction();
            return { status: 404, body: { success: false, message: 'Product not found' } };
          }

          if (type === 'out') {
            await session.abortTransaction();
            return {
              status: 409,
              body: {
                success: false,
                message: `Insufficient stock. Available: ${exists.stock}, Requested: ${quantity}`
              }
            };
          }

          await session.abortTransaction();
          return { status: 500, body: { success: false, message: 'Stock update failed unexpectedly' } };
        }

        previousStock = type === 'in'
          ? updatedProduct.stock - quantity
          : updatedProduct.stock + quantity;
      }

      const movement = new StockMovement({
        product: updatedProduct._id,
        type,
        quantity,
        previousStock,
        newStock: updatedProduct.stock,
        reason: (reason || '').trim().substring(0, 500),
        storeId,
        performedBy: req.user?.id || 'system'
      });
      await movement.save({ session });

      await session.commitTransaction();

      return {
        status: 200,
        body: { success: true, data: updatedProduct },
        emit: {
          room: `store:${storeId}`,
          events: [
            { name: 'product:stockUpdated', payload: updatedProduct },
            { name: 'stock:movement', payload: movement }
          ]
        }
      };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    }
  }

  const session = await mongoose.startSession();
  let result;
  let lastError;

  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result = await executeStockUpdate(session);
        break;
      } catch (err) {
        lastError = err;
        const isTransient = err.errorLabels && err.errorLabels.includes('TransientTransactionError');
        const isCommitUnknown = err.errorLabels && err.errorLabels.includes('UnknownTransactionCommitResult');

        if ((isTransient || isCommitUnknown) && attempt < 3) {
          console.warn(`Transient transaction error on attempt ${attempt}, retrying...`);
          await new Promise(r => setTimeout(r, 100 * attempt));
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    console.error('PATCH /products/:id/stock error:', err);
    if (err.code === 112) {
      return res.status(409).json({
        success: false,
        message: 'Concurrent stock modification detected. Please retry.'
      });
    }
    return res.status(500).json({ success: false, message: 'Stock adjustment failed' });
  } finally {
    session.endSession();
  }

  if (result && result.emit) {
    for (const evt of result.emit.events) {
      safeEmit(req.io, result.emit.room, evt.name, evt.payload);
    }
  }

  return res.status(result.status).json(result.body);
});

// ===== DELETE /api/products/:id — Soft Delete =====
router.delete('/:id', async (req, res) => {
  try {
    if (!validateObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    const storeId = req.headers['x-store-id'] || 'default';

    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, isActive: true, storeId },
      { isActive: false, updatedAt: new Date() },
      { new: true }
    );

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    safeEmit(req.io, `store:${storeId}`, 'product:deleted', { id: req.params.id });

    res.json({ success: true, message: 'Product deleted' });
  } catch (err) {
    console.error('DELETE /products/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete product' });
  }
});

// ===== Safe Socket.IO Emitter =====
function safeEmit(io, room, event, payload) {
  try {
    if (io && typeof io.to === 'function') {
      io.to(room).emit(event, payload);
    }
  } catch (err) {
    console.error(`Socket emit failed (${event} → ${room}):`, err.message);
  }
}

module.exports = router;