import SwaggerParser from "@apidevtools/swagger-parser";
import { outputPath } from "./generate.ts";
await SwaggerParser.validate(outputPath);
process.stdout.write("OpenAPI schema and references valid\n");
