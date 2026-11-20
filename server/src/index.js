import 'dotenv/config';
import app from './app.js';
import { registerProcessErrorHandlers } from './config/processHandlers.js';

registerProcessErrorHandlers();

const PORT = process.env.PORT || 5050;

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
