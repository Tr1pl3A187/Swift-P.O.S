const mongoose = require('mongoose');

const stockMovementSchema = new mongoose.Schema(
  {
    storeId: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      default: 'default'
      // No field-level index — covered by ALL compound indexes
    },

    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Product reference is required']
      // No field-level index — covered by { storeId, product, createdAt }
    },

    type: {
      type: String,
      enum: {
        values: ['in', 'out', 'adjustment', 'sale', 'refund', 'return'],
        message: 'Type must be in, out, adjustment, sale, refund, or return'
      },
      required: [true, 'Movement type is required']
    },

    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      validate: {
        validator: function (v) {
          return v > 0;
        },
        message: 'Quantity must be a positive number'
      }
    },

    previousStock: {
      type: Number,
      required: [true, 'Previous stock is required'],
      min: [0, 'Previous stock cannot be negative']
    },

    newStock: {
      type: Number,
      required: [true, 'New stock is required'],
      min: [0, 'New stock cannot be negative']
    },

    reason: {
      type: String,
      default: '',
      trim: true,
      maxlength: [1000, 'Reason cannot exceed 1000 characters']
    },

    reference: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'referenceModel',
      default: null
      // No field-level index — covered by compound below
    },

    referenceModel: {
      type: String,
      enum: ['Sale', 'Product'],
      default: 'Sale'
    },

    referenceNumber: {
      type: String,
      default: '',
      trim: true
      // No field-level index — covered by { storeId, referenceNumber }
    },

    performedBy: {
      type: String,
      required: [true, 'Performer identity is required'],
      trim: true,
      default: 'system'
    }
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        delete ret.__v;
        return ret;
      }
    },
    toObject: {
      transform: (doc, ret) => {
        delete ret.__v;
        return ret;
      }
    }
  }
);

// ===== INDEXES (5 compound, 0 redundant single-field) =====

// 1. Audit trail by store + product + date
stockMovementSchema.index({ storeId: 1, product: 1, createdAt: -1 });

// 2. Recent activity feed per store
stockMovementSchema.index({ storeId: 1, createdAt: -1 });

// 3. Lookup by receipt number
stockMovementSchema.index({ storeId: 1, referenceNumber: 1 });

// 4. Movement type analytics
stockMovementSchema.index({ storeId: 1, type: 1, createdAt: -1 });

// 5. Reference lookup (receipt traceability)
stockMovementSchema.index({ storeId: 1, reference: 1, referenceModel: 1 });

// ===== PRE-SAVE VALIDATION =====
stockMovementSchema.pre('save', function (next) {
  // Tightened tolerance for fractional units (kg, liters)
  const expectedNewStock =
    this.type === 'in' || this.type === 'return'
      ? this.previousStock + this.quantity
      : this.previousStock - this.quantity;

  if (Math.abs(this.newStock - expectedNewStock) > 0.001) {
    return next(
      new Error(
        `Stock movement math error: previous=${this.previousStock}, qty=${this.quantity}, type=${this.type}, expected=${expectedNewStock}, got=${this.newStock}`
      )
    );
  }

  next();
});

module.exports = mongoose.model('StockMovement', stockMovementSchema);