import type { Database } from "bun:sqlite";

import type { InstanceConfig } from "@mikan-919/oriel-contracts";

export type { InstanceConfig } from "@mikan-919/oriel-contracts";

export interface InstanceConfigStore {
  get(): InstanceConfig;
  isInitialized(): boolean;
  set(config: InstanceConfig): void;
}

interface InstanceConfigRow {
  relayOrigin: string | null;
  repositoryId: number | null;
  repositoryOwner: string | null;
  repositoryName: string | null;
  repositoryRoot: string | null;
  worktreesRoot: string | null;
  linearTeamId: string | null;
  canonicalRemote: string | null;
  lmStudioBaseUrl: string | null;
  initialized: number;
}

function toInstanceConfig(row: InstanceConfigRow): InstanceConfig {
  return {
    relayOrigin: row.relayOrigin,
    repositoryId: row.repositoryId,
    repositoryOwner: row.repositoryOwner,
    repositoryName: row.repositoryName,
    repositoryRoot: row.repositoryRoot,
    worktreesRoot: row.worktreesRoot,
    linearTeamId: row.linearTeamId,
    canonicalRemote: row.canonicalRemote,
    lmStudioBaseUrl: row.lmStudioBaseUrl,
  };
}

export function createInstanceConfigStore(
  database: Database,
): InstanceConfigStore {
  const select = database.query<InstanceConfigRow, []>(
    `SELECT
       relay_origin AS relayOrigin,
       repository_id AS repositoryId,
       repository_owner AS repositoryOwner,
       repository_name AS repositoryName,
       repository_root AS repositoryRoot,
       worktrees_root AS worktreesRoot,
       linear_team_id AS linearTeamId,
       canonical_remote AS canonicalRemote,
       lm_studio_base_url AS lmStudioBaseUrl,
       initialized
     FROM instance_config
     WHERE id = 1`,
  );
  const update = database.query(
    `UPDATE instance_config SET
       relay_origin = ?,
       repository_id = ?,
       repository_owner = ?,
       repository_name = ?,
       repository_root = ?,
       worktrees_root = ?,
       linear_team_id = ?,
       canonical_remote = ?,
       lm_studio_base_url = ?,
       initialized = 1
     WHERE id = 1`,
  );

  return {
    get() {
      return toInstanceConfig(select.get()!);
    },
    isInitialized() {
      return select.get()!.initialized === 1;
    },
    set(config) {
      update.run(
        config.relayOrigin,
        config.repositoryId,
        config.repositoryOwner,
        config.repositoryName,
        config.repositoryRoot,
        config.worktreesRoot,
        config.linearTeamId,
        config.canonicalRemote,
        config.lmStudioBaseUrl,
      );
    },
  };
}
