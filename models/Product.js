const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    // Multi-tenancy
    storeId: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      default: 'default'
      // NOTE: No field-level index here. Covered by compound indexes.
    },

    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [200, 'Name cannot exceed 200 characters']
    },

    sku: {
      type: String,
      required: [true, 'SKU is required'],
      uppercase: true,
      trim: true,
      maxlength: [50, 'SKU cannot exceed 50 characters']
    },

    barcode: {
      type: String,
      trim: true,
      maxlength: [50, 'Barcode cannot exceed 50 characters'],
      default: ''
    },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: [true, 'Category is required']
      // NOTE: No field-level index here. Covered by compound index.
    },

    // CRITICAL: Currency stored as integer cents to eliminate float errors.
    // $12.34 is stored as 1234. Divide by 100 for display.
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price cannot be negative'],
      set: (v) => Math.round(v) // Enforce integer cents
    },

    costPrice: {
      type: Number,
      default: 0,
      min: [0, 'Cost price cannot be negative'],
      set: (v) => Math.round(v)
    },

    stock: {
      type: Number,
      default: 0,
      min: [0, 'Stock cannot be negative'],
      set: (v) => Math.round(v * 100) / 100 // Fractional units (kg, L)
    },

    lowStockThreshold: {
      type: Number,
      default: 10,
      min: [0, 'Threshold cannot be negative']
    },

    // Computed field for indexable low-stock queries (updated by static methods)
    isLowStock: {
      type: Boolean,
      default: false,
      index: true
    },

    unit: {
      type: String,
      default: 'pcs',
      trim: true,
      maxlength: [20, 'Unit cannot exceed 20 characters']
    },

    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: [2000, 'Description cannot exceed 2000 characters']
    },

    image: {
      type: String,
      default: '',
      trim: true
    },

    isActive: {
      type: Boolean,
      default: true
      // NOTE: No field-level index here. Covered by compound indexes.
    },

    taxRate: {
      type: Number,
      default: 0,
      min: [0, 'Tax rate cannot be negative'],
      max: [100, 'Tax rate cannot exceed 100%'],
      set: (v) => Math.round(v * 100) / 100
    },

    // Concurrency counter (incremented on every stock mutation)
    version: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret.__v;
        delete ret.version;
        // Convert cents back to dollars for API consumers
        if (ret.price !== undefined) ret.price = ret.price / 100;
        if (ret.costPrice !== undefined) ret.costPrice = ret.costPrice / 100;
        return ret;
      }
    },
    toObject: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret.__v;
        delete ret.version;
        if (ret.price !== undefined) ret.price = ret.price / 100;
        if (ret.costPrice !== undefined) ret.costPrice = ret.costPrice / 100;
        return ret;
      }
    }
  }
);

// ===== VIRTUALS =====
productSchema.virtual('profitMargin').get(function () {
  const price = this.price / 100;
  const cost = this.costPrice / 100;
  if (price === 0) return 0;
  return (((price - cost) / price) * 100).toFixed(2);
});

// ===== INDEXES (Production-Critical — must be built via migration) =====

// 1. PRIMARY QUERY: Active products by store + category, sorted by name
productSchema.index({ storeId: 1, isActive: 1, category: 1, name: 1 });

// 2. TEXT SEARCH: name, sku, barcode scoped to store
productSchema.index(
  { storeId: 1, name: 'text', sku: 'text', barcode: 'text' },
  {
    weights: { name: 10, sku: 5, barcode: 3 },
    name: 'product_text_search_idx'
  }
);

// 3. BARCODE SCANNING: Instant lookup at checkout
productSchema.index({ storeId: 1, barcode: 1, isActive: 1 });

// 4. SKU UNIQUENESS (Soft-Delete Aware)
productSchema.index(
  { storeId: 1, sku: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true }
  }
);

// 5. LOW STOCK ALERTS (now uses isLowStock boolean field)
productSchema.index({ storeId: 1, isActive: 1, isLowStock: 1, stock: 1 });

// 6. TIMESTAMP QUERIES (for sync/replication)
productSchema.index({ storeId: 1, updatedAt: -1 });

