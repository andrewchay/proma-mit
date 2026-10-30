import json
import sqlite3
import sys

path, project_id, output_path = sys.argv[1:4]
connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row


def one(sql, args=(project_id,)):
    return dict(connection.execute(sql, args).fetchone())


def rows(sql, args=(project_id,)):
    return [dict(row) for row in connection.execute(sql, args)]


snapshot = {
    "projectId": project_id,
    "arrangement": one("""SELECT
      (SELECT COUNT(*) FROM project_owner_planning_links WHERE project_id=?) AS links,
      (SELECT COUNT(*) FROM project_owner_planning_admissions a
       JOIN project_owner_planning_links l ON l.id=a.link_id WHERE l.project_id=?) AS admissions,
      (SELECT COUNT(*) FROM agent_executions e
       JOIN project_owner_planning_links l ON l.planning_task_id=e.entity_id
       WHERE e.project_id=?) AS executions""", (project_id, project_id, project_id)),
    "arrangementExecutions": rows("""SELECT e.id,e.status,e.started_at,e.completed_at
      FROM agent_executions e JOIN project_owner_planning_links l ON l.planning_task_id=e.entity_id
      WHERE e.project_id=? ORDER BY e.started_at,e.id"""),
    "requests": one("""SELECT COUNT(*) AS reservations,
      COALESCE(SUM(r.reserved_cost_micros),0) AS reservedCostMicros,
      COALESCE(SUM(r.settled_cost_micros),0) AS settledCostMicros
      FROM project_owner_execution_request_reservations r
      JOIN project_owner_execution_commands c ON c.id=r.command_id WHERE c.project_id=?"""),
    "providerResponses": one("""SELECT
      (SELECT COUNT(*) FROM project_owner_planning_run_receipts r
       JOIN agent_executions e ON e.id=r.execution_id
       WHERE e.project_id=? AND COALESCE(json_extract(r.payload,'$.runtimeResult.provider_response_id'),'')<>'') AS planning,
      (SELECT COUNT(*) FROM pilot_runtime_usage_receipts
       WHERE project_id=? AND COALESCE(json_extract(raw_payload,'$.provider_response_id'),'')<>'') AS runtime""", (project_id, project_id)),
    "usage": one("""SELECT COUNT(*) AS receipts,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cost_micros),0) AS knownCostMicros,
      SUM(CASE WHEN cost_micros IS NULL THEN 1 ELSE 0 END) AS unknownCostReceipts
      FROM pilot_runtime_usage_receipts WHERE project_id=?"""),
    "commands": one("""SELECT COUNT(*) AS count,
      COALESCE(SUM(actual_cost_micros),0) AS knownCostMicros,
      SUM(CASE WHEN actual_cost_micros IS NULL THEN 1 ELSE 0 END) AS unknownCostCommands
      FROM project_owner_execution_commands WHERE project_id=?"""),
    "grants": rows("""SELECT g.id,g.state,g.max_cost_micros,g.max_runs,g.max_rework,g.expires_at,
      (SELECT COUNT(*) FROM project_owner_execution_commands c WHERE c.grant_id=g.id) AS commandCount,
      (SELECT COALESCE(SUM(c.actual_cost_micros),0) FROM project_owner_execution_commands c WHERE c.grant_id=g.id) AS knownCostMicros
      FROM project_owner_execution_grants g WHERE g.project_id=? ORDER BY g.rowid"""),
    "deliveryMessages": rows("""SELECT id,event_id,json_extract(payload,'$.delivery.planVersion') AS planVersion
      FROM project_owner_management_messages
      WHERE project_id=? AND json_extract(payload,'$.kind')='delivery' ORDER BY rowid"""),
}
with open(output_path, "w", encoding="utf-8") as output:
    json.dump(snapshot, output, ensure_ascii=False, indent=2)
    output.write("\n")
print(json.dumps(snapshot, ensure_ascii=False))
