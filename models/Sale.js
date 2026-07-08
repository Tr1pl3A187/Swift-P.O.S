const mongoose = require('mongoose');

// =============================================================================
// MONETARY POLICY: All currency fields are INTEGER CENTS.
// $12.34 is stored as 1234. The API layer (routes/sales.js) converts dollars→cents.
// toJSON transforms cents→dollars for frontend display.
// =============================================================================

const saleItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Product reference is required']
    },
    productName: {
      type: String,
      required: [true, 'Product name snapshot is required'],
      trim: true
    },
    sku: {
      type: String,
      required: [true, 'SKU snapshot is required'],
      uppercase: true,
      trim: true
    },
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [1, 'Quantity must be at least 1']
    },
    unitPrice: {
      type: Number,
      required: [true, 'Unit price is required'],
      min: [0, 'Unit price cannot be negative'],
      set: (v) => Math.round(v) // Expects cents
    },
    discount: {
      type: Number,
      default: 0,
      min: [0, 'Discount cannot be negative'],
      set: (v) => Math.round(v)
    },
    taxRate: {
      type: Number,
      default: 0,
      min: [0, 'Tax rate cannot be negative'],
      max: [100, 'Tax rate cannot exceed 100%'],
      set: (v) => Math.round(v * 100) / 100 // Percent stays decimal (e.g. 8.25)
    },
    tax: {
      type: Number,
      default: 0,
      min: [0, 'Tax cannot be negative'],
      set: (v) => Math.round(v)
    },
    subtotal: {
      type: Number,
      required: [true, 'Line subtotal is required'],
      min: [0, 'Subtotal cannot be negative'],
      set: (v) => Math.round(v)
    }
  },
  { _id: false }
);

const saleSchema = new mongoose.Schema(
  {
    storeId: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      default: 'default'
      // No field-level index — covered by all compound indexes
    },

    receiptNumber: {
      type: String,
      required: true,
      trim: true
      // Unique per-store via compound index below (not global)
    },

    idempotencyKey: {
      type: String,
      sparse: true,
      trim: true
      // No field-level index — covered by compound unique sparse below
    },

    items: {
      type: [saleItemSchema],
      required: [true, 'Sale must contain at least one item'],
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0,
        message: 'Sale must contain at least one item'
      }
    },

    subtotal: {
      type: Number,
      required: true,
      min: [0, 'Subtotal cannot be negative'],
      set: (v) => Math.round(v)
    },

    discount: {
      type: Number,
      default: 0,
      min: [0, 'Discount cannot be negative'],
      set: (v) => Math.round(v)
    },

    tax: {
      type: Number,
      default: 0,
      min: [0, 'Tax cannot be negative'],
      set: (v) => Math.round(v)
    },

    total: {
      type: Number,
      required: true,
      min: [0, 'Total cannot be negative'],
      set: (v) => Math.round(v)
    },

    paymentMethod: {
      type: String,
      enum: {
        values: ['cash', 'card', 'mobile'],
        message: 'Payment method must be cash, card, or mobile'
      },
      default: 'cash',
      required: true
    },

    amountPaid: {
      type: Number,
      required: true,
      min: [0, 'Amount paid cannot be negative'],
      set: (v) => Math.round(v)
    },

    change: {
      type: Number,
      default: 0,
      min: [0, 'Change cannot be negative'],
      set: (v) => Math.round(v)
    },

    cashier: {
      type: String,
      required: [true, 'Cashier identifier is required'],
      trim: true,
      default: 'system'
    },

    note: {
      type: String,
      default: '',
      trim: true,
      maxlength: [1000, 'Note cannot exceed 1000 characters']
    },

    status: {
      type: String,
      enum: {
        values: ['completed', 'refunded', 'voided'],
        message: 'Status must be completed, refunded, or voided'
      },
      default: 'completed',
      required: true
    },

    isActive: {
      type: Boolean,
      default: true
    },

    version: {
      type: Number,
      default: 0
    },

    // Expanded to support both refunds and voids
    refundInfo: {
      refundedAt: Date,
      refundedBy: String,
      voidedAt: Date,
      voidedBy: String,
      reason: {
        type: String,
        maxlength: [500, 'Reason cannot exceed 500 characters']
      }
    }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret.__v;
        delete ret.version;
        delete ret.idempotencyKey;

        // Convert integer cents → dollars for API consumers
        const centFields = ['subtotal', 'discount', 'tax', 'total', 'amountPaid', 'change'];
        centFields.forEach((f) => {
          if (ret[f] !== undefined) ret[f] = ret[f] / 100;
        });

        if (ret.items) {
          ret.items.forEach((item) => {
            ['unitPrice', 'discount', 'tax', 'subtotal'].forEach((f) => {
              if (item[f] !== undefined) item[f] = item[f] / 100;
            });
          });
        }

        return ret;
      }
    },
    toObject: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret.__v;
        delete ret.version;
        delete ret.idempotencyKey;
        const centFields = ['subtotal', 'discount', 'tax', 'total', 'amountPaid', 'change'];
        centFields.forEach((f) => {
          if (ret[f] !== undefined) ret[f] = ret[f] / 100;
        });
        if (ret.items) {
          ret.items.forEach((item) => {
            ['unitPrice', 'discount', 'tax', 'subtotal'].forEach((f) => {
              if (item[f] !== undefined) item[f] = item[f] / 100;
            });
          });
        }
        return ret;
      }
    }
  }
);

