import { IsEmail, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'john@company.com', description: 'Correo electronico del usuario' })
  @IsEmail({}, { message: 'El correo electronico no es valido' })
  email: string;

  @ApiProperty({ example: 'SecureP@ss123', description: 'Contrasena del usuario' })
  @IsString({ message: 'La contrasena es requerida' })
  password: string;
}
