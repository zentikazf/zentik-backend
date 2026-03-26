import { IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'john@company.com', description: 'Correo electronico asociado a la cuenta' })
  @IsEmail({}, { message: 'El correo electronico no es valido' })
  email: string;
}
