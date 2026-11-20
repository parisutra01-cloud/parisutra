// Child-process entry for API tests.
// Imports the real Express app WITHOUT loading dotenv: the harness passes a fully
// synthetic environment (see harness.js#buildServerEnv), so server/.env is never read.
const { default: app } = await import('../../src/app.js');

const server = app.listen(Number(process.env.PORT), '127.0.0.1', () => {
  process.stdout.write('PARISUTRA_TEST_API_READY\n');
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
