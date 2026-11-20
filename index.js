import express from 'express';
import app from './server/src/app.js';
import { registerProcessErrorHandlers } from './server/src/config/processHandlers.js';

registerProcessErrorHandlers();

// Vercel's Express builder only accepts an entry file that imports express.
void express;

export default app;
