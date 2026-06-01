import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { EmailInvitationService } from './email-invitation.service';
import { AsyncEmailDispatcher } from './async-email-dispatcher.service';

@Global()
@Module({
  providers: [EmailService, EmailInvitationService, AsyncEmailDispatcher],
  exports: [EmailService, EmailInvitationService, AsyncEmailDispatcher],
})
export class EmailModule {}
