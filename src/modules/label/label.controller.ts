import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards';
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { LabelService } from './label.service';
import { CreateLabelDto, UpdateLabelDto } from './dto';

@ApiTags('Labels')
@ApiCookieAuth()
@UseGuards(AuthGuard)
@Controller()
export class LabelController {
  constructor(private readonly labelService: LabelService) {}

  @Post('organizations/:orgId/labels')
  @ApiOperation({ summary: 'Crear una etiqueta en la organización' })
  @ApiResponse({ status: 201, description: 'Etiqueta creada' })
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('orgId') orgId: string,
    @Body() dto: CreateLabelDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.labelService.create(orgId, dto, user.id);
  }

  @Get('organizations/:orgId/labels')
  @ApiOperation({ summary: 'Listar etiquetas de la organización' })
  @ApiResponse({ status: 200, description: 'Lista de etiquetas' })
  async findAll(@Param('orgId') orgId: string) {
    return this.labelService.findAll(orgId);
  }

  @Patch('labels/:labelId')
  @ApiOperation({ summary: 'Actualizar una etiqueta' })
  @ApiResponse({ status: 200, description: 'Etiqueta actualizada' })
  async update(
    @Param('labelId') labelId: string,
    @Body() dto: UpdateLabelDto,
  ) {
    return this.labelService.update(labelId, dto);
  }

  @Delete('labels/:labelId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar una etiqueta' })
  @ApiResponse({ status: 204, description: 'Etiqueta eliminada' })
  async delete(@Param('labelId') labelId: string) {
    await this.labelService.delete(labelId);
  }
}
