import type {SearchResult} from '../data.js';
import type {Executor} from '../pg.js';

export type CVR = {
  clientGroupID: string;
  clientVersion: number;
  order: number;
};

export async function getCVR(
  executor: Executor,
  clientGroupID: string,
  order: number,
): Promise<CVR | undefined> {
  const result = await executor(
    /*sql*/ `SELECT "client_version" FROM "cvr" WHERE "client_group_id" = $1 AND "order" = $2`,
    [clientGroupID, order],
  );
  if (result.rowCount === 0) {
    return undefined;
  }
  return {
    clientGroupID,
    order,
    clientVersion: result.rows[0].client_version,
  };
}

export function putCVR(executor: Executor, cvr: CVR) {
  return executor(
    /*sql*/ `INSERT INTO cvr (
      "client_group_id",
      "client_version",
      "order"
    ) VALUES ($1, $2, $3) ON CONFLICT ("client_group_id", "order") DO UPDATE SET
      client_version = excluded.client_version
    `,
    [cvr.clientGroupID, cvr.clientVersion, cvr.order],
  );
}

/**
 * Find all rows in a table that are not in our CVR table.
 * - either the id is not present
 * - or the rowversion is different
 *
 * We could do cursoring to speed this along.
 * I.e., For a given pull sequence, we can keep track of the last id and rowversion.
 * A "reset pull" brings cursor back to 0 to deal with privacy or query changes.
 *
 * But also, if the frontend drives the queries then we'll never actually be fetching
 * so much as the frontend queries will be reasonably sized. The frontend queries would also
 * be cursored.
 *
 * E.g., `SELECT * FROM issue WHERE modified > x OR (modified = y AND id > z) ORDER BY modified, id LIMIT 100`
 * Cursored on modified and id.
 *
 * This means our compare against the CVR would not be a full table scan of `issue`.
 */
export function findUnsentItems(
  executor: Executor,
  table: keyof typeof TableOrdinal,
  clientGroupID: string,
  order: number,
  limit: number,
) {
  //   sql = /*sql*/ `SELECT * FROM "${table}" t WHERE NOT EXISTS (
  //       SELECT 1 FROM "cvr_entry" WHERE "cvr_entry"."row_id" = t."id" AND
  //       "cvr_entry"."row_version" = t."rowversion" AND
  //       "cvr_entry"."client_group_id" = $1 AND
  //       "cvr_entry"."order" <= $2 AND
  //       "cvr_entry"."tbl" = $3
  //     ) LIMIT $4`;
  // The below query runs in ~40ms for issues vs the above takes 16 seconds for issues.
  const sql = /*sql*/ `SELECT *
      FROM "${table}" t
      WHERE (t."id", t."rowversion") NOT IN (
        SELECT "row_id", "row_version"
        FROM "cvr_entry"
        WHERE "client_group_id" = $1
          AND "order" <= $2
          AND "tbl" = $3
      )
      LIMIT $4;`;

  const params = [clientGroupID, order, TableOrdinal[table], limit];
  return executor(sql, params);
}

export const TableOrdinal = {
  issue: 1,
  description: 2,
  comment: 3,
} as const;

export function findDeletions(
  executor: Executor,
  table: keyof typeof TableOrdinal,
  clientGroupID: string,
  order: number,
  limit: number,
) {
  // Find rows that are in the CVR table but not in the actual table.
  // Exclude rows that have a delete entry already.
  // TODO: Maybe we can remove the second `NOT EXISTS` if we prune the CVR table.
  // This pruning would mean that we need to record the delete against the
  // current CVR rather than next CVR. If a request comes in for that prior CVR,
  // we return the stored delete records and do not compute deletes.
  return executor(
    /*sql*/ `SELECT "row_id" FROM "cvr_entry"
    WHERE "cvr_entry"."tbl" = $1 AND NOT EXISTS (
      SELECT 1 FROM "${table}" WHERE id = "cvr_entry"."row_id"
    ) AND
    "cvr_entry"."client_group_id" = $2 AND
    "cvr_entry"."order" <= $3 
    AND NOT EXISTS (
      SELECT 1 FROM "cvr_delete_entry" WHERE "cvr_delete_entry"."tbl" = $1 AND "cvr_delete_entry"."row_id" = "cvr_entry"."row_id"
      AND "cvr_delete_entry"."client_group_id" = $2 AND "cvr_delete_entry"."order" <= $3
    ) LIMIT $4`,
    [TableOrdinal[table], clientGroupID, order, limit],
  );
}

export async function dropCVREntries(
  executor: Executor,
  clientGroupID: string,
  order: number,
) {
  await Promise.all([
    executor(
      /*sql*/ `DELETE FROM "cvr_entry" WHERE "client_group_id" = $1 AND "order" > $2`,
      [clientGroupID, order],
    ),
    executor(
      /*sql*/ `DELETE FROM "cvr_delete_entry" WHERE "client_group_id" = $1 AND "order" > $2`,
      [clientGroupID, order],
    ),
  ]);
}

export async function recordUpdates(
  executor: Executor,
  table: keyof typeof TableOrdinal,
  clientGroupID: string,
  order: number,
  updates: SearchResult[],
) {
  if (updates.length === 0) {
    return;
  }

  const placeholders = [];
  const values = [];
  const stride = 5;
  for (let i = 0; i < updates.length; i++) {
    placeholders.push(
      `($${i * stride + 1}, $${i * stride + 2}, $${i * stride + 3}, $${
        i * stride + 4
      }, $${i * stride + 5})`,
    );
    values.push(
      clientGroupID,
      order,
      TableOrdinal[table],
      updates[i].id,
      updates[i].rowversion,
    );
  }

  await executor(
    /*sql*/ `INSERT INTO cvr_entry (
    "client_group_id",
    "order",
    "tbl",
    "row_id",
    "row_version"
  ) VALUES ${placeholders.join(
    ', ',
  )} ON CONFLICT ("client_group_id", "tbl", "row_id") DO UPDATE SET
    "row_version" = excluded."row_version",
    "order" = excluded."order"
  `,
    values,
  );
}

/**
 * Records a CVR entry for the deletes.
 *
 * Note: we could update this to cull CRV entries that are no longer needed.
 * We'd have to tag delete entries against the current cvr to do that rather then
 * the next cvr. If a cvr was already previously requested, the next request for the same CVR
 * returns the previously recorded deletes rather than computing deletes.
 * @param executor
 * @param table
 * @param ids
 * @returns
 */
export async function recordDeletes(
  executor: Executor,
  table: keyof typeof TableOrdinal,
  clientGroupID: string,
  order: number,
  ids: string[],
) {
  if (ids.length === 0) {
    return;
  }
  const placeholders = [];
  const values = [];
  const stride = 4;
  for (let i = 0; i < ids.length; i++) {
    placeholders.push(
      `($${i * stride + 1}, $${i * stride + 2}, $${i * stride + 3}, $${
        i * stride + 4
      })`,
    );
    values.push(clientGroupID, order, TableOrdinal[table], ids[i]);
  }
  await executor(
    /*sql*/ `INSERT INTO cvr_delete_entry (
    "client_group_id",
    "order",
    "tbl",
    "row_id"
  ) VALUES ${placeholders.join(', ')}`,
    values,
  );
}
