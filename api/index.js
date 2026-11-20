import app from '../server/src/app.js';
import { registerProcessErrorHandlers } from '../server/src/config/processHandlers.js';

registerProcessErrorHandlers();

export default function handler(req, res) {
  return app(req, res);
}
