let registered = false;

/**
 * Defence in depth. Request-path errors are already routed to the central error handler by
 * utils/asyncRouter.js; this keeps a stray promise rejection elsewhere (e.g. a fire-and-forget call)
 * from terminating the process (Node's default since v15). It is logged so it can be fixed at the source.
 *
 * uncaughtException is intentionally NOT swallowed: after a synchronous throw outside request
 * handling, the process state is undefined and Node recommends exiting and restarting.
 */
export function registerProcessErrorHandlers() {
  if (registered) return;
  registered = true;
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection] (process kept alive)', reason);
  });
}
