# DB Cruiser

DB Cruiser is a MySQL database explorer and SQL console for Visual Studio Code. It adds a database view to the activity bar so you can save connections, browse schema objects, inspect table details, and run SQL without leaving your editor.

## Features

- Save, edit, and manage MySQL connections from the DB Cruiser activity bar view.
- Connect directly or through an SSH tunnel with password or private key authentication.
- Assign connection colors that carry into the tree, DB Cruiser tab icons, SQL console, and result/detail panels.
- Browse schemas, tables, views, columns, keys, indexes, foreign keys, and triggers.
- Open table data views with pagination, sorting, global search, per-column filters, and copy actions.
- Test saved connections before using them.
- Open a SQL console bound to a selected connection or schema.
- Choose the active schema and row limit from the console toolbar.
- Run `EXPLAIN` for SQL and inspect both a flowchart-style visual plan and raw plan details.
- Copy fully-qualified table and column names from the schema tree.
- Copy table/view `CREATE` statements and generate `SELECT`, `INSERT`, `UPDATE`, `DELETE`, and foreign-key join SQL templates.
- Run selected SQL or the whole editor with `Cmd+Enter` on macOS or `Ctrl+Enter` elsewhere.
- View query results and object details in a VS Code webview panel.

## Getting Started

1. Open the **DB Cruiser** activity bar view.
2. Select **Add MySQL Connection**.
3. Enter the connection name, MySQL host, port, username, password, and optional default schema.
4. Choose a connection color if you want a visual marker in DB Cruiser views.
5. Enable **SSH Tunnel** when the database is only reachable through an SSH server.
6. Use **Browse** to pick a private key file for SSH private key authentication.
7. Expand the saved connection to browse available schemas and database objects.
8. Open **SQL Console** from a connection or schema to start running queries.

## SQL Console

The SQL console opens as a DB Cruiser panel with schema and row limit controls, a SQL editor, run and clear actions, and a results area. It is not backed by a `.sql` file, so closing the console does not prompt you to save a temporary query document.

Use **Explain** from the SQL console, editor title, or editor context menu to run MySQL `EXPLAIN` for one statement at a time. DB Cruiser shows the original SQL, a flowchart-style execution plan, and the raw EXPLAIN result rows.

## Table Data View

Open a table from the DB Cruiser tree to browse rows in a dedicated data panel. The data view supports paging, adjustable page sizes, column sorting, global search, per-column filters, and copying cells, rows, or current-page column values.

## Pinned For Later

These ideas are parked from the original feature list for future releases:

- Query history, favorites, and saved snippets.
- Schema-wide search or quick open for tables, views, columns, and routines.
- Relationship/ER diagram views from foreign keys.
- Editable table rows with guarded apply/revert workflows.
- Connection organization with groups, favorites, or recent databases.

## Commands

DB Cruiser contributes these commands to VS Code:

- **DB Cruiser: Add MySQL Connection**
- **DB Cruiser: Edit Connection**
- **DB Cruiser: Refresh**
- **DB Cruiser: Remove Connection**
- **DB Cruiser: Test Connection**
- **DB Cruiser: Open SQL Console**
- **DB Cruiser: Run Query**
- **DB Cruiser: Explain Query**
- **DB Cruiser: Select Console Schema**
- **DB Cruiser: Inspect Object**
- **DB Cruiser: Open Data View**
- **DB Cruiser: Copy Qualified Name**
- **DB Cruiser: Copy CREATE Statement**
- **DB Cruiser: Generate SELECT Statement**
- **DB Cruiser: Generate INSERT Statement**
- **DB Cruiser: Generate UPDATE Statement**
- **DB Cruiser: Generate DELETE Statement**
- **DB Cruiser: Generate JOIN SELECT Statement**

## Settings

- `dbCruiser.mysql.maxRows`: Maximum rows displayed for ad hoc MySQL query results. Defaults to `500`.

## Security

DB Cruiser stores MySQL passwords, SSH passwords, and SSH key passphrases in VS Code SecretStorage. Non-secret connection metadata is stored in VS Code's extension storage.

## Requirements

DB Cruiser currently supports MySQL-compatible databases. Direct connections need network access from VS Code to the target database server. SSH tunnel connections need network access to the SSH server plus database credentials with permission to inspect metadata and run the queries you choose.

## Feedback

If something does not work as expected, open an issue with the database version, the action you were taking, and any error message shown by VS Code.
