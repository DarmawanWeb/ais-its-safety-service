import { DETECTOR_ENV } from '@darmawanweb/ais-its-nest/analytics';
import { ACCESS_TOKEN_KEY_RESOLVER } from '@darmawanweb/ais-its-nest/auth';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import {
  buildTestApp,
  createTestConfig,
  createTestJwtIssuer,
  type TestJwtIssuer,
  type TestTokenClaims,
  uniqueName,
  waitFor,
} from '@darmawanweb/ais-its-nest/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inject } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { type Config, configSchema } from '../../src/config.js';
import { OPENAPI } from '../../src/openapi.options.js';
import { SERVICE } from '../../src/service.js';

/** Options of {@link startTestService}. */
export interface TestServiceOptions {
  /** Service variables (spec §4 and `src/config.ts`). */
  readonly env?: Readonly<Record<string, string>>;
  /** `DETECTORS` and `<ID>_*` variables of the Detector SDK. */
  readonly detectorEnv?: Readonly<Record<string, string>>;
  /** Durable consumer name prefix; default: unique per call. */
  readonly durablePrefix?: string;
}

/** The real application on the shared containers, with a test token issuer. */
export interface TestService {
  readonly app: NestFastifyApplication;
  readonly config: Config;
  readonly jwt: TestJwtIssuer;
  /** `Authorization` header with a freshly signed access token. */
  authorization(claims?: TestTokenClaims): Promise<{ authorization: string }>;
  /**
   * Waits until the durable consumer `name` (without prefix) of `stream`
   * acknowledged the message stored at `ack.seq` (its handlers settled).
   */
  processed(
    stream: string,
    name: string,
    ack: { readonly seq: number },
  ): Promise<void>;
}

/**
 * Builds and initializes the AppModule as `bootstrapService()` does (hooks
 * run: migrations apply, streams and consumers start) without listening; use
 * `app.inject()` and close it with `app.close()`.
 */
export async function startTestService(
  options: TestServiceOptions = {},
): Promise<TestService> {
  const infra = inject('infra');
  const jwt = await createTestJwtIssuer();
  const durablePrefix = options.durablePrefix ?? `${uniqueName('t')}-`;
  const config = createTestConfig(configSchema, {
    SERVICE_NAME: SERVICE.name,
    DATABASE_URL: infra.databaseUrl,
    DATABASE_SCHEMA: SERVICE.schema,
    DB_MIGRATE_ON_BOOT: 'true',
    NATS_URL: infra.natsUrl,
    NATS_DURABLE_PREFIX: durablePrefix,
    SAFETY_STATE_FLUSH_MS: '50',
    ...options.env,
  });
  const app = await buildTestApp(AppModule, {
    config,
    openapi: OPENAPI,
    overrides: [
      { provide: ACCESS_TOKEN_KEY_RESOLVER, useValue: jwt.keyResolver },
      { provide: DETECTOR_ENV, useValue: { ...options.detectorEnv } },
    ],
  });
  return {
    app,
    config,
    jwt,
    authorization: async (claims) => ({
      authorization: `Bearer ${await jwt.sign(claims)}`,
    }),
    processed: async (stream, name, ack) => {
      const { manager } = app.get(NatsClient);
      await waitFor(
        async () => {
          const info = await manager.consumers.info(
            stream,
            `${durablePrefix}${name}`,
          );
          return info.ack_floor.stream_seq >= ack.seq &&
            info.num_ack_pending === 0
            ? true
            : undefined;
        },
        { timeoutMs: 20_000 },
      );
    },
  };
}
