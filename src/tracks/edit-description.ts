import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { IsoDate } from '../shared/dates.ts';
import { findDescriptionIssues } from './description.ts';
import { TRACKS_PARTITION } from './dynamo-repository.ts';

/**
 * Corrección editorial de la descripción de una fecha ya publicada. Es una operación del operador
 * (requiere dynamodb:UpdateItem en su perfil; ninguna Lambda la usa) y solo toca `description`.
 */

export interface EditDescriptionInput {
  date: IsoDate;
  /** Si se informa, debe coincidir con el valor publicado: protege de editar sobre una lectura vieja. */
  expectedDescription?: string;
  newDescription: string;
}

export type EditDescriptionResult =
  | { status: 'updated'; previous: string | undefined }
  | { status: 'unchanged' }
  | { status: 'not-found' }
  /** La descripción publicada difiere de la esperada o cambió durante la edición: no se escribió nada. */
  | { status: 'conflict' }
  | { status: 'invalid'; issues: string[] };

const isConditionalFailure = (error: unknown) =>
  error instanceof Error && error.name === 'ConditionalCheckFailedException';

export async function editTrackDescription(
  client: DynamoDBDocumentClient,
  tableName: string,
  { date, expectedDescription, newDescription }: EditDescriptionInput,
): Promise<EditDescriptionResult> {
  // Mismas reglas que una carga manual, antes de tocar la tabla.
  const issues = findDescriptionIssues(newDescription);
  if (issues.length > 0) return { status: 'invalid', issues };
  const next = newDescription.trim();

  const { Item } = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: TRACKS_PARTITION, date },
      ConsistentRead: true,
    }),
  );
  if (!Item) return { status: 'not-found' };

  const current = typeof Item.description === 'string' ? Item.description : undefined;
  if (expectedDescription !== undefined && expectedDescription !== current) {
    return { status: 'conflict' };
  }
  if (current === next) return { status: 'unchanged' };

  const names: Record<string, string> = {
    '#description': 'description',
    '#spotifyTrackId': 'spotifyTrackId',
    '#createdAt': 'createdAt',
  };
  const values: Record<string, unknown> = {
    ':new': next,
    ':id': Item.spotifyTrackId,
  };
  const conditions = [
    'attribute_exists(pk)',
    '#spotifyTrackId = :id',
    // lib-dynamodb rechaza undefined: si falta createdAt, exige que siga ausente.
    typeof Item.createdAt === 'string'
      ? '#createdAt = :createdAt'
      : 'attribute_not_exists(#createdAt)',
    // Sin descripción previa, exige que siga ausente; con ella, que sea la leída.
    current === undefined ? 'attribute_not_exists(#description)' : '#description = :current',
  ];
  if (current !== undefined) values[':current'] = current;
  if (typeof Item.createdAt === 'string') values[':createdAt'] = Item.createdAt;

  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: TRACKS_PARTITION, date },
        UpdateExpression: 'SET #description = :new',
        ConditionExpression: conditions.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  } catch (error) {
    if (isConditionalFailure(error)) return { status: 'conflict' };
    throw error;
  }
  return { status: 'updated', previous: current };
}
