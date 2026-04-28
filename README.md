# DB Cruiser

DB Cruiser is a VS Code extension scaffold for MySQL database browsing and query work using the `mysql2` Node driver.

## Features

- DB Cruiser activity bar view with saved connections.
- Add MySQL database connections from a single form, with passwords stored in VS Code SecretStorage.
- Browse schemas, tables, views, columns, keys, indexes, foreign keys, and triggers.
- Open a table data view from the tree.
- Test saved connections.
- Open a fileless SQL console bound to a connection.
- Select the active SQL console schema from a visible dropdown.
- Configure the console row limit with 5, 10, 20, 25, 100, 200, 300, 400, 500, or No Limit.
- Clear the console editor and current results from the console toolbar.
- Run selected SQL or the whole editor with `Cmd+Enter` on macOS or `Ctrl+Enter` elsewhere.
- View query results and object details in a VS Code webview.

## Run It

1. Run `npm install`.
2. Open this folder in VS Code.
3. Press `F5` and choose **Run Extension**. VS Code will open a second window named **Extension Development Host**.
4. In that new Extension Development Host window, open the **Databases** activity bar view.
5. Add a MySQL connection from the DB Cruiser form.

## SQL Console

Open **SQL Console** from a connection or schema in the DB Cruiser tree. The console opens as a DB Cruiser panel with schema and limit dropdowns, SQL editor, Run and Clear buttons, and results area. It is not backed by a `.sql` file, so closing it should not ask whether to save anything.

## Notes

This is intentionally not a pixel clone of another IDE. It follows the same product pattern: connection tree, schema objects, SQL console, result grid, and object details. Future adapters can be added behind the same tree and console interfaces for PostgreSQL, SQLite, SQL Server, and Oracle.
