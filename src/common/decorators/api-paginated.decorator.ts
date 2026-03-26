import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';

export function ApiPaginated() {
  return applyDecorators(
    ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' }),
    ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' }),
    ApiQuery({ name: 'sort', required: false, type: String, description: 'Sort field (prefix - for desc)' }),
    ApiQuery({ name: 'search', required: false, type: String, description: 'Full-text search query' }),
  );
}