// ===== INDEXES (Compound only — zero redundancy) =====

// 1. Sales history by store, newest first
saleSchema.index({ storeId: 1, createdAt: -1 });

// 2. Receipt lookup — UNIQUE PER STORE (not global)
saleSchema.index({ storeId: 1, receiptNumber: 1 }, { unique: true });

// 3. Status filtering for reports
saleSchema.index({ storeId: 1, status: 1, createdAt: -1 });

// 4. Cashier audit trail
saleSchema.index({ storeId: 1, cashier: 1, createdAt: -1 });

// 5. Idempotency guard — unique per store, sparse (nulls allowed)
saleSchema.index({ storeId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

// 6. Cleanup queries for voided/archived sales
saleSchema.index({ storeId: 1, isActive: 1, createdAt: 1 });

// ===== PRE-SAVE VALIDATION (Integer math — zero tolerance) =====
saleSchema.pre('save', function (next) {
  let computedSubtotal = 0;

  for (const item of this.items) {
    const expectedSubtotal = (item.unitPrice - item.discount) * item.quantity;
    if (item.subtotal !== expectedSubtotal) {
      return next(
        new Error(
          `Line item subtotal mismatch for ${item.sku}: expected ${expectedSubtotal}, got ${item.subtotal}`
        )
      );
    }
    computedSubtotal += item.subtotal;
  }

  if (this.subtotal !== computedSubtotal) {
    return next(
      new Error(
        `Sale subtotal mismatch: expected ${computedSubtotal}, got ${this.subtotal}`
      )
    );
  }

  const expectedTotal = this.subtotal - this.discount + this.tax;
  if (this.total !== expectedTotal) {
    return next(
      new Error(
        `Sale total mismatch: expected ${expectedTotal}, got ${this.total}`
      )
    );
  }

  if (this.status === 'completed' && this.amountPaid < this.total) {
    return next(
      new Error(
        `Amount paid (${this.amountPaid}) is less than total (${this.total})`
      )
    );
  }

  const expectedChange = Math.max(0, this.amountPaid - this.total);
  if (this.change !== expectedChange) {
    return next(
      new Error(
        `Change mismatch: expected ${expectedChange}, got ${this.change}`
      )
    );
  }

  next();
});

// ===== STATIC METHODS =====

/**
 * Atomic receipt number generator.
 * Uses a per-store counter. Format: STORE-YYYYMMDD-000001
 * Guaranteed unique per store (no random suffix = no collisions).
 */
saleSchema.statics.generateReceiptNumber = async function (storeId, session) {
  const Counter = mongoose.connection.collection('counters');

  const result = await Counter.findOneAndUpdate(
    { _id: `receipt-${storeId}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session }
  );

  const seq = result?.seq ?? result?.value?.seq ?? 1;
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  return `${String(storeId).toUpperCase()}-${timestamp}-${String(seq).padStart(6, '0')}`;
};

/**
 * Void a sale: restore stock, create audit trail, mark voided.
 * Must run inside a transaction session.
 */
saleSchema.statics.voidSale = async function (saleId, reason, performedBy, session) {
  if (!mongoose.Types.ObjectId.isValid(saleId)) {
    return { success: false, error: 'Invalid sale ID' };
  }

  const Product = mongoose.model('Product');
  const StockMovement = mongoose.model('StockMovement');

  // Fetch the sale (locked by transaction)
  const sale = await this.findOne(
    { _id: saleId, status: 'completed', isActive: true },
    null,
    { session }
  );

  if (!sale) {
    return { success: false, error: 'Sale not found or already voided/refunded' };
  }

  // 1. Restore stock for every item
  const stockUpdates = [];

  for (const item of sale.items) {
    const stockResult = await Product.incrementStock(item.product, item.quantity, session);

    if (!stockResult.success) {
      return {
        success: false,
        error: `Stock restore failed for ${item.sku}: ${stockResult.error}`
      };
    }

    stockUpdates.push({
      product: stockResult.product,
      previousStock: stockResult.product.stock - item.quantity,
      newStock: stockResult.product.stock,
      quantity: item.quantity
    });
  }

  // 2. Mark sale voided
  sale.status = 'voided';
  sale.isActive = false;
  sale.refundInfo = {
    voidedAt: new Date(),
    voidedBy: performedBy,
    reason: String(reason || '').substring(0, 500)
  };
  sale.version += 1;

  await sale.save({ session });

  // 3. Audit trail for stock restoration
  for (const update of stockUpdates) {
    await StockMovement.create(
      [{
        storeId: sale.storeId,
        product: update.product._id,
        type: 'adjustment',
        quantity: update.quantity,
        previousStock: update.previousStock,
        newStock: update.newStock,
        reason: `Void sale: ${sale.receiptNumber}`,
        reference: sale._id,
        referenceModel: 'Sale',
        referenceNumber: sale.receiptNumber,
        performedBy: performedBy || 'system'
      }],
      { session }
    );
  }

  return { success: true, sale };
};

module.exports = mongoose.model('Sale', saleSchema);