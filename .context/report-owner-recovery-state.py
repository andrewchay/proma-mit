import json
import sqlite3
import sys
from datetime import datetime, timezone

path, project_id = sys.argv[1:3]
connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row


def show(label, sql, args=(project_id,)):
    print(f"\n## {label}")
    rows = connection.execute(sql, args).fetchall()
    print(f"count={len(rows)}")
    for row in rows:
        item = dict(row)
        for key, value in list(item.items()):
            if isinstance(value, str) and value.startswith(("{", "[")):
                try:
                    item[key] = json.loads(value)
                except json.JSONDecodeError:
                    pass
            if key.endswith("_at") and isinstance(value, int):
                item[f"{key}_iso"] = datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()
        print(json.dumps(item, ensure_ascii=False))


show("executions", """SELECT id, entity_id, agent_id, session_id, owner_command_id, status,
       result_summary, error, started_at, completed_at
       FROM agent_executions WHERE project_id=? ORDER BY started_at, id""")
show("planning_links", """SELECT l.id, l.planning_task_id, a.execution_id, a.session_id,
       a.request_hash, a.admitted_at
       FROM project_owner_planning_links l
       LEFT JOIN project_owner_planning_admissions a ON a.link_id=l.id
       WHERE l.project_id=? ORDER BY l.rowid""")
show("planning_receipts", """SELECT r.id, r.execution_id, r.capture_hash, r.payload
       FROM project_owner_planning_run_receipts r
       JOIN project_owner_planning_links l ON l.planning_task_id=
         (SELECT entity_id FROM agent_executions WHERE id=r.execution_id)
       WHERE l.project_id=? ORDER BY r.rowid""")
show("planning_outcomes", """SELECT o.execution_id, o.receipt_id, o.payload
       FROM project_owner_planning_run_outcomes o
       JOIN project_owner_planning_links l ON l.planning_task_id=
         (SELECT entity_id FROM agent_executions WHERE id=o.execution_id)
       WHERE l.project_id=? ORDER BY o.rowid""")
show("delegations", """SELECT id, revoked_at, payload FROM project_owner_management_delegations
       WHERE project_id=? ORDER BY rowid""")
show("commands", """SELECT id, role, state, execution_id, reserved_cost_micros,
       actual_cost_micros, usage_record_key, created_at, updated_at
       FROM project_owner_execution_commands WHERE project_id=? ORDER BY rowid""")
show("request_reservations", """SELECT r.request_id, r.command_id, r.execution_id, r.state,
       r.reserved_cost_micros, r.settled_cost_micros, r.created_at
       FROM project_owner_execution_request_reservations r
       JOIN project_owner_execution_commands c ON c.id=r.command_id
       WHERE c.project_id=? ORDER BY r.rowid""")
show("quality_actions", """SELECT owner_execution_id, reviewer_command_id, task_id, payload, created_at
       FROM project_owner_quality_actions WHERE project_id=? ORDER BY rowid""")
show("technical_reviews", """SELECT reviewer_command_id, task_id, verdict, created_at
       FROM project_owner_technical_reviews WHERE project_id=? ORDER BY rowid""")
show("tasks", """SELECT id, title, status, assignee_display_name, updated_at, completed_at
       FROM tasks WHERE project_id=? ORDER BY rowid""")
show("planning_stops", """SELECT s.execution_id, s.session_id, s.requested_at
       FROM project_owner_planning_stop_requests s
       JOIN project_owner_planning_links l ON l.planning_task_id=
         (SELECT entity_id FROM agent_executions WHERE id=s.execution_id)
       WHERE l.project_id=? ORDER BY s.rowid""")
show("management_failures", """SELECT failure_key, attempt_count, retry_until, notified, updated_at
       FROM project_owner_management_failures WHERE project_id=?""")
show("management_messages", """SELECT id, event_id, payload FROM project_owner_management_messages
       WHERE project_id=? ORDER BY rowid DESC LIMIT 12""")
show("management_events", """SELECT id, payload, consumed_at FROM project_owner_management_events
       WHERE project_id=? ORDER BY rowid DESC LIMIT 12""")
show("execution_grants", """SELECT id, state, max_cost_micros, max_runs, max_rework, expires_at,
       owner_management_delegation_id FROM project_owner_execution_grants WHERE project_id=? ORDER BY rowid""")
