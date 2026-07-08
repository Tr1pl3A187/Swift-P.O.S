const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Category = require('../models/Category');

const ALLOWED_FIELDS = ['name', 'icon', 'color', 'isActive', 'sortOrder'];

function sanitizeBody(body) {
  const clean = {};
  for (const key of ALLOWED_FIELDS) {
    if (body[key] !== undefined) clean[key] = body[key];
  }
  return clean;
}

function validateObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function safeEmit(io, room, event, payload) {
  try {
    if (io && typeof io.to === 'function') {
      io.to(room).emit(event, payload);
    }
  } catch (err) {
    console.error(`Socket emit failed (${event} → ${room}):`, err.message);
  }
}

// ===== GET /api/categories — Store-Scoped =====
router.get('/', async (req, res) => {
  try {
    const storeId = req.headers['x-store-id'] || 'default';

    const categories = await Category.find({ storeId, isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    res.json({ success: true, data: categories });
  } catch (err) {
    console.error('GET /categories error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch categories' });
  }
});

// ===== POST /api/categories — Create =====
router.post('/', async (req, res) => {
  try {
    const storeId = req.headers['x-store-id'] || 'default';
    const cleanBody = sanitizeBody(req.body);

    if (!cleanBody.name || cleanBody.name.trim().length < 1) {
      return res.status(400).json({ success: false, message: 'Category name is required' });
    }

    cleanBody.name = cleanBody.name.trim();
    cleanBody.storeId = storeId;

    const category = new Category(cleanBody);
    await category.save();

    safeEmit(req.io, `store:${storeId}`, 'category:created', category);

    res.status(201).json({ success: true, data: category });
  } catch (err) {
    console.error('POST /categories error:', err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Category name already exists in this store' });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ===== PUT /api/categories/:id — Update =====
router.put('/:id', async (req, res) => {
  try {
    if (!validateObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid category ID' });
    }

    const storeId = req.headers['x-store-id'] || 'default';
    const cleanBody = sanitizeBody(req.body);

    if (cleanBody.name !== undefined && cleanBody.name.trim().length < 1) {
      return res.status(400).json({ success: false, message: 'Category name cannot be empty' });
    }
    if (cleanBody.name) cleanBody.name = cleanBody.name.trim();

    const category = await Category.findOneAndUpdate(
      { _id: req.params.id, storeId, isActive: true },
      cleanBody,
      { new: true, runValidators: true }
    );

    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    safeEmit(req.io, `store:${storeId}`, 'category:updated', category);

    res.json({ success: true, data: category });
  } catch (err) {
    console.error('PUT /categories/:id error:', err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Category name already exists in this store' });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ===== DELETE /api/categories/:id — Soft Delete =====
router.delete('/:id', async (req, res) => {
  try {
    if (!validateObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid category ID' });
    }

    const storeId = req.headers['x-store-id'] || 'default';

    const category = await Category.findOneAndUpdate(
      { _id: req.params.id, storeId, isActive: true },
      { isActive: false, updatedAt: new Date() },
      { new: true }
    );

    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    safeEmit(req.io, `store:${storeId}`, 'category:deleted', { id: req.params.id });

    res.json({ success: true, message: 'Category deleted' });
  } catch (err) {
    console.error('DELETE /categories/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete category' });
  }
});

module.exports = router;