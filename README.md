# DB Cruiser

DB Cruiser is a MySQL database explorer and SQL console for Visual Studio Code. Save connections, browse schemas, inspect table data, and run SQL from a dedicated DB Cruiser view without leaving your editor.

## Features

### Connection Management

- Save, edit, test, and remove MySQL connections from the DB Cruiser activity bar view.
- Connect directly or through an SSH tunnel using password or private key authentication.
- Add connection colors so tabs, tree items, consoles, and result views are easy to tell apart.
- Manage MySQL users from a saved connection, including `user@host` accounts, passwords, global or schema-level privileges, and `WITH GRANT OPTION`.

### Schema Explorer

- Browse schemas, tables, views, columns, keys, indexes, foreign keys, and triggers.
- Open a SQL console directly from a table with that table's schema selected.
- Open object details and copy fully qualified table or column names.
- Copy table/view `CREATE` statements.
- Generate `SELECT`, `INSERT`, `UPDATE`, `DELETE`, and foreign-key join SQL templates from the schema tree.

### SQL Console

- Open a console for any saved connection or schema.
- Choose the active schema and row limit from the console toolbar.
- Run selected SQL or the whole editor with `Cmd+Enter` on macOS or `Ctrl+Enter` elsewhere.
- Export query results as CSV, JSON, or Markdown.
- Run MySQL `EXPLAIN` for a statement and inspect visual plan steps, risk cues, and raw plan details.

### Table Data View

- Browse table rows in dedicated data-view tabs that open in the active editor group.
- Page through results, adjust page size, cycle column sorting with compact icon controls, and filter with a code-hinted `WHERE` expression.
- Copy cells, rows, or current-page column values with streamlined copy controls.

## Getting Started

1. Open the **DB Cruiser** activity bar view.
2. Select **Add MySQL Connection**.
3. Enter the connection name, MySQL host, port, username, password, and optional default schema.
4. Choose a connection color if you want a visual marker in DB Cruiser views.
5. Enable **SSH Tunnel** if the database is only reachable through an SSH server.
6. Expand the saved connection to browse schemas and database objects.
7. Open **SQL Console** from a connection or schema to start running queries.

## Requirements

- Visual Studio Code 1.85.0 or newer.
- A MySQL-compatible database.
- Network access from VS Code to the database server, or to an SSH server that can reach the database.
- Database credentials with permission to inspect metadata and run the queries you choose.
- User management requires MySQL privileges to inspect accounts and run user/privilege statements such as `CREATE USER`, `ALTER USER`, `DROP USER`, `GRANT`, and `REVOKE`.

## Extension Settings

- `dbCruiser.mysql.maxRows`: Maximum rows displayed for ad hoc MySQL query results. Defaults to `500`.

## Security

DB Cruiser stores MySQL passwords, SSH passwords, and SSH key passphrases in VS Code SecretStorage. Non-secret connection metadata is stored in VS Code extension storage.
Passwords entered while creating or updating MySQL users are sent to MySQL for that operation and are not stored by DB Cruiser.

## Feedback

If something does not work as expected, please open an issue with your database version, the action you were taking, and any error message shown by VS Code.
