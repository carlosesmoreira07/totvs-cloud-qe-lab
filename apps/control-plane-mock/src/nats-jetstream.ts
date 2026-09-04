import {
  connect,
  JSONCodec,
  StringCodec,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
  type StreamInfo,
} from 'nats';

export const sc = StringCodec();
export const jc = JSONCodec();

export interface NatsConfig {
  servers?: string;
}

export async function connectNats(config?: NatsConfig): Promise<NatsConnection> {
  const servers = config?.servers ?? process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
  return connect({ servers });
}

export async function ensureStream(
  nc: NatsConnection,
  streamName = 'EVENTS',
  subjects = ['instance.provisioning.requested'],
): Promise<StreamInfo> {
  const jsm: JetStreamManager = await nc.jetstreamManager();
  try {
    const info = await jsm.streams.info(streamName);
    // Ensure subjects include all requested subjects
    const existingSubjects = new Set(info.config.subjects);
    const missingSubjects = subjects.filter((s) => !existingSubjects.has(s));
    if (missingSubjects.length > 0) {
      info.config.subjects = [...existingSubjects, ...missingSubjects];
      return await jsm.streams.update(streamName, info.config);
    }
    return info;
  } catch {
    return await jsm.streams.add({
      name: streamName,
      subjects,
    });
  }
}
