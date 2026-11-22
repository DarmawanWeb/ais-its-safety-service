import { SanitizedDatabaseError } from '@darmawanweb/ais-its-nest/db';
import type { OrderedConsumers } from '@darmawanweb/ais-its-nest/nats';
import { createTestConfig } from '@darmawanweb/ais-its-nest/testing';
import { Logger } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configSchema } from '../config.js';
import { testMetrics } from '../detectors/__testing__/fakes.js';
import { ProjectionRebuildService } from './projection-rebuild.service.js';
import type { ProjectionsConsumer } from './projections.consumer.js';
import type { VesselsRepository } from './vessels.repository.js';
import type { ZonesRepository } from './zones.repository.js';

const ZONE_ID = '0195f3c4-0000-7000-8000-000000000000';

/** What drizzle 0.45 throws for a failed statement: the SQL and every bound value in the message. */
function statementTimeout(): DrizzleQueryError {
  const driverError = Object.assign(
    new Error('canceling statement due to statement timeout'),
    { code: '57014', severity: 'ERROR' },
  );
  return new DrizzleQueryError(
    'delete from "safety"."zones" where ("zones"."updated_at" < $1 and NOT ("zones"."id" = ANY (SELECT jsonb_array_elements_text($2::jsonb)::uuid))) returning "id"',
    ['2026-11-22T20:47:59.872Z', JSON.stringify([ZONE_ID])],
    driverError,
  );
}

function setup(zonesDeleteAbsent: () => Promise<number>) {
  const ordered = {
    start: () =>
      Promise.resolve({
        caughtUp: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      }),
  } as unknown as OrderedConsumers;
  const metrics = testMetrics();
  const rebuilds = vi.spyOn(metrics.projectionRebuilds, 'inc');
  const service = new ProjectionRebuildService(
    ordered,
    {} as unknown as ProjectionsConsumer,
    { deleteAbsent: zonesDeleteAbsent } as unknown as ZonesRepository,
    { deleteAbsent: () => Promise.resolve(0) } as unknown as VesselsRepository,
    metrics,
    createTestConfig(configSchema, {}),
  );
  return { service, rebuilds };
}

describe('ProjectionRebuildService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a failed rebuild without the bound values of the statement', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, rebuilds } = setup(() =>
      Promise.reject(statementTimeout()),
    );

    await service.onApplicationBootstrap();

    expect(rebuilds).toHaveBeenCalledWith({
      projection: 'zones',
      outcome: 'failed',
    });
    expect(rebuilds).toHaveBeenCalledWith({
      projection: 'vessels',
      outcome: 'ok',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [entry] = warn.mock.calls[0] as [{ msg: string; err: unknown }];
    expect(entry.msg).toBe(
      'Rebuilding the zones projection from GEO failed (the durable consumer keeps it current): canceling statement due to statement timeout',
    );
    expect(entry.err).toBeInstanceOf(SanitizedDatabaseError);
    expect(entry.err).toMatchObject({
      message: 'canceling statement due to statement timeout',
      code: '57014',
    });
    expect(entry.err).not.toHaveProperty('params');
    const logged = `${entry.msg} ${JSON.stringify(entry.err)} ${String((entry.err as Error).stack)}`;
    expect(logged).not.toContain(ZONE_ID);
    expect(logged).not.toContain('params:');
  });
});
