import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { BotmakerBillingService } from './botmaker-billing.service';
import { BillingVariablesService } from './billing-variables.service';
import { EXCHANGE_RATE_PROVIDER, ExchangeRateProvider } from './exchange-rate/exchange-rate.provider';
import { UpsertVariablesDto } from './dto/upsert-variables.dto';

/**
 * Endpoints admin de variables de facturación (#23). TODOS gateados por `manage:billing` (R7 AC2). El
 * crudo de Botmaker vive SOLO acá; el portal usa `/portal/variables` (solo comerciales, scopeado por cliente).
 */
@ApiTags('Botmaker Billing')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Controller('organizations/:orgId')
export class BotmakerBillingController {
  constructor(
    private readonly botmaker: BotmakerBillingService,
    private readonly variables: BillingVariablesService,
    @Inject(EXCHANGE_RATE_PROVIDER) private readonly exchangeRate: ExchangeRateProvider,
  ) {}

  // ── Mapeo: select de cuentas Botmaker ─────────────────────────────────────

  @Get('billing/botmaker/accounts')
  @Permissions('manage:billing')
  @ApiOperation({ summary: 'Cuentas Botmaker normalizadas para el select de mapeo (marca las ya mapeadas)' })
  listAccounts(@Param('orgId') orgId: string, @Query('period') period: string) {
    return this.botmaker.listAccounts(orgId, period);
  }

  // ── Tasa de cambio sugerida (prefill del preview, editable a mano) ─────────

  @Get('billing/exchange-rate/suggest')
  @Permissions('manage:billing')
  @ApiOperation({ summary: 'Tasa USD→PYG sugerida (simulada v1) para prellenar el preview de generación' })
  async suggestRate(@Query('date') date?: string) {
    const at = date ? new Date(date) : new Date();
    const rate = await this.exchangeRate.getRate(at, 'USD', 'PYG');
    return { rate, date: at.toISOString(), from: 'USD', to: 'PYG' };
  }

  // ── CRUD del statement de variables ───────────────────────────────────────

  @Get('clients/:clientId/billing/variables')
  @Permissions('manage:billing')
  @ApiOperation({ summary: 'Meses con variables del cliente' })
  listVariables(@Param('orgId') orgId: string, @Param('clientId') clientId: string) {
    return this.variables.list(orgId, clientId);
  }

  // Ruta de 3 segmentos (variables/:period/import) → declarada ANTES del GET de 2 segmentos.
  @Get('clients/:clientId/billing/variables/:period/import')
  @Permissions('manage:billing')
  @ApiOperation({ summary: 'Prellenar el editor con el consumo de Botmaker de la cuenta mapeada (no persiste)' })
  async importVariables(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('period') period: string,
  ) {
    // Valida el cliente dentro de la org y trae su cuenta mapeada (404 si no existe el cliente).
    const { botmakerAccountId } = await this.variables.resolveClientAccount(orgId, clientId);
    const imported = await this.botmaker.importVariables(botmakerAccountId ?? '', period);
    // #23: arrastra el contrato (reglas de precio) de la última statement → el comercial se calcula solo.
    return this.variables.applyContractRules(clientId, imported);
  }

  @Get('clients/:clientId/billing/variables/:period')
  @Permissions('manage:billing')
  @ApiOperation({ summary: 'Statement de variables de un período (items USD + total comercial)' })
  getVariables(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('period') period: string,
  ) {
    return this.variables.get(orgId, clientId, period);
  }

  @Post('clients/:clientId/billing/variables/:period')
  @Permissions('manage:billing')
  @ApiOperation({ summary: 'Guardar (upsert) el statement de variables del período' })
  upsertVariables(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('period') period: string,
    @Body() dto: UpsertVariablesDto,
  ) {
    return this.variables.upsert(orgId, clientId, period, dto);
  }

  @Delete('clients/:clientId/billing/variables/:period')
  @Permissions('manage:billing')
  @ApiOperation({ summary: 'Eliminar el statement de variables del período' })
  removeVariables(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('period') period: string,
  ) {
    return this.variables.remove(orgId, clientId, period);
  }
}
