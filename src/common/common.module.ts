import { Global, Module } from '@nestjs/common';

import { SafetyMetrics } from './safety.metrics.js';

/** Service-wide providers: the domain metrics. */
@Global()
@Module({
  providers: [SafetyMetrics],
  exports: [SafetyMetrics],
})
export class CommonModule {}
