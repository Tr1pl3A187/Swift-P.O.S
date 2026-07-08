const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    storeId: {
      type: String,
      required: true,
      index: true,
      trim: true,
      lowercase: true,
      default: 'default'
    },
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters']
    },
    icon: {
      type: String,
      default: '',
      trim: true,
      maxlength: [50, 'Icon cannot exceed 50 characters']
    },
    color: {
      type: String,
      default: '#3b82f6',
      trim: true,
      maxlength: [7, 'Color must be a valid hex code']
    },
    sortOrder: {
      type: Number,
      default: 0
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    }
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        delete ret.__v;
        return ret;
      }
    }
  }
);

// Unique category name per store
categorySchema.index({ storeId: 1, name: 1, isActive: 1 }, {
  unique: true,
  partialFilterExpression: { isActive: true }
});

module.exports = mongoose.model('Category', categorySchema);