// 7. TTL: Auto-purge soft-deleted products after 90 days
// Requires MongoDB 5.0+ for partial TTL; otherwise use a cron job
productSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 90 * 24 * 60 * 60,
    partialFilterExpression: { isActive: false }
  }
);

// ===== STATIC METHODS =====

productSchema.statics.findByBarcode = function (barcode, storeId = 'default') {
  if (!barcode || typeof barcode !== 'string') return null;
  return this.findOne({
    storeId,
    barcode: barcode.trim(),
    isActive: true
  }).populate('category', 'name icon color').lean();
};

/**
 * Atomic stock decrement with automatic isLowStock sync.
 * Uses $inc to eliminate read-modify-write races.
 */
productSchema.statics.decrementStock = async function (productId, quantity, session) {
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return { success: false, error: 'Invalid product ID' };
  }
  if (quantity <= 0) {
    return { success: false, error: 'Quantity must be positive' };
  }

  const result = await this.findOneAndUpdate(
    {
      _id: productId,
      isActive: true,
      stock: { $gte: quantity }
    },
    {
      $inc: { stock: -quantity, version: 1 },
      $set: { updatedAt: new Date() }
    },
    {
      new: true,
      session,
      runValidators: false // $inc bypasses validators anyway; guard is in query
    }
  ).populate('category', 'name icon color');

  if (!result) {
    return { success: false, error: 'Insufficient stock or product not found' };
  }

  // Sync isLowStock flag (non-blocking; if it fails, data is still correct)
  const shouldBeLow = result.stock <= result.lowStockThreshold;
  if (result.isLowStock !== shouldBeLow) {
    result.isLowStock = shouldBeLow;
    await result.save({ session }).catch(err => {
      console.error('isLowStock sync failed:', err.message);
    });
  }

  return { success: true, product: result };
};

/**
 * Atomic stock increment (returns/restocking).
 */
productSchema.statics.incrementStock = async function (productId, quantity, session) {
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return { success: false, error: 'Invalid product ID' };
  }
  if (quantity <= 0) {
    return { success: false, error: 'Quantity must be positive' };
  }

  const result = await this.findOneAndUpdate(
    { _id: productId, isActive: true },
    {
      $inc: { stock: quantity, version: 1 },
      $set: { updatedAt: new Date() }
    },
    {
      new: true,
      session,
      runValidators: false
    }
  ).populate('category', 'name icon color');

  if (!result) {
    return { success: false, error: 'Product not found' };
  }

  const shouldBeLow = result.stock <= result.lowStockThreshold;
  if (result.isLowStock !== shouldBeLow) {
    result.isLowStock = shouldBeLow;
    await result.save({ session }).catch(err => {
      console.error('isLowStock sync failed:', err.message);
    });
  }

  return { success: true, product: result };
};

// ===== PRE/POST MIDDLEWARE =====
productSchema.pre('save', function (next) {
  if (this.sku) this.sku = this.sku.toUpperCase().trim();
  if (this.barcode) this.barcode = this.barcode.trim();
  if (this.name) this.name = this.name.trim();
  
  // Convert dollar input to cents on creation
  if (this.isModified('price') && this.price !== undefined) {
    this.price = Math.round(this.price * 100);
  }
  if (this.isModified('costPrice') && this.costPrice !== undefined) {
    this.costPrice = Math.round(this.costPrice * 100);
  }
  
  // Sync flag on creation
  this.isLowStock = this.stock <= this.lowStockThreshold;
  
  next();
});

productSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate();
  if (!update) return next();

  // Handle uppercase on updates
  if (update.sku) update.sku = update.sku.toUpperCase().trim();
  if (update.barcode) update.barcode = update.barcode.trim();
  if (update.name) update.name = update.name.trim();

  // Convert dollar input to cents on update
  if (update.price !== undefined) update.price = Math.round(update.price * 100);
  if (update.costPrice !== undefined) update.costPrice = Math.round(update.costPrice * 100);

  next();
});

module.exports = mongoose.model('Product', productSchema);