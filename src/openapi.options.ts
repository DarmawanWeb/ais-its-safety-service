import type { OpenApiOptions } from '@darmawanweb/ais-its-nest';

import { SERVICE } from './service.js';

/** OpenAPI document of the service (`/docs`, `/openapi.json`, `pnpm openapi`). */
export const OPENAPI: OpenApiOptions = {
  title: `AIS Maritime Intelligence — ${SERVICE.title}`,
  version: SERVICE.version,
  description: SERVICE.description,
  tags: [
    {
      name: 'vessels',
      description:
        'Latest navigational safety state per vessel (EWS status, collision risk)',
    },
    {
      name: 'stats',
      description:
        'Counts of the vessels at risk among the safety states (dashboards)',
    },
    {
      name: 'events',
      description: 'Detector events (EWS, collision) and their lifecycle',
    },
    {
      name: 'encounters',
      description: 'Collision encounters with their CPA/TCPA history',
    },
    { name: 'detectors', description: 'Detectors of the Detector SDK' },
    {
      name: 'methodology',
      description: 'Methods of the methodology catalog implemented here',
    },
  ],
};
