import { Module } from '@nestjs/common';
import { TimeTrackingController } from './time-tracking.controller';
import {
  TimeEntryService,
  TimeReportService,
} from './time-tracking.service';
import { TimeEntryListener } from './time-tracking.listener';

@Module({
  controllers: [TimeTrackingController],
  providers: [TimeEntryService, TimeReportService, TimeEntryListener],
  exports: [TimeEntryService, TimeReportService],
})
export class TimeTrackingModule {}
