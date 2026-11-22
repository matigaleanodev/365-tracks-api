import { DeleteTableCommand, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { createDocClient, integrationEnvironment } from './aws.ts';

/**
 * Aborta la suite si el entorno no es el saneado del runner o si DynamoDB Local no responde, y al
 * terminar borra cualquier tabla de esta corrida que un test no haya limpiado.
 */
export default async function setup() {
  const { runId } = integrationEnvironment();
  const client = createDocClient();
  await client.send(new ListTablesCommand({ Limit: 1 }));

  return async () => {
    const prefix = `it365-${runId}-`;
    const { TableNames = [] } = await client.send(new ListTablesCommand({}));
    for (const name of TableNames.filter((table) => table.startsWith(prefix))) {
      await client.send(new DeleteTableCommand({ TableName: name }));
    }
    client.destroy();
  };
}
