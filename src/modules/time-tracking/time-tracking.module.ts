import { Module } from '@nestjs/common';
import { TimeTrackingController } from './time-tracking.controller';
import {
  TimeEntryService,
  TimerService,
  TimeReportService,
} from './time-tracking.service';

@Module({
  controllers: [TimeTrackingController],
  providers: [TimeEntryService, TimerService, TimeReportService],
  exports: [TimeEntryService, TimerService, TimeReportService],
})
export class TimeTrackingModule {}
