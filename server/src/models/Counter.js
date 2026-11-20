import mongoose from 'mongoose';

/**
 * Named monotonic sequences (one document per sequence, e.g. _id "orderNumber").
 * Values are only ever changed with atomic $inc / $max updates, so they never move backwards.
 */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, min: 0 },
  },
  { collection: 'counters', versionKey: false, timestamps: true }
);

export const Counter = mongoose.model('Counter', counterSchema);
