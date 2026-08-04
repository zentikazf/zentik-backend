import {
  IsString,
  IsOptional,
  Matches,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * `businessHoursStart` tiene que ser ANTERIOR a `businessHoursEnd` (#42, hallazgo
 * A1 del review).
 *
 * Un horario invertido (o de duracion cero) significa CERO minutos habiles por dia,
 * y `calculateBusinessDeadline` no tendria como avanzar: hoy hay un guard que corta
 * el bucle, pero el dato igual es invalido y dejaba deadlines sin sentido. La
 * validacion existia SOLO en el cliente, asi que un PATCH directo a la API la
 * esquivaba y persistia la config rota para toda la organizacion.
 */
@ValidatorConstraint({ name: 'businessHoursRange', async: false })
class BusinessHoursRangeConstraint implements ValidatorConstraintInterface {
  validate(end: string, args: ValidationArguments): boolean {
    const dto = args.object as UpsertBusinessHoursDto;
    const toMinutes = (value: string): number | null => {
      const match = /^(\d{2}):(\d{2})$/.exec(value ?? '');
      if (!match) return null; // el @Matches ya reporta el formato; no duplicar el error
      return Number(match[1]) * 60 + Number(match[2]);
    };
    const start = toMinutes(dto.businessHoursStart);
    const finish = toMinutes(end);
    if (start === null || finish === null) return true;
    return finish > start;
  }

  defaultMessage(): string {
    return 'La hora de fin debe ser posterior a la de inicio';
  }
}

export class UpsertBusinessHoursDto {
  @ApiProperty({ example: '08:30' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'Formato de hora inválido, usar HH:MM' })
  businessHoursStart: string;

  @ApiProperty({ example: '17:30' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'Formato de hora inválido, usar HH:MM' })
  @Validate(BusinessHoursRangeConstraint)
  businessHoursEnd: string;

  @ApiProperty({ example: '1,2,3,4,5', description: '1=Lun...7=Dom' })
  @IsString()
  @Matches(/^[1-7](,[1-7])*$/, { message: 'Formato de días inválido' })
  businessDays: string;

  @ApiPropertyOptional({ example: 'America/Asuncion' })
  @IsOptional()
  @IsString()
  timezone?: string;
}
