# DB Cruiser

DB Cruiser is a MySQL database explorer and SQL console for Visual Studio Code. It adds a database view to the activity bar so you can save connections, browse schema objects, inspect table details, and run SQL without leaving your editor.

## Features

- Save and manage MySQL connections from the DB Cruiser activity bar view.
- Browse schemas, tables, views, columns, keys, indexes, foreign keys, and triggers.
- Open table data views directly from the tree.
- Test saved connections before using them.
- Open a SQL console bound to a selected connection or schema.
- Choose the active schema and row limit from the console toolbar.
- Run selected SQL or the whole editor with `Cmd+Enter` on macOS or `Ctrl+Enter` elsewhere.
- View query results and object details in a VS Code webview panel.

## Getting Started

1. Open the **DB Cruiser** activity bar view.
2. Select **Add MySQL Connection**.
3. Enter the connection name, host, port, username, password, and optional default schema.
4. Expand the saved connection to browse available schemas and database objects.
5. Open **SQL Console** from a connection or schema to start running queries.

## SQL Console

The SQL console opens as a DB Cruiser panel with schema and row limit controls, a SQL editor, run and clear actions, and a results area. It is not backed by a `.sql` file, so closing the console does not prompt you to save a temporary query document.

## Commands

DB Cruiser contributes these commands to VS Code:

- **DB Cruiser: Add MySQL Connection**
- **DB Cruiser: Refresh**
- **DB Cruiser: Remove Connection**
- **DB Cruiser: Test Connection**
- **DB Cruiser: Open SQL Console**
- **DB Cruiser: Run Query**
- **DB Cruiser: Select Console Schema**
- **DB Cruiser: Inspect Object**
- **DB Cruiser: Open Data View**

## Settings

- `dbCruiser.mysql.maxRows`: Maximum rows displayed for ad hoc MySQL query results. Defaults to `500`.

## Security

DB Cruiser stores MySQL passwords in VS Code SecretStorage. Non-secret connection metadata is stored in VS Code's extension storage.

## Requirements

DB Cruiser currently supports MySQL-compatible databases. You need network access from VS Code to the target database server and database credentials with permission to inspect metadata and run the queries you choose.

## Feedback

If something does not work as expected, open an issue with the database version, the action you were taking, and any error message shown by VS Code.
