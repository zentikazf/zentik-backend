import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { FilePermissionsService } from './file.permissions';

@Module({
  imports: [
    MulterModule.register({
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    }),
  ],
  controllers: [FileController],
  providers: [FileService, FilePermissionsService],
  exports: [FileService, FilePermissionsService],
})
export class FileModule {}
