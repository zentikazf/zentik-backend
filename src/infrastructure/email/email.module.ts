import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { EmailInvitationService } from './email-invitation.service';

@Global()
@Module({
  providers: [EmailService, EmailInvitationService],
  exports: [EmailService, EmailInvitationService],
})
export class EmailModule {}
