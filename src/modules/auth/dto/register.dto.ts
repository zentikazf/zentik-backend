import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'john@company.com', description: 'Correo electronico del usuario' })
  @IsEmail({}, { message: 'El correo electronico no es valido' })
  email: string;

  @ApiProperty({ example: 'SecureP@ss123', description: 'Contrasena (minimo 8 caracteres)' })
  @IsString()
  @MinLength(8, { message: 'La contrasena debe tener al menos 8 caracteres' })
  @MaxLength(100, { message: 'La contrasena no puede exceder 100 caracteres' })
  password: string;

  @ApiProperty({ example: 'John Doe', description: 'Nombre completo del usuario' })
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name: string;
}
