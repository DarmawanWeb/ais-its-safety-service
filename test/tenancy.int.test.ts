import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  EVENT_TYPES,
  parseEnvelope,
  type SafetyVesselStateV1,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import {
  destinationPoint,
  FleetDirectory,
  makeTestVesselSnapshot,
  makeTestZone,
  toPositionPayload,
  ZoneIndex,
} from '@darmawanweb/ais-its-nest/analytics';
import { EventPublisher, NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestService, type TestService } from './support/test-service.js';

const ORG_P = newId(); // owns the pipeline zone and vessel VP
const ORG_Q = newId(); // owns vessel VQ
const ORG_R = newId(); // unrelated
const VP = 525_820_001;
const VQ = 525_820_002;
// A private pipeline along 107.00°E (2.55°S–2.45°S), away from the other test files.
const ON_LINE = { lat: -2.5, lon: 107.0 };
const PRIVATE = makeTestZone({
  kind: 'pipeline',
  orgId: ORG_P,
  code: 'secret-pipe-p',
  name: 'Confidential pipeline of org P',
  bufferM: 1750,
  geometry: {
    type: 'LineString',
    coordinates: [
      [107.0, -2.55],
      [107.0, -2.45],
    ],
  },
});
const BBOX = '106.9,-2.6,107.1,-2.4';

interface StateBody {
  mmsi: number;
  ewsStatus: number;
  nearestPipelineZoneId: string | null;
  nearestPipeline: { id: string; code: string; name: string } | null;
  pipelineDistanceM: number | null;
}

/**
 * Review finding (medium): org-owned pipeline zones are tenant-private
 * (spec §8.5). They apply to their organization's vessels only, and their
 * identity and distance never reach other tenants (REST, SAFETY, alerts).
 */
