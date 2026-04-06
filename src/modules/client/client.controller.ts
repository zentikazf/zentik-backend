import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards';
import { ClientService } from './client.service';
import { CreateClientDto, UpdateClientDto } from './dto';
import { CreateClientUserDto } from './dto/create-client-user.dto';

@ApiTags('Clients')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('organizations/:orgId/clients')
export class ClientController {
  constructor(private readonly clientService: ClientService) {}

  @Post()
  @ApiOperation({ summary: 'Crear un cliente' })
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('orgId') orgId: string,
    @Body() dto: CreateClientDto,
  ) {
    return this.clientService.create(orgId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar clientes de la organizacion' })
  findAll(
    @Param('orgId') orgId: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.clientService.findAll(orgId, {
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      status,
    });
  }

  @Get(':clientId')
  @ApiOperation({ summary: 'Detalle de un cliente' })
  findById(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
  ) {
    return this.clientService.findById(orgId, clientId);
  }

  @Patch(':clientId')
  @ApiOperation({ summary: 'Actualizar un cliente' })
  update(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() dto: UpdateClientDto,
  ) {
    return this.clientService.update(orgId, clientId, dto);
  }

  @Patch(':clientId/status')
  @ApiOperation({ summary: 'Cambiar estado del cliente (ACTIVE, DISABLED, ARCHIVED)' })
  changeStatus(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() body: { status: 'ACTIVE' | 'DISABLED' | 'ARCHIVED' },
  ) {
    return this.clientService.changeStatus(orgId, clientId, body.status);
  }

  @Delete(':clientId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archivar un cliente (soft-delete)' })
  remove(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
  ) {
    return this.clientService.changeStatus(orgId, clientId, 'ARCHIVED');
  }

  @Post(':clientId/create-user')
  @ApiOperation({ summary: 'Crear usuario de acceso portal para un cliente' })
  @HttpCode(HttpStatus.CREATED)
  createUser(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() dto: CreateClientUserDto,
  ) {
    return this.clientService.createClientUser(orgId, clientId, dto);
  }

  // ── Portal toggle ──────────────────────────────────────

  @Patch(':clientId/portal')
  @ApiOperation({ summary: 'Habilitar o deshabilitar portal de un cliente' })
  togglePortal(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() body: { enabled: boolean },
  ) {
    return this.clientService.togglePortal(orgId, clientId, body.enabled);
  }

  // ── Sub-usuarios ──────────────────────────────────────

  @Post(':clientId/users')
  @ApiOperation({ summary: 'Crear sub-usuario para un cliente' })
  @HttpCode(HttpStatus.CREATED)
  createSubUser(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() dto: CreateClientUserDto,
  ) {
    return this.clientService.createSubUser(orgId, clientId, dto);
  }

  @Get(':clientId/users')
  @ApiOperation({ summary: 'Listar sub-usuarios de un cliente' })
  listSubUsers(@Param('clientId') clientId: string) {
    return this.clientService.listSubUsers(clientId);
  }

  @Delete(':clientId/users/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar sub-usuario de un cliente' })
  deleteSubUser(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('userId') userId: string,
  ) {
    return this.clientService.deleteSubUser(orgId, clientId, userId);
  }

  // ── Horas contratadas ─────────────────────────────────

  @Get(':clientId/hours')
  @ApiOperation({ summary: 'Resumen de horas contratadas del cliente' })
  getHoursSummary(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
  ) {
    return this.clientService.getHoursSummary(orgId, clientId);
  }

  @Post(':clientId/hours')
  @ApiOperation({ summary: 'Agregar horas contratadas a un cliente' })
  @HttpCode(HttpStatus.CREATED)
  addHours(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() body: { hours: number; note?: string },
  ) {
    return this.clientService.addHours(orgId, clientId, body.hours, body.note);
  }
}
