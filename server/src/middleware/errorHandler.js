/**
 * Central error handling. Converts known error types into safe client responses and never sends
 * database messages, stack traces or internal details to the client. Full errors are logged server-side.
 */

const DB_ERROR_NAMES = new Set([
  'CastError',
  'ValidationError',
  'ValidatorError',
  'MongoServerError',
  'MongoError',
  'MongoBulkWriteError',
  'DocumentNotFoundError',
  'StrictModeError',
  'MongooseServerSelectionError',
  'MongoNetworkError',
]);

/** True for Mongo/Mongoose errors, whose messages must never be returned to clients verbatim. */
export function isDatabaseError(err) {
  return Boolean(err) && (DB_ERROR_NAMES.has(err.name) || err.code === 11000);
}

function fieldLabel(path) {
  if (!path || path === '_id') return 'id';
  return String(path);
}

function describeValidationError(err) {
  const errors = {};
  for (const [path, detail] of Object.entries(err.errors || {})) {
    const field = fieldLabel(path);
    if (detail?.kind === 'required') errors[field] = `${field} is required`;
    else if (detail?.kind === 'enum') errors[field] = `${field} has an invalid value`;
    else if (detail?.kind === 'min' || detail?.kind === 'max') errors[field] = `${field} is out of range`;
    else errors[field] = `${field} is invalid`;
  }
  return errors;
}

/** Maps an error to { status, body } with a client-safe message. */
export function toHttpError(err) {
  // Malformed / oversized JSON bodies from express.json()
  if (err?.type === 'entity.parse.failed') return { status: 400, body: { message: 'Malformed JSON body' } };
  if (err?.type === 'entity.too.large') return { status: 413, body: { message: 'Request body too large' } };

  if (err?.name === 'CastError') {
    return { status: 400, body: { message: `Invalid ${fieldLabel(err.path)}` } };
  }
  if (err?.name === 'ValidationError') {
    const errors = describeValidationError(err);
    return { status: 400, body: { message: 'Validation failed', errors } };
  }
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0];
    return {
      status: 409,
      body: { message: field ? `A record with this ${field} already exists` : 'Duplicate record' },
    };
  }
  if (isDatabaseError(err)) {
    return { status: 503, body: { message: 'Service temporarily unavailable' } };
  }

  // Application errors that deliberately carry a 4xx status (e.g. error.status = 400 in routes).
  const status = Number(err?.status || err?.statusCode);
  if (status >= 400 && status < 500) {
    return { status, body: { message: err.message || 'Request failed' } };
  }

  return { status: 500, body: { message: 'Server error' } };
}

/** JSON 404 for unknown API routes (instead of Express's default HTML page). */
export function notFoundHandler(req, res) {
  res.status(404).json({ message: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const { status, body } = toHttpError(err);
  if (status >= 500) {
    console.error(`[${req.method} ${req.originalUrl}]`, err);
  }
  if (res.headersSent) {
    // Too late to send a JSON error; let Express close the connection.
    return next(err);
  }
  res.status(status).json(body);
}
