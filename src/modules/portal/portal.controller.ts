import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards';
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { PortalService } from './portal.service';
import { CreateSuggestionDto } from './dto/create-suggestion.dto';
import { UpdateSuggestionDto } from './dto/update-suggestion.dto';

@ApiTags('Portal')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class PortalController {
  constructor(private readonly portalService: PortalService) {}

  // ── Client Portal endpoints ──────────────────────────────

  @Get('portal/projects')
  @ApiOperation({ summary: 'Listar proyectos del cliente autenticado' })
  getProjects(@CurrentUser() user: AuthenticatedUser) {
    return this.portalService.getProjects(user.id);
  }

  @Get('portal/projects/:projectId')
  @ApiOperation({ summary: 'Detalle de proyecto con tareas visibles y progreso' })
  getProjectDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
  ) {
    return this.portalService.getProjectDetail(user.id, projectId);
  }

  @Get('portal/projects/:projectId/suggestions')
  @ApiOperation({ summary: 'Listar sugerencias del cliente en un proyecto' })
  getSuggestions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
  ) {
    return this.portalService.getSuggestions(user.id, projectId);
  }

  @Post('portal/projects/:projectId/suggestions')
  @ApiOperation({ summary: 'Crear una sugerencia en un proyecto' })
  createSuggestion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateSuggestionDto,
  ) {
    return this.portalService.createSuggestion(user.id, projectId, dto);
  }

  // ── Admin endpoints (PM/PO) ──────────────────────────────

  @Get('projects/:projectId/suggestions')
  @ApiOperation({ summary: 'Listar sugerencias de un proyecto (admin)' })
  getProjectSuggestions(@Param('projectId') projectId: string) {
    return this.portalService.getProjectSuggestions(projectId);
  }

  @Patch('projects/:projectId/suggestions/:suggestionId')
  @ApiOperation({ summary: 'Actualizar estado/notas de una sugerencia (admin)' })
  updateSuggestion(
    @Param('projectId') projectId: string,
    @Param('suggestionId') suggestionId: string,
    @Body() dto: UpdateSuggestionDto,
  ) {
    return this.portalService.updateSuggestion(projectId, suggestionId, dto);
  }

  @Post('projects/:projectId/suggestions/:suggestionId/convert')
  @ApiOperation({ summary: 'Convertir sugerencia en tarea (admin)' })
  convertToTask(
    @Param('projectId') projectId: string,
    @Param('suggestionId') suggestionId: string,
  ) {
    return this.portalService.convertToTask(projectId, suggestionId);
  }
}
