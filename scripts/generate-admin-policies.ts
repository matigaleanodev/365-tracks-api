// Regenera deploy/admin/*.json desde infra/delivery.ts. Solo escribe archivos locales.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { adminDocuments } from '../infra/admin-documents.ts';

const directory = fileURLToPath(new URL('../deploy/admin/', import.meta.url));
mkdirSync(directory, { recursive: true });
for (const [name, document] of Object.entries(adminDocuments())) {
  writeFileSync(`${directory}${name}`, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`deploy/admin/${name}`);
}
