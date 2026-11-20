import mongoose from 'mongoose';

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    title: String,
    image: String,
    unit: String,
    price: Number,
    quantity: { type: Number, required: true, min: 1 },
    variationId: mongoose.Schema.Types.ObjectId,
    variationLabel: String,
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    customerName: String,
    customerEmail: String,
    customerPhone: String,
    items: [orderItemSchema],
    subtotal: Number,
    shipping: { type: Number, default: 0 },
    total: Number,
    paymentMethod: { type: String, enum: ['paid', 'cod', 'razorpay'], default: 'cod' },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
    status: {
      type: String,
      enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
      default: 'pending',
    },
    shippingAddress: {
      fullName: String,
      phone: String,
      line1: String,
      line2: String,
      city: String,
      state: String,
      pincode: String,
    },
    notes: String,
    cancelledAt: Date,
    cancelledBy: { type: String, enum: ['customer', 'admin'] },
    // Durable record of stock actually reserved for this order (COD checkouts since Phase 5C/5D).
    // Cancellation restores exactly these lines, once: restoredAt is set in the same transaction
    // as the stock increments. Orders without reservedAt (older orders, Razorpay orders) never had
    // their deduction recorded, so their stock is not restored automatically.
    stockReservation: {
      reservedAt: Date,
      lines: {
        type: [{ product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, quantity: Number, _id: false }],
        default: undefined,
      },
      restoredAt: Date,
      missingProducts: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
    },
    razorpayOrderId: String,
    razorpayPaymentId: String,
  },
  { timestamps: true }
);

export const Order = mongoose.model('Order', orderSchema);
