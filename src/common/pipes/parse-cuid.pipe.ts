import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

const CUID_REGEX = /^c[a-z0-9]{24}$/;
const CUID2_REGEX = /^[a-z0-9]{24,32}$/;

@Injectable()
export class ParseCuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!CUID_REGEX.test(value) && !CUID2_REGEX.test(value)) {
      throw new BadRequestException(`"${value}" no es un CUID válido`);
    }
    return value;
  }
}
