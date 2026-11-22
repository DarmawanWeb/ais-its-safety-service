import {
  type AnyEventEnvelope,
  parseEnvelope,
} from '@darmawanweb/ais-its-contracts/events';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import type { INestApplication } from '@nestjs/common';

/**
 * The envelopes stored on one subject of the `ALERTS` stream, in stream
 * order (`alert.raised.v1` and `alert.resolved.v1` of a vessel share it).
 * Reads through a short-lived ordered consumer filtered by the subject.
 */
export async function alertEnvelopes(
  app: INestApplication,
  subject: string,
): Promise<AnyEventEnvelope[]> {
  const { jetstream, manager } = app.get(NatsClient);
  const info = await manager.streams.info('ALERTS', {
    subjects_filter: subject,
  });
  const stored = info.state.subjects?.[subject] ?? 0;
  if (stored === 0) return [];
  const consumer = await jetstream.consumers.get('ALERTS', {
    filter_subjects: [subject],
    inactive_threshold: 10_000,
  });
  const envelopes: AnyEventEnvelope[] = [];
  for (let read = 0; read < stored; read += 1) {
    const message = await consumer.next({ expires: 5_000 });
    if (message === null) break;
    const parsed = parseEnvelope(message.data);
    if (parsed.success) envelopes.push(parsed.envelope);
  }
  return envelopes;
}

/** The event types stored on one subject of `ALERTS`, in stream order. */
export async function alertTypes(
  app: INestApplication,
  subject: string,
): Promise<string[]> {
  return (await alertEnvelopes(app, subject)).map((envelope) => envelope.type);
}
