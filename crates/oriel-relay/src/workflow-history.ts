import type {WorkflowBinding} from './workflow';

export type HistoryEvent = {
  kind: 'started' | 'progress' | 'ended' | 'released' | 'disconnected';
  stage: string;
  target_oid?: string;
  resumed?: boolean;
  outcome?: {status: 'completed' | 'failed' | 'stopped'; reason: string};
  verification?: {head_oid: string; target_oid: string; configuration_id: string; completed: number; total: number; status: string};
};

/** Execution evidence only. No conversation, terminal output, argv or credentials. */
export class WorkflowHistory {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS workflow_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
      repository_id INTEGER NOT NULL, device_id TEXT NOT NULL, issue_number INTEGER NOT NULL,
      execution_id TEXT NOT NULL, recorded_at TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_history_scope ON workflow_history(user_id, repository_id, device_id, issue_number, id);
    CREATE INDEX IF NOT EXISTS workflow_history_execution ON workflow_history(user_id, execution_id, id);`);
  }
  record(binding: WorkflowBinding, execution: string, issue: number, event: HistoryEvent): void {
    if(event.kind==='started') {
      const previous=this.sql.exec<{payload:string}>("SELECT payload FROM workflow_history WHERE user_id=? AND repository_id=? AND device_id=? AND issue_number=? AND json_extract(payload,'$.kind') IN ('ended','disconnected') ORDER BY id DESC LIMIT 1",binding.user_id,binding.repository_id,binding.device_id,issue).toArray()[0];
      const prior=previous&&JSON.parse(previous.payload) as HistoryEvent | undefined;
      if(prior?.kind==='disconnected'||prior?.outcome?.status==='stopped')event={...event,resumed:true};
    }
    const payload=JSON.stringify(event);
    const last=this.sql.exec<{payload:string}>("SELECT payload FROM workflow_history WHERE user_id=? AND execution_id=? ORDER BY id DESC LIMIT 1",binding.user_id,execution).toArray()[0];
    if(last?.payload===payload)return;
    const time=new Date().toISOString();
    this.sql.exec("INSERT INTO workflow_history (user_id,repository_id,device_id,issue_number,execution_id,recorded_at,payload) VALUES (?,?,?,?,?,?,?)",
      binding.user_id,binding.repository_id,binding.device_id,issue,execution,time,payload);
    // Bound authenticated storage per owner; a heartbeat never calls record.
    this.sql.exec("DELETE FROM workflow_history WHERE user_id=? AND (recorded_at<? OR id IN (SELECT id FROM workflow_history WHERE user_id=? ORDER BY id DESC LIMIT -1 OFFSET 5000))",
      binding.user_id,new Date(Date.now()-90*86400000).toISOString(),binding.user_id);
  }
  read(user: string, repository: number, device: string, issue: number) {
    const rows=this.sql.exec<{id:number;execution_id:string;recorded_at:string;payload:string}>(
      "SELECT id,execution_id,recorded_at,payload FROM workflow_history WHERE user_id=? AND repository_id=? AND device_id=? AND issue_number=? AND recorded_at>=? ORDER BY id DESC LIMIT 201",
      user,repository,device,issue,new Date(Date.now()-90*86400000).toISOString()).toArray();
    return {events:rows.slice(0,200).map(({payload,...row})=>({...row,...JSON.parse(payload)})),truncated:rows.length>200};
  }
}
