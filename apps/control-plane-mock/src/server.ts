import { createServer } from 'node:http';
import type { NatsConnection } from 'nats';
import { createRequestHandler } from './app.js';
import { ControlPlaneStore } from './store.js';
import { PostgresControlPlaneStore } from './postgres-store.js';
import { connectNats, ensureStream } from './nats-jetstream.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { EventConsumer } from './consumer.js';
import type { ControlPlaneStoreInterface } from './domain.js';

const port = Number(process.env.PORT ?? 4010);
const host = process.env.HOST ?? '127.0.0.1';

let store: ControlPlaneStoreInterface;
let nc: NatsConnection | undefined;
let publisher: OutboxPublisher | undefined;
let consumer: EventConsumer | undefined;
let postgresStore: PostgresControlPlaneStore | undefined;

if (process.env.DATABASE_URL) {
  console.log('[LAB] Inicializando PostgresControlPlaneStore...');
  postgresStore = new PostgresControlPlaneStore({ connectionString: process.env.DATABASE_URL });
  await postgresStore.ensureSchema();
  store = postgresStore;

  const natsUrl = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
  try {
    console.log(`[LAB] Conectando ao NATS JetStream em ${natsUrl}...`);
    nc = await connectNats({ servers: natsUrl });
    await ensureStream(nc);
    publisher = new OutboxPublisher(postgresStore.getPool(), nc);
    consumer = new EventConsumer(postgresStore.getPool(), nc);

    if (process.env.ENABLE_WORKERS !== 'false') {
      console.log('[LAB] Iniciando OutboxPublisher e EventConsumer...');
      publisher.start();
      await consumer.start();
    }
  } catch (error) {
    console.warn('[LAB] NATS não disponível ou erro de inicialização:', error);
  }
} else {
  console.log('[LAB] DATABASE_URL não definida, usando ControlPlaneStore em memória.');
  store = new ControlPlaneStore();
}

const server = createServer(createRequestHandler(store));

server.listen(port, host, () => {
  console.log(`cloud-control-plane-mock listening on http://${host}:${port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  publisher?.stop();
  if (consumer) {
    await consumer.stop();
  }
  if (nc) {
    await nc.close();
  }
  if (postgresStore) {
    await postgresStore.close();
  }
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
