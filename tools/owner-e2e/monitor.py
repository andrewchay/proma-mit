#!/usr/bin/env python3
"""监控 Owner 项目执行链路状态（只读查询 paa.db）。

用法: python3 tools/owner-e2e/monitor.py [paa.db 路径] [项目 ID]
默认指向隔离测试档案 /tmp/gravitas-owner-debug-profile。
"""
import sqlite3
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else '/tmp/gravitas-owner-debug-profile/projects/paa.db'
PID = sys.argv[2] if len(sys.argv) > 2 else None
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

if not PID:
    row = c.execute("SELECT id, title FROM projects ORDER BY created_at DESC LIMIT 1").fetchone()
    if not row:
        print('数据库中没有项目')
        sys.exit(1)
    PID = row['id']
    print('默认使用最新项目:', row['title'], PID)

def rows(sql, args=(PID,)):
    try:
        return [dict(r) for r in c.execute(sql, args)]
    except Exception as e:
        return [{'err': str(e)}]

print('== tasks ==')
for r in rows("SELECT id, title, status, assignee_display_name FROM tasks WHERE project_id=? ORDER BY created_at"):
    print(' ', r['id'][:8], r['status'], '|', (r.get('assignee_display_name') or '-')[:12], '|', (r.get('title') or '')[:45])
print('== grants ==')
for r in rows("SELECT id, state, task_id, purpose FROM project_owner_execution_grants WHERE project_id=? ORDER BY rowid DESC LIMIT 5"):
    print(' ', r['id'][:8], r['state'], 'task=', (r['task_id'] or '')[:8], '|', (r.get('purpose') or '')[:40])
print('== commands ==')
for r in rows("SELECT id, state, role, employee_id FROM project_owner_execution_commands WHERE project_id=? ORDER BY rowid DESC LIMIT 8"):
    print(' ', r['id'][:8], r.get('state'), r.get('role'), (r.get('employee_id') or '')[:8])
print('== quality ==')
for r in rows("SELECT owner_execution_id, substr(payload,1,120) p FROM project_owner_quality_actions WHERE project_id=? ORDER BY created_at DESC LIMIT 5"):
    print(' ', (r['owner_execution_id'] or '')[:8], '|', r['p'][:110].replace('\n', ' '))
print('== executions ==')
for r in rows("SELECT id, status, entity_id, substr(result_summary,1,60) rs FROM agent_executions WHERE project_id=? ORDER BY rowid DESC LIMIT 5"):
    print(' ', r['id'][:8], r['status'], '|', (r.get('rs') or '').replace('\n', ' '))
print('== messages 最近3条 ==')
for r in rows("SELECT substr(payload,1,150) p FROM project_owner_management_messages WHERE project_id=? ORDER BY created_at DESC LIMIT 3"):
    print(' |', r['p'].replace('\n', ' ')[:140])
