import { randomBytes } from 'node:crypto';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  assertSanitizedEnv,
  DUMMY_ACCESS_KEY_ID,
  DUMMY_REGION,
  DUMMY_SECRET_ACCESS_KEY,
} from './guard.ts';

/** Valida el entorno y devuelve el endpoint; lanza si no es el que arma el runner. */
export function integrationEnvironment() {
  return assertSanitizedEnv(process.env);
}

/**
 * Cliente de documentos con las mismas clases que la app, pero con endpoint, región y credenciales
 * explícitos (ficticios). Cada llamada crea un cliente distinto, con su propio pool de sockets.
 */
export function createDocClient(): DynamoDBDocumentClient {
  const { endpoint } = integrationEnvironment();
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint,
      region: DUMMY_REGION,
      credentials: { accessKeyId: DUMMY_ACCESS_KEY_ID, secretAccessKey: DUMMY_SECRET_ACCESS_KEY },
    }),
  );
}

/** Tabla temporal con el mismo esquema que `infra/tracks-api-stack.ts`. */
export async function createTestTable(client: DynamoDBDocumentClient): Promise<string> {
  const { runId } = integrationEnvironment();
  const tableName = `it365-${runId}-${randomBytes(4).toString('hex')}`;
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'date', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'date', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { Table } = await client.send(new DescribeTableCommand({ TableName: tableName }));
    if (Table?.TableStatus === 'ACTIVE') return tableName;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Table ${tableName} did not become ACTIVE`);
}

export async function deleteTestTable(
  client: DynamoDBDocumentClient,
  tableName: string,
): Promise<void> {
  await client.send(new DeleteTableCommand({ TableName: tableName }));
}

/** Contenido completo de la tabla, ordenado por clave, para comparar antes y después. */
export async function snapshotTable(
  client: DynamoDBDocumentClient,
  tableName: string,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: tableName,
        ConsistentRead: true,
        ...(startKey && { ExclusiveStartKey: startKey }),
      }),
    );
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items.sort((a, b) =>
    `${String(a.pk)}|${String(a.date)}`.localeCompare(`${String(b.pk)}|${String(b.date)}`),
  );
}

export type SendCommand = Parameters<DynamoDBDocumentClient['send']>[0];

export interface SendLog {
  /** Comandos enviados, en orden (se registran antes de ejecutarse). */
  sent: SendCommand[];
  /** Errores reales devueltos por DynamoDB Local o lanzados por `before`, en orden. */
  errors: unknown[];
}

/**
 * Envuelve `send` del cliente REAL: ejecuta `before` antes de cada comando (puede escribir en la
 * tabla con otro cliente o lanzar un error) y registra comandos y errores. Los comandos siguen
 * yendo a DynamoDB Local.
 */
export function interceptSend(
  client: DynamoDBDocumentClient,
  before: (command: SendCommand, log: SendLog) => Promise<void> | void = () => {},
): SendLog {
  const log: SendLog = { sent: [], errors: [] };
  const original = client.send.bind(client) as (command: SendCommand) => Promise<unknown>;
  (client as unknown as { send: unknown }).send = async (command: SendCommand) => {
    try {
      await before(command, log);
      log.sent.push(command);
      return await original(command);
    } catch (error) {
      log.errors.push(error);
      throw error;
    }
  };
  return log;
}
