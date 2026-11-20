import express from 'express';
import app from '../server/src/app.js';
import { registerProcessErrorHandlers } from '../server/src/config/processHandlers.js';

registerProcessErrorHandlers();

// Vercel looks in the output directory "public" for a file that imports express.
void express;

export default app;
