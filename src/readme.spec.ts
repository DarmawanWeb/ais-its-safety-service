import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** The text of the README section that starts with `heading`, up to the next heading of any level. */
function section(heading: string): string {
  const start = README.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const rest = README.slice(start + heading.length + 2);
  const end = rest.search(/\n#{1,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('README handbook', () => {
  // The service supports rolling updates of several replicas, but the platform
  // chart still deploys one replica with `Recreate` (infra/helm/ais-its-platform).
  // Drop this check together with the README note once the chart is updated.
  it('does not present the rolling deployment as what the platform chart ships', () => {
    const deployment = section('### Deployment: replicas and failover');
    expect(deployment).toContain('two or more replicas with rolling updates');
    expect(deployment).toContain('**Platform chart: not updated yet.**');
    expect(deployment).toContain('`replicaCount: 1` and `strategy: Recreate`');
    expect(deployment).toContain('no hot standby');
  });
});