describe('org-owned pipeline zones (tenancy spec §8.5)', () => {
  let service: TestService;
  const publisher = () => service.app.get(EventPublisher);
  const manager = () => service.app.get(NatsClient).manager;
  const get = async (
    url: string,
    claims: Parameters<TestService['authorization']>[0],
  ) =>
    service.app.inject({
      method: 'GET',
      url,
      headers: await service.authorization(claims),
    });

  async function anchoredAt(mmsi: number, meters: number): Promise<void> {
    const { ack } = await publisher().publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      toPositionPayload({
        mmsi,
        time: new Date(),
        source: 'primary',
        ...destinationPoint(ON_LINE, 90, meters),
        sog: 0.1,
        cog: 0,
        hdg: 511,
        navstatus: 1,
        predictedNavstatus: 1,
        coastDistanceM: null,
        previous: null,
      }),
    );
    await service.processed('AIS_POSITION', 'safety-positions', ack);
  }

  async function published(mmsi: number): Promise<SafetyVesselStateV1> {
    return waitFor(
      async () => {
        const message = await manager().streams.getMessage('SAFETY', {
          last_by_subj: subjects.safetyState(mmsi),
        });
        const parsed = parseEnvelope(message?.data);
        return parsed.success &&
          parsed.envelope.type === EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED
          ? parsed.envelope.data
          : undefined;
      },
      { timeoutMs: 10_000, message: `SAFETY state of ${mmsi}` },
    );
  }

  async function alertsOf(mmsi: number): Promise<number> {
    const subject = subjects.alert('ews', mmsi);
    const info = await manager().streams.info('ALERTS', {
      subjects_filter: subject,
    });
    return info.state.subjects?.[subject] ?? 0;
  }

  beforeAll(async () => {
    service = await startTestService();
    for (const [mmsi, orgId] of [
      [VP, ORG_P],
      [VQ, ORG_Q],
    ] as const) {
      const { ack } = await publisher().publishEvent(
        EVENT_TYPES.FLEET_VESSEL_UPSERTED,
        makeTestVesselSnapshot({
          mmsi,
          orgId,
          name: `KM ${mmsi}`,
          updatedAt: new Date().toISOString(),
        }),
      );
      await service.processed('FLEET', 'safety-fleet', ack);
    }
    const { ack } = await publisher().publishEvent(
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      PRIVATE,
    );
    await service.processed('GEO', 'safety-zones', ack);
    await waitFor(
      () =>
        service.app.get(ZoneIndex).has(PRIVATE.id) &&
        service.app.get(FleetDirectory).byMmsi(VQ) !== undefined,
    );
  });

  afterAll(async () => {
    await publisher().publishEvent(EVENT_TYPES.GEO_ZONE_DELETED, {
      id: PRIVATE.id,
      orgId: ORG_P,
    });
    await service.app.close();
  });

  it('does not measure another organization’s vessel to the private pipeline', async () => {
    await anchoredAt(VQ, 1000);
    const state = await published(VQ);
    expect(state.ewsStatus).toBe(3);
    expect(state.nearestPipelineZoneId).not.toBe(PRIVATE.id);
    expect(await alertsOf(VQ)).toBe(0);
  });

  it('warns the owner’s vessel without exposing the zone to other tenants', async () => {
    await anchoredAt(VP, 1000);
    const alert = await waitFor(async () => {
      const message = await manager().streams.getMessage('ALERTS', {
        last_by_subj: subjects.alert('ews', VP),
      });
      const parsed = parseEnvelope(message?.data);
      return parsed.success && parsed.envelope.type === EVENT_TYPES.ALERT_RAISED
        ? parsed.envelope.data
        : undefined;
    });
    expect(alert).toMatchObject({
      severity: 'warning',
      mmsi: VP,
      zoneId: PRIVATE.id,
    });
    expect(alert.data).not.toHaveProperty('orgId');
    expect(alert.data).not.toHaveProperty('orgIds');

    // The shared SAFETY stream carries the status, not the private zone.
    const shared = await waitFor(async () => {
      const state = await published(VP);
      return state.ewsStatus === 1 ? state : undefined;
    });
    expect(shared).toMatchObject({
      nearestPipelineZoneId: null,
      pipelineDistanceM: null,
    });

    // REST: the owner and authorities see the zone, other tenants only the status.
    const viewer = (orgId: string) => ({ roles: ['viewer'] as const, orgId });
    const owner = (
      await get(`/api/v2/safety/vessels/${VP}`, viewer(ORG_P))
    ).json<StateBody>();
    expect(owner).toMatchObject({
      ewsStatus: 1,
      nearestPipelineZoneId: PRIVATE.id,
      nearestPipeline: { id: PRIVATE.id, code: PRIVATE.code },
    });
    expect(owner.pipelineDistanceM).toBeCloseTo(1000, 3);
    const authority = (
      await get(`/api/v2/safety/vessels/${VP}`, {
        roles: ['authority'],
        orgId: null,
      })
    ).json<StateBody>();
    expect(authority.nearestPipelineZoneId).toBe(PRIVATE.id);
    expect(authority.nearestPipeline?.name).toBe(PRIVATE.name);
    for (const claims of [
      viewer(ORG_R),
      viewer(ORG_Q),
      { roles: ['viewer'] as const, orgId: null },
    ]) {
      const other = (
        await get(`/api/v2/safety/vessels/${VP}`, claims)
      ).json<StateBody>();
      expect(other).toMatchObject({
        ewsStatus: 1,
        nearestPipelineZoneId: null,
        nearestPipeline: null,
        pipelineDistanceM: null,
      });
      const listed = (
        await get(`/api/v2/safety/vessels?bbox=${BBOX}&ewsStatus=1`, claims)
      ).json<StateBody[]>();
      expect(listed.find((state) => state.mmsi === VP)).toMatchObject({
        nearestPipelineZoneId: null,
        nearestPipeline: null,
        pipelineDistanceM: null,
      });
    }

    // The event belongs to the vessel's organization (and authorities) only.
    const events = async (orgId: string) =>
      (await get(`/api/v2/safety/events?mmsi=${VP}`, viewer(orgId))).json<{
        data: { zoneId: string; data: Record<string, unknown> }[];
      }>().data;
    expect(await events(ORG_Q)).toEqual([]);
    expect(await events(ORG_R)).toEqual([]);
    const [own] = await events(ORG_P);
    expect(own?.zoneId).toBe(PRIVATE.id);
    expect(own?.data).not.toHaveProperty('orgId');
  });
});
