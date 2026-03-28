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
  ) {
    return this.clientService.findAll(orgId, {
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
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

  @Delete(':clientId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar un cliente' })
  remove(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
  ) {
    return this.clientService.delete(orgId, clientId);
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
}
