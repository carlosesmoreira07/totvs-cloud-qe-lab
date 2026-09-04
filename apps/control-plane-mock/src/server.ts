import { createServer } from 'node:http';
import { createRequestHandler } from './app.js';

const port = Number(process.env.PORT ?? 4010);
const host = process.env.HOST ?? '127.0.0.1';
const server = createServer(createRequestHandler());

server.listen(port, host, () => {
  console.log(`cloud-control-plane-mock listening on http://${host}:${port}`);
});

function shutdown(signal: string): void {
  console.log(`received ${signal}, shutting down`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

