import { Module } from '@nestjs/common';
import { TimeTrackingController } from './time-tracking.controller';
import {
  TimeEntryService,
  TimerService,
  TimeReportService,
} from './time-tracking.service';
import { TimeEntryListener } from './time-tracking.listener';

@Module({
  controllers: [TimeTrackingController],
  providers: [TimeEntryService, TimerService, TimeReportService, TimeEntryListener],
  exports: [TimeEntryService, TimerService, TimeReportService],
})
export class TimeTrackingModule {}
