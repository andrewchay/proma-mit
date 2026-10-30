import sqlite3
import sys

connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
for row in connection.execute("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY type, name"):
    print(f"{row['type']}\t{row['name']}\t{row['sql']}")
