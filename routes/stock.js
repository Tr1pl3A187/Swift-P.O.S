const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const StockMovement = require('../models/StockMovement');

function validateObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// ===== GET /api/stock — Store-Scoped Audit Trail =====
router.get('/', async (req, res) => {
  try {
    const storeId = req.headers['x-store-id'] || 'default';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const skip = (page - 1) * limit;

    const filter = { storeId };

    if (req.query.product) {
      if (!validateObjectId(req.query.product)) {
        return res.status(400).json({ success: false, message: 'Invalid product ID' });
      }
      filter.product = req.query.product;
    }

    if (req.query.type) {
      const allowed = ['in', 'out', 'adjustment', 'sale', 'refund', 'return'];
      if (!allowed.includes(req.query.type)) {
        return res.status(400).json({
          success: false,
          message: `Type must be one of: ${allowed.join(', ')}`
        });
      }
      filter.type = req.query.type;
    }

    const [movements, total] = await Promise.all([
      StockMovement.find(filter)
        .populate({
          path: 'product',
          select: 'name sku storeId isActive',
          match: { storeId, isActive: true } // Scoped populate
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockMovement.countDocuments(filter)
    ]);

    // Filter out movements where populate returned null (orphaned refs)
    const cleanMovements = movements.filter(m => m.product !== null);

    res.json({
      success: true,
      data: cleanMovements,
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
    console.error('GET /stock error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch stock movements' });
  }
});

module.exports = router;