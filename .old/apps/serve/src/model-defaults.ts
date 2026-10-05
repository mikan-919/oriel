import type { Database } from "bun:sqlite";

import {
  modelDefaultKinds,
  type ModelDefaultKind,
  type ModelDefaultScope,
  type ModelDefaults,
  type ModelSelection,
} from "@mikan-919/oriel-contracts";
import type { JobKind } from "./job-registry";

export { modelDefaultKinds } from "@mikan-919/oriel-contracts";
export type {
  ModelDefaultKind,
  ModelDefaultScope,
  ModelDefaults,
  ModelSelection,
} from "@mikan-919/oriel-contracts";

export interface ModelDefaultsStore {
  get(scope: ModelDefaultScope): ModelSelection | null;
  isInitialized(scope: ModelDefaultScope): boolean;
  set(scope: ModelDefaultScope, model: ModelSelection): void;
  clear(scope: ModelDefaultScope): void;
  list(): ModelDefaults;
}

interface ModelDefaultRow {
  provider: string;
  modelId: string;
}

function toModelSelection(row: ModelDefaultRow | null): ModelSelection | null {
  return row === null ? null : { provider: row.provider, id: row.modelId };
}

export function createModelDefaultsStore(
  database: Database,
): ModelDefaultsStore {
  const select = database.query<ModelDefaultRow, [string]>(
    `SELECT provider, model_id AS modelId
     FROM model_defaults
     WHERE scope = ?`,
  );
  const upsert = database.query(
    `INSERT INTO model_defaults (scope, provider, model_id)
     VALUES (?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       provider = excluded.provider,
       model_id = excluded.model_id`,
  );
  const remove = database.query(`DELETE FROM model_defaults WHERE scope = ?`);
  const selectInitialized = database.query<{ scope: string }, [string]>(
    `SELECT scope FROM model_default_state WHERE scope = ?`,
  );
  const markInitialized = database.query(
    `INSERT INTO model_default_state (scope)
     VALUES (?)
     ON CONFLICT(scope) DO NOTHING`,
  );

  return {
    get(scope) {
      return toModelSelection(select.get(scope) ?? null);
    },
    isInitialized(scope) {
      return selectInitialized.get(scope) !== null;
    },
    set(scope, model) {
      upsert.run(scope, model.provider, model.id);
      markInitialized.run(scope);
    },
    clear(scope) {
      remove.run(scope);
      markInitialized.run(scope);
    },
    list() {
      return {
        base: toModelSelection(select.get("base") ?? null),
        perKind: Object.fromEntries(
          modelDefaultKinds.map((kind) => [
            kind,
            toModelSelection(select.get(kind) ?? null),
          ]),
        ) as Record<ModelDefaultKind, ModelSelection | null>,
      };
    },
  };
}

/**
 * Job作成時点でmodelを固定するためのfallback連鎖。
 * `issue_conversation`はmodelを使わないため、どの値も解決しない。
 */
export function resolveModelDefault(
  store: ModelDefaultsStore,
  kind: JobKind,
  override?: ModelSelection,
): ModelSelection | null {
  if (kind === "issue_conversation") {
    return null;
  }

  return (
    (kind === "implementation" ? override : undefined) ??
    store.get(kind) ??
    store.get("base")
  );
}
