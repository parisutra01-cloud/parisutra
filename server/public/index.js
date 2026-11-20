import express from 'express';
import app from '../src/app.js';
import { registerProcessErrorHandlers } from '../src/config/processHandlers.js';

registerProcessErrorHandlers();

void express;

export default app;
