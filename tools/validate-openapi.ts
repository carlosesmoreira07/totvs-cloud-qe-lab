import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specPath = path.join(repositoryRoot, 'specs/openapi/cloud-control-plane.yaml');
const api = (await SwaggerParser.validate(specPath)) as {
  openapi: string;
  info: { title: string; version: string };
};

console.log(`OpenAPI ${api.openapi} valid: ${api.info.title} v${api.info.version}`);
