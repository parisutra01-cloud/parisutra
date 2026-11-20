import { Router } from 'express';

/**
 * Express 4 does not catch rejected promises from async handlers: the rejection becomes an
 * unhandledRejection, which terminates the Node.js process (Node >= 15).
 * wrapAsync forwards both synchronous throws and async rejections to next(err), so they reach the
 * central error handler (middleware/errorHandler.js) instead.
 */
export function wrapAsync(fn) {
  // Leave non-functions and error-handling middleware (err, req, res, next) untouched.
  if (typeof fn !== 'function' || fn.length === 4) return fn;
  return function asyncSafeHandler(req, res, next) {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.then === 'function') {
        result.then(undefined, (err) => next(err ?? new Error('Async handler rejected without a reason')));
      }
    } catch (err) {
      next(err);
    }
  };
}

const ROUTE_METHODS = ['all', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'use'];

function wrapArgs(args) {
  return args.map((arg) => (Array.isArray(arg) ? wrapArgs(arg) : wrapAsync(arg)));
}

/** Drop-in replacement for express.Router() whose handlers and middleware are async-safe. */
export function asyncRouter(options) {
  const router = Router(options);
  for (const method of ROUTE_METHODS) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...wrapArgs(args));
  }
  return router;
}
