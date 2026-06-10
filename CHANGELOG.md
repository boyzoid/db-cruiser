# Change Log

## 0.4.6

- Added paging and refresh controls for SQL console result sets when row limits are applied.
- Replaced separate result export buttons with a compact icon dropdown for CSV, JSON, and Markdown.

## 0.4.5

- Fixed table data views so wide result sets expose the horizontal scrollbar while column headers remain visible.

## 0.4.4

- Added privilege help popovers in user management.
- Fixed user management system-account warnings so `SYSTEM_USER` privileges do not mark every account as reserved.
- Added DDL-aware SQL completions for schema changes and refreshed schema metadata immediately after DDL runs.

## 0.4.3

- Replaced per-column table data filters and global search with a single code-hinted toolbar `WHERE` expression.
- Changed table data sort controls to tri-state icon buttons for unsorted, ascending, and descending states.
- Swapped table data copy controls to icon-only buttons.

## 0.4.2

- Added a table-row SQL Console action that opens the console with the table's schema selected.
- Updated table data views to open in the active editor group instead of creating a side-by-side split.

## 0.4.1

- Refreshed the Marketplace README content.

## 0.4.0

- Added EXPLAIN support from SQL editors and the SQL console, including a visual execution-plan flow and raw plan details.
- Improved tree-style EXPLAIN output so long plan text is split into readable wrapped steps, nested loops are indented, and the visual plan renders tree operations as a flowchart.
- Added EXPLAIN bottleneck cues for full scans, temporary tables, sorts/filesorts, missing index choices, and high row estimates.

## 0.3.0

- Upgraded table data views with pagination, adjustable page sizes, sorting, global search, per-column filters, and copy actions for cells, rows, and current-page column values.
- Added schema tree actions to copy qualified names, copy table/view CREATE statements, and generate SELECT, INSERT, UPDATE, DELETE, and foreign-key JOIN SELECT templates.

## 0.2.1

- Improved SQL console syntax highlighting so token colors remain visible across themes.

## 0.2.0

- Added optional SSH tunneling for MySQL connections with password or private key authentication.
- Added connection editing and per-connection colors.

## 0.1.0

- Added schema-aware SQL completions for table names, aliases, and columns.
- Added SQL syntax highlighting and smart indentation in the console editor.
- Added active schema and row limit controls to the SQL console toolbar.
- Added query result exports for CSV, JSON, and Markdown.
- Improved query result rendering and object inspection views.

## 0.0.1

- Initial DB Cruiser release with MySQL connection management, schema browsing, query execution, and table data views.
