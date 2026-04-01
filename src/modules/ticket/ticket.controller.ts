import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards';
import { TicketService } from './ticket.service';
import { UpdateTicketDto } from './dto/update-ticket.dto';

@ApiTags('Tickets')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class TicketController {
  constructor(private readonly ticketService: TicketService) {}

  @Get('organizations/:orgId/tickets')
  @ApiOperation({ summary: 'Listar todos los tickets de la organizacion' })
  @ApiQuery({ name: 'status', required: false, enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] })
  getOrgTickets(
    @Param('orgId') orgId: string,
    @Query('status') status?: string,
  ) {
    return this.ticketService.getOrgTickets(orgId, status);
  }

  @Get('projects/:projectId/tickets')
  @ApiOperation({ summary: 'Listar tickets de un proyecto' })
  getProjectTickets(@Param('projectId') projectId: string) {
    return this.ticketService.getProjectTickets(projectId);
  }

  @Get('tickets/:ticketId')
  @ApiOperation({ summary: 'Detalle de un ticket' })
  getTicketDetail(@Param('ticketId') ticketId: string) {
    return this.ticketService.getTicketDetail(ticketId);
  }

  @Patch('tickets/:ticketId')
  @ApiOperation({ summary: 'Actualizar estado y notas de un ticket' })
  updateTicket(
    @Param('ticketId') ticketId: string,
    @Body() dto: UpdateTicketDto,
  ) {
    return this.ticketService.updateTicket(ticketId, dto);
  }
}
