import { Module } from '@nestjs/common';
import { ReportController } from './report.controller';
import { ReportService, MetricsAggregator } from './report.service';

@Module({
  controllers: [ReportController],
  providers: [ReportService, MetricsAggregator],
  exports: [ReportService, MetricsAggregator],
})
export class ReportModule {}
