// Generates src/detectors/ews/__fixtures__/legacy-ews-golden.json by running the
// legacy EWS rule (be-legacy/src/utils/calculate-ews.ts checkShipStatus) once.
//
// Not part of the build: it needs the legacy code and Turf.js 7.2.0, the
// versions locked in be-legacy/pnpm-lock.yaml. In an empty directory:
//   npm install @turf/distance@7.2.0 @turf/helpers@7.2.0 @turf/nearest-point-on-line@7.2.0 typescript
//   transpile be-legacy/src/utils/calculate-ews.ts verbatim (ts.transpileModule, ESM) to
//   ./calculate-ews.legacy.mjs, copy this script next to it, then
//   LEGACY_BE=/path/to/be-legacy node generate-ews-golden.mjs > legacy-ews-golden.json
import { readFileSync } from 'node:fs';
import { point } from '@turf/helpers';
import distance from '@turf/distance';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import { checkShipStatus } from './calculate-ews.legacy.mjs';

process.chdir(process.env.LEGACY_BE ?? '../be-legacy'); // checkShipStatus reads data/pipeline.json from the cwd
const pipeline = JSON.parse(
  readFileSync('data/pipeline.json', 'utf8'),
).pipeline;
const line = {
  type: 'LineString',
  coordinates: pipeline.map((p) => [p.Longitude, p.Latitude]),
};
// The distance exactly as checkShipStatus computes it internally (same turf calls).
const legacyDistance = (lat, lon) => {
  const pt = point([lon, lat]);
  return distance(pt, nearestPointOnLine(line, pt), { units: 'meters' });
};
const round = (v, d = 7) => Number(v.toFixed(d));
// Moves east (or west) from a base point until the legacy distance equals target (bisection on lon).
function atDistance(lat, lon, target, dir = 1) {
  let lo = 0,
    hi = 0.2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (legacyDistance(lat, lon + dir * mid) < target) lo = mid;
    else hi = mid;
  }
  return [lat, lon + (dir * (lo + hi)) / 2];
}
const cases = [];
const add = (label, lat, lon) => {
  lat = round(lat);
  lon = round(lon);
  cases.push({
    label,
    lat,
    lon,
    distanceM: legacyDistance(lat, lon),
    statusAnchored: checkShipStatus(lat, lon, 1),
    statusNotAnchored: checkShipStatus(lat, lon, 0),
  });
};
// Base points: mid-segment of KP 35.2 -> 36.2 and vertex KP 40.2, plus the zigzag and both ends.
const mid = [(-6.923544 + -6.931903) / 2, (112.70532 + 112.701848) / 2];
add('on vertex KP 36.200', pipeline[10].Latitude, pipeline[10].Longitude);
for (const [target, dir] of [
  [50, 1],
  [250, -1],
  [499.9, 1],
  [500.1, 1],
  [499.9, -1],
  [500.1, -1],
  [1000, 1],
  [1749.9, 1],
  [1750.1, 1],
  [1749.9, -1],
  [1750.1, -1],
  [3000, 1],
]) {
  const [lat, lon] = atDistance(mid[0], mid[1], target, dir);
  add(`${dir > 0 ? 'east' : 'west'} of KP 35.2-36.2 at ~${target} m`, lat, lon);
}
const v14 = [pipeline[14].Latitude, pipeline[14].Longitude];
for (const target of [400, 1200]) {
  const [lat, lon] = atDistance(v14[0], v14[1], target, 1);
  add(`east of vertex KP 40.200 at ~${target} m`, lat, lon);
}
add('inside the KP 42.2/42.72 zigzag', -7.01, 112.672);
add('near the KP 58.29 backtrack', -7.1325, 112.6545);
add('north of the KP 26.7 end (nearest = end point)', -6.8445, 112.7195);
add('south of the KP 59.85 end', -7.1478, 112.6575);
add('Surabaya approach, far from the line', -7.2, 112.73);
add('Madura Strait, ~20 km east', -6.95, 112.88);
const golden = {
  description:
    'Golden cases of the legacy EWS rule: be-legacy/src/utils/calculate-ews.ts checkShipStatus run once with @turf/distance, @turf/helpers and @turf/nearest-point-on-line 7.2.0 (be-legacy/pnpm-lock.yaml) against be-legacy/data/pipeline.json (61 points, file order). distanceM is the internal distance of checkShipStatus (same turf calls); statusAnchored = checkShipStatus(lat, lon, 1), statusNotAnchored = checkShipStatus(lat, lon, 0).',
  generatedAt: new Date().toISOString().slice(0, 10),
  pipeline: line,
  cases,
};
process.stdout.write(JSON.stringify(golden, null, 2) + '\n');
