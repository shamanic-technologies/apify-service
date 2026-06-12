import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const generator = new OpenApiGeneratorV3(registry.definitions);
const doc = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "apify-service",
    version: "0.2.0",
    description:
      "Verified-email lead provider backed by the Apify waterfall (pipelinelabs + microworlds, clearpath inferred fallback). Replaces Apollo for lead search + verified email.",
  },
  servers: [{ url: "/" }],
});

const outPath = join(__dirname, "..", "openapi.json");
writeFileSync(outPath, JSON.stringify(doc, null, 2));
console.log(`[apify-service] OpenAPI spec written to ${outPath}`);
