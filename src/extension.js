const vscode = require('vscode');
const crypto = require('crypto');

const CONNECTIONS_KEY = 'dbCruiser.connections';
const SESSION_SCHEMAS_KEY = 'dbCruiser.consoleSessionSchemas';
const SESSION_ROW_LIMITS_KEY = 'dbCruiser.consoleSessionRowLimits';
const CONSOLE_MARKER = '-- db-cruiser:connection=';
const SCHEMA_MARKER = '-- db-cruiser:schema=';
const LEGACY_CONSOLE_MARKER = '-- database-pilot:connection=';
const MYSQL_PASSWORD_PREFIX = 'dbCruiser.mysql.password.';
const DEFAULT_ROW_LIMIT = 500;
const ROW_LIMIT_OPTIONS = [5, 10, 20, 25, 100, 200, 300, 400, 500];
const NO_ROW_LIMIT = 'none';

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const store = new ConnectionStore(context);
  const consoleSessions = new ConsoleSessionStore(context);
  const mysql = new MySqlAdapter(context.secrets);
  const provider = new DatabaseTreeProvider(store, mysql);
  const resultView = new ResultView();
  const sqlConsoleView = new SqlConsoleView(mysql, consoleSessions);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 80);
  status.command = 'dbCruiser.selectSchema';

  const updateStatus = () => {
    const consoleContext = getConsoleContextForActiveSqlEditor(store, consoleSessions);
    if (consoleContext) {
      status.text = `$(database) ${connectionStatusLabel(consoleContext)}`;
      status.tooltip = schemaStatusTooltip(consoleContext);
      status.show();
      return;
    }
    status.hide();
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dbCruiser.connections', provider),
    vscode.commands.registerCommand('dbCruiser.addMySqlConnection', () => addMySqlConnection(store, mysql, provider)),
    vscode.commands.registerCommand('dbCruiser.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('dbCruiser.removeConnection', (node) => removeConnection(node, store, provider)),
    vscode.commands.registerCommand('dbCruiser.testConnection', (node) => testConnection(node, mysql)),
    vscode.commands.registerCommand('dbCruiser.openSqlConsole', (node) => openSqlConsole(node, store, consoleSessions, sqlConsoleView)),
    vscode.commands.registerCommand('dbCruiser.runQuery', () => runQuery(store, consoleSessions, mysql, resultView, provider)),
    vscode.commands.registerCommand('dbCruiser.selectSchema', async () => {
      await selectSchemaForActiveConsole(store, consoleSessions, mysql);
      updateStatus();
    }),
    vscode.commands.registerCommand('dbCruiser.inspectObject', (node) => inspectObject(node, mysql, resultView)),
    vscode.commands.registerCommand('dbCruiser.selectTop100', (node) => selectTop100(node, mysql, resultView)),
    status
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidCloseTextDocument((document) => consoleSessions.release(document)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        updateStatus();
      }
    })
  );
  updateStatus();
}

function deactivate() {}

class ConnectionStore {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
  }

  all() {
    return this.context.globalState.get(CONNECTIONS_KEY, []).filter((connection) => connection.type === 'mysql');
  }

  get(id) {
    return this.all().find((connection) => connection.id === id);
  }

  async add(connection, password) {
    const connections = this.all().filter((saved) => saved.id !== connection.id);
    connections.push(connection);
    await this.context.globalState.update(CONNECTIONS_KEY, connections);

    if (password !== undefined) {
      if (password.length > 0) {
        await this.context.secrets.store(secretKey(connection.id), password);
      } else {
        await this.context.secrets.delete(secretKey(connection.id));
      }
    }
  }

  async remove(id) {
    const connections = this.all().filter((connection) => connection.id !== id);
    await this.context.globalState.update(CONNECTIONS_KEY, connections);
    await this.context.secrets.delete(secretKey(id));
  }
}

class ConsoleSessionStore {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
    this.documents = new Map();
  }

  bind(document, connectionId, schema) {
    this.documents.set(document.uri.toString(), {
      connectionId,
      schema: schema || undefined
    });
  }

  get(document) {
    return this.documents.get(document.uri.toString());
  }

  release(document) {
    this.documents.delete(document.uri.toString());
  }

  getSavedSchema(connectionId) {
    const schemas = this.context.workspaceState.get(SESSION_SCHEMAS_KEY, {});
    return schemas[connectionId];
  }

  getSavedRowLimit(connectionId) {
    const rowLimits = this.context.workspaceState.get(SESSION_ROW_LIMITS_KEY, {});
    return normalizeRowLimit(rowLimits[connectionId] ?? getMaxRows());
  }

  async setSavedSchema(connectionId, schema) {
    const schemas = {
      ...this.context.workspaceState.get(SESSION_SCHEMAS_KEY, {})
    };
    if (schema) {
      schemas[connectionId] = schema;
    } else {
      delete schemas[connectionId];
    }
    await this.context.workspaceState.update(SESSION_SCHEMAS_KEY, schemas);
  }

  async setSavedRowLimit(connectionId, rowLimit) {
    const rowLimits = {
      ...this.context.workspaceState.get(SESSION_ROW_LIMITS_KEY, {})
    };
    rowLimits[connectionId] = normalizeRowLimit(rowLimit);
    await this.context.workspaceState.update(SESSION_ROW_LIMITS_KEY, rowLimits);
  }

  async setSchema(document, connectionId, schema) {
    this.bind(document, connectionId, schema);
    await this.setSavedSchema(connectionId, schema);
  }
}

class DatabaseTreeProvider {
  /**
   * @param {ConnectionStore} store
   * @param {MySqlAdapter} mysql
   */
  constructor(store, mysql) {
    this.store = store;
    this.mysql = mysql;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node) {
    return node.toTreeItem();
  }

  async getChildren(node) {
    if (!node) {
      const connections = this.store.all();
      if (connections.length === 0) {
        return [TreeNode.message('No MySQL connections yet', 'Use the + button to add one.')];
      }
      return connections.map((connection) => TreeNode.connection(connection));
    }

    if (node.kind === 'connection') {
      return this.loadSchemas(node.connection);
    }

    if (node.kind === 'schema') {
      return [
        TreeNode.group(node.connection, node.schema, 'tables', 'Tables', 'table'),
        TreeNode.group(node.connection, node.schema, 'views', 'Views', 'eye'),
        TreeNode.console(node.connection, node.schema)
      ];
    }

    if (node.kind === 'group' && node.group === 'tables') {
      return this.loadObjects(node.connection, node.schema, 'table');
    }

    if (node.kind === 'group' && node.group === 'views') {
      return this.loadObjects(node.connection, node.schema, 'view');
    }

    if (node.kind === 'object') {
      try {
        if (node.objectType === 'table') {
          return [
            TreeNode.objectGroup(node.connection, node.schema, node.name, 'columns', 'Columns', 'symbol-field'),
            TreeNode.objectGroup(node.connection, node.schema, node.name, 'keys', 'Keys', 'key'),
            TreeNode.objectGroup(node.connection, node.schema, node.name, 'indexes', 'Indexes', 'list-tree'),
            TreeNode.objectGroup(node.connection, node.schema, node.name, 'foreignKeys', 'Foreign Keys', 'references'),
            TreeNode.objectGroup(node.connection, node.schema, node.name, 'triggers', 'Triggers', 'zap')
          ];
        }

        const columns = await this.mysql.columns(node.connection, node.schema, node.name);
        return columns.map((column) => TreeNode.column(node.connection, node.schema, node.name, column));
      } catch (error) {
        return [TreeNode.error(error)];
      }
    }

    if (node.kind === 'objectGroup') {
      return this.loadObjectGroup(node);
    }

    return [];
  }

  async loadSchemas(connection) {
    try {
      const schemas = await this.mysql.schemas(connection);
      if (schemas.length === 0) {
        return [TreeNode.message('No schemas found', '')];
      }

      return schemas.map((schema) => TreeNode.schema(connection, schema.name));
    } catch (error) {
      return [TreeNode.error(error)];
    }
  }

  async loadObjects(connection, schema, objectType) {
    try {
      const objects = await this.mysql.objects(connection, schema, objectType);
      if (objects.length === 0) {
        return [TreeNode.message(`No ${objectType === 'table' ? 'tables' : 'views'} found`, '')];
      }
      return objects.map((object) => TreeNode.dbObject(connection, schema, object.name, object.type));
    } catch (error) {
      return [TreeNode.error(error)];
    }
  }

  async loadObjectGroup(node) {
    try {
      if (node.group === 'columns') {
        const columns = await this.mysql.columns(node.connection, node.schema, node.objectName);
        return columns.length
          ? columns.map((column) => TreeNode.column(node.connection, node.schema, node.objectName, column))
          : [TreeNode.message('No columns found', '')];
      }

      if (node.group === 'keys') {
        const keys = await this.mysql.keys(node.connection, node.schema, node.objectName);
        return keys.length
          ? keys.map((key) => TreeNode.key(node.connection, node.schema, node.objectName, key))
          : [TreeNode.message('No keys found', '')];
      }

      if (node.group === 'indexes') {
        const indexes = await this.mysql.indexes(node.connection, node.schema, node.objectName);
        return indexes.length
          ? indexes.map((index) => TreeNode.index(node.connection, node.schema, node.objectName, index))
          : [TreeNode.message('No indexes found', '')];
      }

      if (node.group === 'foreignKeys') {
        const foreignKeys = await this.mysql.foreignKeys(node.connection, node.schema, node.objectName);
        return foreignKeys.length
          ? foreignKeys.map((foreignKey) => TreeNode.foreignKey(node.connection, node.schema, node.objectName, foreignKey))
          : [TreeNode.message('No foreign keys found', '')];
      }

      if (node.group === 'triggers') {
        const triggers = await this.mysql.triggers(node.connection, node.schema, node.objectName);
        return triggers.length
          ? triggers.map((trigger) => TreeNode.trigger(node.connection, node.schema, node.objectName, trigger))
          : [TreeNode.message('No triggers found', '')];
      }
    } catch (error) {
      return [TreeNode.error(error)];
    }

    return [];
  }
}

class TreeNode {
  constructor(kind, props) {
    this.kind = kind;
    Object.assign(this, props);
  }

  static connection(connection) {
    return new TreeNode('connection', { connection });
  }

  static schema(connection, schema) {
    return new TreeNode('schema', { connection, schema });
  }

  static group(connection, schema, group, label, icon) {
    return new TreeNode('group', { connection, schema, group, label, icon });
  }

  static dbObject(connection, schema, name, objectType) {
    return new TreeNode('object', { connection, schema, name, objectType });
  }

  static objectGroup(connection, schema, objectName, group, label, icon) {
    return new TreeNode('objectGroup', { connection, schema, objectName, group, label, icon });
  }

  static column(connection, schema, objectName, column) {
    return new TreeNode('column', { connection, schema, objectName, column });
  }

  static key(connection, schema, objectName, key) {
    return new TreeNode('key', { connection, schema, objectName, key });
  }

  static index(connection, schema, objectName, index) {
    return new TreeNode('index', { connection, schema, objectName, index });
  }

  static foreignKey(connection, schema, objectName, foreignKey) {
    return new TreeNode('foreignKey', { connection, schema, objectName, foreignKey });
  }

  static trigger(connection, schema, objectName, trigger) {
    return new TreeNode('trigger', { connection, schema, objectName, trigger });
  }

  static console(connection, schema) {
    return new TreeNode('console', { connection, schema });
  }

  static message(label, description) {
    return new TreeNode('message', { label, description });
  }

  static error(error) {
    return new TreeNode('error', {
      label: 'Unable to load database metadata',
      description: error instanceof Error ? error.message : String(error)
    });
  }

  toTreeItem() {
    if (this.kind === 'connection') {
      const item = new vscode.TreeItem(this.connection.name, vscode.TreeItemCollapsibleState.Expanded);
      item.description = 'MySQL';
      item.tooltip = describeConnection(this.connection);
      item.iconPath = new vscode.ThemeIcon('server-environment');
      item.contextValue = 'connection mysql';
      return item;
    }

    if (this.kind === 'schema') {
      const item = new vscode.TreeItem(this.schema, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = this.connection.database === this.schema ? 'default' : undefined;
      item.iconPath = new vscode.ThemeIcon('database');
      item.contextValue = 'schema';
      return item;
    }

    if (this.kind === 'group') {
      const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon(this.icon);
      item.contextValue = 'group';
      return item;
    }

    if (this.kind === 'object') {
      const item = new vscode.TreeItem(this.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = this.schema;
      item.iconPath = new vscode.ThemeIcon(this.objectType === 'view' ? 'eye' : 'table');
      item.contextValue = `object object:${this.objectType}`;
      item.command = {
        command: this.objectType === 'table' ? 'dbCruiser.selectTop100' : 'dbCruiser.inspectObject',
        title: this.objectType === 'table' ? 'Open Data View' : 'Inspect Object',
        arguments: [this]
      };
      return item;
    }

    if (this.kind === 'objectGroup') {
      const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon(this.icon);
      item.contextValue = `objectGroup objectGroup:${this.group}`;
      return item;
    }

    if (this.kind === 'column') {
      const item = new vscode.TreeItem(this.column.name, vscode.TreeItemCollapsibleState.None);
      item.description = formatColumnDescription(this.column);
      item.tooltip = this.column.columnKey === 'PRI' ? 'Primary key' : this.column.type || 'Column';
      item.iconPath = new vscode.ThemeIcon(this.column.columnKey === 'PRI' ? 'key' : 'symbol-field');
      item.contextValue = 'column';
      return item;
    }

    if (this.kind === 'key') {
      const item = new vscode.TreeItem(this.key.name, vscode.TreeItemCollapsibleState.None);
      item.description = formatKeyDescription(this.key);
      item.tooltip = formatKeyTooltip(this.key);
      item.iconPath = new vscode.ThemeIcon(this.key.type === 'PRIMARY KEY' ? 'key' : 'symbol-key');
      item.contextValue = 'key';
      return item;
    }

    if (this.kind === 'index') {
      const item = new vscode.TreeItem(this.index.name, vscode.TreeItemCollapsibleState.None);
      item.description = formatIndexDescription(this.index);
      item.tooltip = this.index.type || 'Index';
      item.iconPath = new vscode.ThemeIcon(this.index.name === 'PRIMARY' ? 'key' : 'list-tree');
      item.contextValue = 'index';
      return item;
    }

    if (this.kind === 'foreignKey') {
      const item = new vscode.TreeItem(this.foreignKey.name, vscode.TreeItemCollapsibleState.None);
      item.description = formatForeignKeyDescription(this.foreignKey);
      item.tooltip = formatForeignKeyTooltip(this.foreignKey);
      item.iconPath = new vscode.ThemeIcon('references');
      item.contextValue = 'foreignKey';
      return item;
    }

    if (this.kind === 'trigger') {
      const item = new vscode.TreeItem(this.trigger.name, vscode.TreeItemCollapsibleState.None);
      item.description = formatTriggerDescription(this.trigger);
      item.tooltip = this.trigger.statement || 'Trigger';
      item.iconPath = new vscode.ThemeIcon('zap');
      item.contextValue = 'trigger';
      return item;
    }

    if (this.kind === 'console') {
      const item = new vscode.TreeItem('SQL Console', vscode.TreeItemCollapsibleState.None);
      item.description = this.schema;
      item.iconPath = new vscode.ThemeIcon('terminal');
      item.contextValue = 'console';
      item.command = {
        command: 'dbCruiser.openSqlConsole',
        title: 'Open SQL Console',
        arguments: [this]
      };
      return item;
    }

    if (this.kind === 'error') {
      const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
      item.description = this.description;
      item.iconPath = new vscode.ThemeIcon('error');
      return item;
    }

    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
    item.description = this.description;
    item.iconPath = new vscode.ThemeIcon('info');
    return item;
  }
}

class MySqlAdapter {
  /**
   * @param {vscode.SecretStorage} secrets
   */
  constructor(secrets) {
    this.secrets = secrets;
    this.driver = undefined;
  }

  loadDriver() {
    if (this.driver) {
      return this.driver;
    }

    try {
      this.driver = require('mysql2/promise');
      return this.driver;
    } catch (error) {
      throw new Error('MySQL support needs the mysql2 package. Run npm install in this extension folder, then reload VS Code.');
    }
  }

  async connect(connection, passwordOverride, options = {}) {
    const mysql = this.loadDriver();
    const password = passwordOverride !== undefined
      ? passwordOverride
      : await this.secrets.get(secretKey(connection.id)) || '';

    return mysql.createConnection({
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password,
      database: (options.database ?? connection.database) || undefined,
      multipleStatements: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      timezone: 'Z',
      connectTimeout: 10000
    });
  }

  async testConnection(connection, passwordOverride) {
    const client = await this.connect(connection, passwordOverride, { database: undefined });
    try {
      await client.ping();
    } finally {
      await client.end();
    }
  }

  async schemas(connection) {
    const client = await this.connect(connection, undefined, { database: undefined });
    try {
      const [rows] = await client.execute(`
        select schema_name as name
        from information_schema.schemata
        where schema_name not in ('information_schema', 'mysql', 'performance_schema', 'sys')
        order by schema_name
      `);
      return prioritizeDefaultSchema(rows, connection.database);
    } finally {
      await client.end();
    }
  }

  async objects(connection, schema, type) {
    const mysqlType = type === 'view' ? 'VIEW' : 'BASE TABLE';
    const client = await this.connect(connection, undefined, { database: undefined });
    try {
      const [rows] = await client.execute(`
        select
          table_name as name,
          case when table_type = 'VIEW' then 'view' else 'table' end as type,
          engine,
          table_rows as rowEstimate
        from information_schema.tables
        where table_schema = ?
          and table_type = ?
        order by table_name
      `, [schema, mysqlType]);
      return rows;
    } finally {
      await client.end();
    }
  }

  async columns(connection, schema, tableName) {
    const client = await this.connect(connection, undefined, { database: undefined });
    try {
      const [rows] = await client.execute(`
        select
          column_name as name,
          column_type as type,
          is_nullable as nullable,
          column_key as columnKey,
          column_default as defaultValue,
          extra,
          ordinal_position as ordinal
        from information_schema.columns
        where table_schema = ?
          and table_name = ?
        order by ordinal_position
      `, [schema, tableName]);
      return rows;
    } finally {
      await client.end();
    }
  }

  async keys(connection, schema, tableName) {
    const client = await this.connect(connection, undefined, { database: undefined });
    try {
      const [rows] = await client.execute(`
        select
          tc.constraint_name as name,
          tc.constraint_type as type,
          group_concat(kcu.column_name order by kcu.ordinal_position separator ', ') as columns
        from information_schema.table_constraints tc
        left join information_schema.key_column_usage kcu
          on kcu.constraint_schema = tc.constraint_schema
          and kcu.constraint_name = tc.constraint_name
          and kcu.table_schema = tc.table_schema
          and kcu.table_name = tc.table_name
        where tc.table_schema = ?
          and tc.table_name = ?
          and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
        group by tc.constraint_name, tc.constraint_type
        order by
          case tc.constraint_type
            when 'PRIMARY KEY' then 1
            when 'UNIQUE' then 2
            else 4
          end,
          tc.constraint_name
      `, [schema, tableName]);
      return rows;
    } finally {
      await client.end();
    }
  }

  async indexes(connection, schema, tableName) {
    const client = await this.connect(connection, undefined, { database: undefined });
    try {
      const [rows] = await client.execute(`
        select
          index_name as name,
          case min(non_unique) when 0 then 'Unique' else 'Non-unique' end as uniqueness,
          index_type as type,
          group_concat(
            if(
              sub_part is null,
              coalesce(column_name, '<expression>'),
              concat(coalesce(column_name, '<expression>'), '(', sub_part, ')')
            )
            order by seq_in_index
            separator ', '
          ) as columns,
          max(cardinality) as cardinality
        from information_schema.statistics
        where table_schema = ?
          and table_name = ?
        group by index_name, index_type
        order by
          case index_name when 'PRIMARY' then 1 else 2 end,
          index_name
      `, [schema, tableName]);
      return rows;
    } finally {
      await client.end();
    }
  }

  async foreignKeys(connection, schema, tableName) {
    const client = await this.connect(connection, undefined, { database: undefined });
    try {
      const [rows] = await client.execute(`
        select
          kcu.constraint_name as name,
          group_concat(kcu.column_name order by kcu.ordinal_position separator ', ') as columns,
          max(kcu.referenced_table_schema) as referencedSchema,
          max(kcu.referenced_table_name) as referencedTable,
          group_concat(kcu.referenced_column_name order by kcu.position_in_unique_constraint separator ', ') as referencedColumns,
          max(rc.update_rule) as updateRule,
          max(rc.delete_rule) as deleteRule
        from information_schema.key_column_usage kcu
        left join information_schema.referential_constraints rc
          on rc.constraint_schema = kcu.constraint_schema
          and rc.constraint_name = kcu.constraint_name
          and rc.table_name = kcu.table_name
        where kcu.table_schema = ?
          and kcu.table_name = ?
          and kcu.referenced_table_name is not null
        group by kcu.constraint_schema, kcu.constraint_name
        order by kcu.constraint_name
      `, [schema, tableName]);
      return rows;
    } finally {
      await client.end();
    }
  }

  async triggers(connection, schema, tableName) {
    const client = await this.connect(connection, undefined, { database: undefined });
    try {
      const [rows] = await client.execute(`
        select
          trigger_name as name,
          action_timing as timing,
          event_manipulation as event,
          action_orientation as orientation,
          action_statement as statement,
          created,
          definer
        from information_schema.triggers
        where trigger_schema = ?
          and event_object_table = ?
        order by event_manipulation, action_timing, trigger_name
      `, [schema, tableName]);
      return rows;
    } finally {
      await client.end();
    }
  }

  async ddl(connection, schema, objectName, objectType) {
    const client = await this.connect(connection, undefined, { database: undefined });
    try {
      const statement = `show create ${objectType === 'view' ? 'view' : 'table'} ${quoteQualified(schema, objectName)}`;
      const [rows] = await client.query(statement);
      const row = rows[0] || {};
      return row['Create Table'] || row['Create View'] || Object.values(row).find((value) => typeof value === 'string' && /^create\s/i.test(value)) || '';
    } finally {
      await client.end();
    }
  }

  async query(connection, sql, schema) {
    const client = await this.connect(connection, undefined, { database: schema || connection.database });
    try {
      const [rows, fields] = await client.query(sql);
      return normalizeMysqlResults(rows, fields);
    } finally {
      await client.end();
    }
  }
}

class ResultView {
  constructor() {
    this.panel = undefined;
  }

  show(title, result) {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'dbCruiser.results',
        'DB Cruiser Results',
        vscode.ViewColumn.Beside,
        {
          enableScripts: false,
          retainContextWhenHidden: true
        }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    this.panel.title = title;
    this.panel.webview.html = renderResultHtml(result);
    this.panel.reveal(vscode.ViewColumn.Beside);
  }
}

class SqlConsoleView {
  /**
   * @param {MySqlAdapter} mysql
   * @param {ConsoleSessionStore} consoleSessions
   */
  constructor(mysql, consoleSessions) {
    this.mysql = mysql;
    this.consoleSessions = consoleSessions;
    this.panels = new Map();
  }

  async open(connection, schema) {
    const selectedSchema = schema || this.consoleSessions.getSavedSchema(connection.id) || connection.database || '';
    const selectedRowLimit = this.consoleSessions.getSavedRowLimit(connection.id);
    if (schema) {
      await this.consoleSessions.setSavedSchema(connection.id, schema);
    }
    const key = connection.id;
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      existing.panel.title = `${connection.name} Console`;
      await existing.panel.webview.postMessage({
        type: 'focus',
        schema: selectedSchema,
        rowLimit: selectedRowLimit
      });
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dbCruiser.sqlConsole',
      `${connection.name} Console`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );
    const disposables = [];
    let schemas = [];
    let schemaError = '';

    try {
      schemas = await this.mysql.schemas(connection);
    } catch (error) {
      schemaError = errorMessage(error);
    }

    panel.webview.html = renderSqlConsoleHtml({
      connection,
      schemas,
      selectedSchema,
      selectedRowLimit,
      schemaError,
      sql: ''
    });

    panel.webview.onDidReceiveMessage(async (message) => {
      if (!message || !['run', 'schemaChanged', 'rowLimitChanged'].includes(message.command)) {
        return;
      }

      const nextSchema = String(message.schema || '').trim();
      const rowLimit = normalizeRowLimit(message.rowLimit);
      await this.consoleSessions.setSavedSchema(connection.id, nextSchema);
      await this.consoleSessions.setSavedRowLimit(connection.id, rowLimit);
      panel.title = `${connection.name} Console`;

      if (message.command === 'schemaChanged') {
        await panel.webview.postMessage({
          type: 'status',
          state: 'success',
          message: nextSchema ? `Schema set to ${nextSchema}.` : 'No schema selected.'
        });
        return;
      }

      if (message.command === 'rowLimitChanged') {
        await panel.webview.postMessage({
          type: 'status',
          state: 'success',
          message: `Row limit set to ${formatRowLimit(rowLimit)}.`
        });
        return;
      }

      const sql = String(message.sql || '');
      if (!sql.trim()) {
        await panel.webview.postMessage({
          type: 'status',
          state: 'error',
          message: 'There is no SQL to run.'
        });
        return;
      }

      await this.run(panel, connection, nextSchema, sql, rowLimit);
    }, undefined, disposables);

    panel.onDidDispose(() => {
      disposables.forEach((disposable) => disposable.dispose());
      this.panels.delete(key);
    });

    this.panels.set(key, { panel });
  }

  async run(panel, connection, schema, sql, rowLimit) {
    await panel.webview.postMessage({
      type: 'status',
      state: 'busy',
      message: `Running on ${schema || connection.database || connection.name} (${formatRowLimit(rowLimit)})...`
    });

    try {
      const started = Date.now();
      const resultSets = await this.mysql.query(connection, appendLimitHint(sql, rowLimit), schema || connection.database);
      const elapsedMs = Date.now() - started;
      await panel.webview.postMessage({
        type: 'results',
        state: 'success',
        message: `Completed in ${elapsedMs} ms.`,
        html: renderQueryResults({
          kind: 'query',
          connection,
          schema: schema || connection.database,
          sql,
          elapsedMs,
          resultSets
        })
      });
    } catch (error) {
      await panel.webview.postMessage({
        type: 'status',
        state: 'error',
        message: errorMessage(error)
      });
    }
  }
}

async function addMySqlConnection(store, mysql, provider) {
  const panel = vscode.window.createWebviewPanel(
    'dbCruiser.connectionForm',
    'DB Cruiser MySQL Connection',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );
  const disposables = [];

  panel.webview.html = renderConnectionFormHtml();
  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || !['test', 'save'].includes(message.command)) {
      return;
    }

    const form = buildConnectionFromForm(message.values);
    if (form.errors.length > 0) {
      await panel.webview.postMessage({
        type: 'status',
        state: 'error',
        message: form.errors.join(' ')
      });
      return;
    }

    if (message.command === 'test') {
      await testConnectionFromForm(panel, mysql, form.connection, form.password);
      return;
    }

    await saveConnectionFromForm(panel, store, mysql, provider, form.connection, form.password);
  }, undefined, disposables);

  panel.onDidDispose(() => {
    disposables.forEach((disposable) => disposable.dispose());
  });
}

async function testConnectionFromForm(panel, mysql, connection, password) {
  await panel.webview.postMessage({
    type: 'status',
    state: 'busy',
    message: 'Testing connection...'
  });

  try {
    await mysql.testConnection(connection, password);
    await panel.webview.postMessage({
      type: 'status',
      state: 'success',
      message: `Connected to ${describeConnection(connection)}.`
    });
  } catch (error) {
    await panel.webview.postMessage({
      type: 'status',
      state: 'error',
      message: errorMessage(error)
    });
  }
}

async function saveConnectionFromForm(panel, store, mysql, provider, connection, password) {
  await panel.webview.postMessage({
    type: 'status',
    state: 'busy',
    message: 'Saving connection...'
  });

  try {
    await mysql.testConnection(connection, password);
  } catch (error) {
    const choice = await vscode.window.showWarningMessage(
      `Could not connect to ${describeConnection(connection)}. ${errorMessage(error)}`,
      'Save Anyway',
      'Keep Editing'
    );
    if (choice !== 'Save Anyway') {
      await panel.webview.postMessage({
        type: 'status',
        state: 'error',
        message: errorMessage(error)
      });
      return;
    }
  }

  await store.add(connection, password);
  provider.refresh();
  await panel.webview.postMessage({
    type: 'status',
    state: 'success',
    message: `Saved ${connection.name}.`
  });
  vscode.window.showInformationMessage(`Saved ${connection.name}.`);
  panel.dispose();
}

function buildConnectionFromForm(values = {}) {
  const host = String(values.host || '').trim();
  const portText = String(values.port || '').trim();
  const user = String(values.user || '').trim();
  const database = String(values.database || '').trim();
  const nameInput = String(values.name || '').trim();
  const password = String(values.password ?? '');
  const port = Number(portText);
  const errors = [];

  if (!host) {
    errors.push('Host is required.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('Port must be between 1 and 65535.');
  }
  if (!user) {
    errors.push('User is required.');
  }

  const name = nameInput || suggestedConnectionName({ host, user, database });
  if (!name) {
    errors.push('Connection name is required.');
  }

  return {
    errors,
    password,
    connection: {
      id: crypto.randomUUID(),
      type: 'mysql',
      name,
      host,
      port,
      user,
      database: database || undefined
    }
  };
}

async function removeConnection(node, store, provider) {
  const connection = node?.connection;
  if (!connection) {
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `Remove "${connection.name}" from DB Cruiser? Stored credentials for this connection will be deleted.`,
    { modal: true },
    'Remove'
  );
  if (answer !== 'Remove') {
    return;
  }

  await store.remove(connection.id);
  provider.refresh();
}

async function testConnection(node, mysql) {
  const connection = node?.connection;
  if (!connection) {
    return;
  }

  try {
    await mysql.testConnection(connection);
    vscode.window.showInformationMessage(`Connected to ${connection.name}.`);
  } catch (error) {
    vscode.window.showErrorMessage(errorMessage(error));
  }
}

async function openSqlConsole(node, store, consoleSessions, sqlConsoleView) {
  const connection = node?.connection || await pickConnection(store);
  if (!connection) {
    return;
  }

  const schema = node?.schema || consoleSessions.getSavedSchema(connection.id) || connection.database;
  await sqlConsoleView.open(connection, schema);
}

async function runQuery(store, consoleSessions, mysql, resultView, provider) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'sql') {
    vscode.window.showInformationMessage('Open a SQL editor before running a query.');
    return;
  }

  const consoleContext = getConsoleContextForDocument(editor.document, store, consoleSessions);
  const connection = consoleContext?.connection || await pickConnection(store);
  if (!connection) {
    return;
  }
  const schema = consoleContext?.schema || connection.database;

  const sql = getSelectedOrFullText(editor);
  if (!sql.trim()) {
    vscode.window.showInformationMessage('There is no SQL to run.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Running query on ${connection.name}`,
      cancellable: false
    },
    async () => {
      try {
        const started = Date.now();
        const maxRows = getMaxRows();
        const resultSets = await mysql.query(connection, appendLimitHint(sql, maxRows), schema);
        resultView.show(`${connection.name} Results`, {
          kind: 'query',
          connection,
          schema,
          sql,
          elapsedMs: Date.now() - started,
          resultSets
        });
        provider.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(errorMessage(error));
      }
    }
  );
}

async function inspectObject(node, mysql, resultView) {
  if (!node?.connection || !node.schema || !node.name || !node.objectType) {
    return;
  }

  try {
    const metadata = [
      mysql.columns(node.connection, node.schema, node.name),
      mysql.ddl(node.connection, node.schema, node.name, node.objectType)
    ];
    if (node.objectType === 'table') {
      metadata.push(
        mysql.keys(node.connection, node.schema, node.name),
        mysql.indexes(node.connection, node.schema, node.name),
        mysql.foreignKeys(node.connection, node.schema, node.name),
        mysql.triggers(node.connection, node.schema, node.name)
      );
    }

    const [columns, ddl, keys = [], indexes = [], foreignKeys = [], triggers = []] = await Promise.all(metadata);
    resultView.show(`${node.name} Details`, {
      kind: 'object',
      connection: node.connection,
      schema: node.schema,
      objectName: node.name,
      objectType: node.objectType,
      columns,
      keys,
      indexes,
      foreignKeys,
      triggers,
      ddl
    });
  } catch (error) {
    vscode.window.showErrorMessage(errorMessage(error));
  }
}

async function selectSchemaForActiveConsole(store, consoleSessions, mysql) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'sql') {
    vscode.window.showInformationMessage('Open a DB Cruiser SQL console before selecting a schema.');
    return;
  }

  const consoleContext = getConsoleContextForDocument(editor.document, store, consoleSessions);
  if (!consoleContext?.connection) {
    vscode.window.showInformationMessage('Open a DB Cruiser SQL console before selecting a schema.');
    return;
  }

  let schemas;
  try {
    schemas = await mysql.schemas(consoleContext.connection);
  } catch (error) {
    vscode.window.showErrorMessage(errorMessage(error));
    return;
  }

  if (schemas.length === 0) {
    vscode.window.showInformationMessage('No schemas were found for this connection.');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    schemas.map((schema) => ({
      label: schema.name,
      description: schema.name === consoleContext.schema ? 'current' : undefined,
      schema: schema.name
    })),
    {
      title: 'Select Console Schema',
      placeHolder: consoleContext.schema || consoleContext.connection.database || 'Choose a schema'
    }
  );
  if (!picked) {
    return;
  }

  await consoleSessions.setSchema(editor.document, consoleContext.connection.id, picked.schema);
  vscode.window.showInformationMessage(`SQL console schema set to ${picked.schema}.`);
}

async function selectTop100(node, mysql, resultView) {
  if (!node?.connection || !node.schema || !node.name) {
    return;
  }

  const sql = `select * from ${quoteQualified(node.schema, node.name)} limit 100;`;
  try {
    const started = Date.now();
    const resultSets = await mysql.query(node.connection, sql, node.schema);
    resultView.show(`${node.name} Data View`, {
      kind: 'query',
      connection: node.connection,
      schema: node.schema,
      sql,
      elapsedMs: Date.now() - started,
      resultSets
    });
  } catch (error) {
    vscode.window.showErrorMessage(errorMessage(error));
  }
}

async function pickConnection(store) {
  const connections = store.all();
  if (connections.length === 0) {
    vscode.window.showInformationMessage('Add a MySQL connection first.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    connections.map((connection) => ({
      label: connection.name,
      description: 'MySQL',
      detail: describeConnection(connection),
      connection
    })),
    { title: 'Choose a database connection' }
  );

  return picked?.connection;
}

function getConsoleContextForActiveSqlEditor(store, consoleSessions) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'sql') {
    return undefined;
  }
  return getConsoleContextForDocument(editor.document, store, consoleSessions);
}

function getConsoleContextForDocument(document, store, consoleSessions) {
  const lineCount = Math.min(document.lineCount, 20);
  const lines = [];
  for (let index = 0; index < lineCount; index += 1) {
    lines.push(document.lineAt(index).text);
  }

  const markerLine = lines.find((line) => line.startsWith(CONSOLE_MARKER) || line.startsWith(LEGACY_CONSOLE_MARKER));
  if (!markerLine) {
    return undefined;
  }
  const marker = markerLine.startsWith(CONSOLE_MARKER) ? CONSOLE_MARKER : LEGACY_CONSOLE_MARKER;
  const id = markerLine.slice(marker.length).trim();
  const connection = store.get(id);
  if (!connection) {
    return undefined;
  }

  const documentSession = consoleSessions.get(document);
  const schemaLine = lines.find((line) => line.startsWith(SCHEMA_MARKER));
  const legacySchema = schemaLine?.slice(SCHEMA_MARKER.length).trim();
  const schema = documentSession?.connectionId === connection.id
    ? documentSession.schema
    : legacySchema || consoleSessions.getSavedSchema(connection.id) || connection.database;
  return {
    connection,
    schema
  };
}

function getMaxRows() {
  const configuration = vscode.workspace.getConfiguration();
  return configuration.get('dbCruiser.mysql.maxRows', configuration.get('dbCruiser.mysql.maxRows', DEFAULT_ROW_LIMIT));
}

function getSelectedOrFullText(editor) {
  if (!editor.selection.isEmpty) {
    return editor.document.getText(editor.selection);
  }

  return editor.document.getText();
}

function appendLimitHint(sql, maxRows) {
  if (maxRows === NO_ROW_LIMIT || maxRows === undefined || maxRows === null) {
    return sql;
  }

  const trimmed = sql.trim();
  const withoutLeadingComments = trimmed.replace(/^(--.*\r?\n|\s)*/g, '');
  const isPlainSelect = /^select\b/i.test(withoutLeadingComments);
  const hasLimit = /\blimit\s+\d+\b/i.test(withoutLeadingComments);
  if (!isPlainSelect || hasLimit) {
    return sql;
  }

  const withoutSemi = trimmed.replace(/;\s*$/, '');
  return `${withoutSemi}\nlimit ${normalizeRowLimit(maxRows)};`;
}

function normalizeRowLimit(value) {
  if (value === NO_ROW_LIMIT) {
    return NO_ROW_LIMIT;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    return DEFAULT_ROW_LIMIT;
  }

  return number;
}

function formatRowLimit(value) {
  const rowLimit = normalizeRowLimit(value);
  return rowLimit === NO_ROW_LIMIT ? 'No Limit' : `${rowLimit} rows`;
}

function normalizeMysqlResults(rows, fields) {
  const isMultiStatement = Array.isArray(rows)
    && Array.isArray(fields)
    && rows.length === fields.length
    && fields.some((value) => Array.isArray(value) || value === undefined);

  if (isMultiStatement) {
    return rows.map((statementRows, index) => normalizeMysqlResultSet(statementRows, Array.isArray(fields) ? fields[index] : undefined, index));
  }

  return [normalizeMysqlResultSet(rows, fields, 0)];
}

function normalizeMysqlResultSet(rows, fields, index) {
  const label = index === 0 ? 'Result' : `Result ${index + 1}`;

  if (Array.isArray(rows)) {
    return {
      label,
      rows: rows.map((row) => ({ ...row }))
    };
  }

  if (isResultHeader(rows)) {
    return {
      label,
      rows: [],
      message: formatResultHeader(rows)
    };
  }

  return {
    label,
    rows: [],
    message: fields ? 'Statement executed successfully.' : 'No rows returned.'
  };
}

function isResultHeader(value) {
  return Boolean(value && typeof value === 'object' && (
    Object.prototype.hasOwnProperty.call(value, 'affectedRows') ||
    Object.prototype.hasOwnProperty.call(value, 'insertId') ||
    Object.prototype.hasOwnProperty.call(value, 'warningStatus')
  ));
}

function formatResultHeader(header) {
  const parts = [];
  if (Number.isInteger(header.affectedRows)) {
    parts.push(`${header.affectedRows} row${header.affectedRows === 1 ? '' : 's'} affected`);
  }
  if (header.insertId) {
    parts.push(`insert id ${header.insertId}`);
  }
  if (Number.isInteger(header.warningStatus) && header.warningStatus > 0) {
    parts.push(`${header.warningStatus} warning${header.warningStatus === 1 ? '' : 's'}`);
  }
  return parts.join(', ') || 'Statement executed successfully.';
}

function prioritizeDefaultSchema(rows, defaultSchema) {
  const schemas = rows.map((row) => ({ name: row.name }));
  if (!defaultSchema) {
    return schemas;
  }

  return schemas.sort((left, right) => {
    if (left.name === defaultSchema) {
      return -1;
    }
    if (right.name === defaultSchema) {
      return 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function quoteQualified(schema, name) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function formatColumnDescription(column) {
  const parts = [];
  if (column.type) {
    parts.push(column.type);
  }
  if (column.nullable === 'NO') {
    parts.push('not null');
  }
  if (column.columnKey) {
    parts.push(column.columnKey.toLowerCase());
  }
  if (column.extra) {
    parts.push(column.extra);
  }
  return parts.join(' ');
}

function formatKeyDescription(key) {
  const parts = [];
  if (key.type) {
    parts.push(formatConstraintType(key.type));
  }
  if (key.columns) {
    parts.push(`(${key.columns})`);
  }
  return parts.join(' ');
}

function formatKeyTooltip(key) {
  return formatKeyDescription(key) || 'Key';
}

function formatIndexDescription(index) {
  const parts = [];
  if (index.uniqueness) {
    parts.push(index.uniqueness);
  }
  if (index.type) {
    parts.push(index.type);
  }
  if (index.columns) {
    parts.push(`(${index.columns})`);
  }
  if (index.cardinality !== null && index.cardinality !== undefined) {
    parts.push(`cardinality ${index.cardinality}`);
  }
  return parts.join(' ');
}

function formatForeignKeyDescription(foreignKey) {
  const parts = [];
  if (foreignKey.columns) {
    parts.push(foreignKey.columns);
  }
  const target = formatForeignKeyTarget(foreignKey);
  if (target) {
    parts.push(`-> ${target}`);
  }
  return parts.join(' ');
}

function formatForeignKeyTooltip(foreignKey) {
  return [
    `Foreign key ${foreignKey.name}`,
    formatForeignKeyDescription(foreignKey),
    ...formatForeignKeyRules(foreignKey)
  ].filter(Boolean).join('\n');
}

function formatTriggerDescription(trigger) {
  return [trigger.timing, trigger.event].filter(Boolean).join(' ') || 'Trigger';
}

function formatConstraintType(type) {
  if (type === 'PRIMARY KEY') {
    return 'Primary key';
  }
  if (type === 'UNIQUE') {
    return 'Unique';
  }
  if (type === 'FOREIGN KEY') {
    return 'Foreign key';
  }
  return String(type || 'Key');
}

function formatForeignKeyTarget(foreignKey) {
  if (!foreignKey.referencedTable) {
    return '';
  }

  const schema = foreignKey.referencedSchema ? `${foreignKey.referencedSchema}.` : '';
  const columns = foreignKey.referencedColumns ? `(${foreignKey.referencedColumns})` : '';
  return `${schema}${foreignKey.referencedTable}${columns}`;
}

function formatForeignKeyRules(foreignKey) {
  const rules = [];
  if (foreignKey.updateRule) {
    rules.push(`on update ${String(foreignKey.updateRule).toLowerCase()}`);
  }
  if (foreignKey.deleteRule) {
    rules.push(`on delete ${String(foreignKey.deleteRule).toLowerCase()}`);
  }
  return rules;
}

function suggestedConnectionName({ host, user, database }) {
  if (database) {
    return `${database} (${host})`;
  }
  if (user && host) {
    return `${user}@${host}`;
  }
  return '';
}

function renderSqlConsoleHtml({ connection, schemas, selectedSchema, selectedRowLimit, schemaError, sql }) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const initialStatus = schemaError ? escapeHtml(schemaError) : '';
  const initialStatusClass = schemaError ? 'status error' : 'status';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --bg-soft: var(--vscode-editorWidget-background);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --error: var(--vscode-errorForeground);
      --success: var(--vscode-testing-iconPassed);
    }
    body {
      margin: 0;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .console {
      display: grid;
      grid-template-rows: auto minmax(220px, 36vh) auto minmax(0, 1fr);
      min-height: 100vh;
    }
    .toolbar {
      display: flex;
      align-items: end;
      gap: 10px;
      border-bottom: 1px solid var(--border);
      padding: 12px;
      background: var(--bg-soft);
    }
    .console-title {
      min-width: 180px;
      margin-right: auto;
    }
    .console-title h1 {
      margin: 0 0 3px;
      font-size: 14px;
      font-weight: 600;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
    }
    label {
      display: grid;
      gap: 4px;
      min-width: 220px;
      font-weight: 600;
    }
    .limit-label {
      min-width: 132px;
    }
    select, textarea {
      box-sizing: border-box;
      border: 1px solid var(--input-border);
      border-radius: 4px;
      color: var(--input-fg);
      background: var(--input-bg);
      font: inherit;
    }
    select {
      min-height: 30px;
      padding: 4px 8px;
    }
    textarea {
      width: 100%;
      height: 100%;
      resize: none;
      border: 0;
      border-bottom: 1px solid var(--border);
      border-radius: 0;
      padding: 12px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.45;
    }
    select:focus, textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    button {
      border: 0;
      border-radius: 4px;
      min-height: 30px;
      padding: 5px 12px;
      color: var(--button-fg);
      background: var(--button-bg);
      font: inherit;
      cursor: pointer;
    }
    button:hover {
      background: var(--button-hover);
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .status {
      min-height: 18px;
      padding: 8px 12px;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
    }
    .status.error {
      color: var(--error);
    }
    .status.success {
      color: var(--success);
    }
    .results {
      overflow: auto;
    }
    .shell {
      display: grid;
      gap: 14px;
      padding: 16px;
    }
    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
    }
    .title {
      margin: 0 0 4px;
      font-size: 15px;
      font-weight: 600;
    }
    .pill {
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 3px 7px;
      color: var(--muted);
      white-space: nowrap;
    }
    .block {
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg-soft);
    }
    .block-title {
      border-bottom: 1px solid var(--border);
      padding: 8px 10px;
      font-weight: 600;
    }
    .scroller {
      overflow: auto;
      max-height: 52vh;
    }
    table {
      border-collapse: collapse;
      min-width: 100%;
      background: var(--vscode-editor-background);
    }
    th, td {
      border-right: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--bg-soft);
      font-weight: 600;
    }
    code, pre {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    pre {
      margin: 0;
      padding: 12px;
      overflow: auto;
      white-space: pre-wrap;
      background: var(--vscode-textCodeBlock-background);
    }
    .empty {
      color: var(--muted);
      padding: 16px;
    }
    @media (max-width: 720px) {
      .toolbar {
        align-items: stretch;
        flex-direction: column;
      }
      .console-title, label {
        min-width: 0;
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main class="console">
    <section class="toolbar">
      <div class="console-title">
        <h1>${escapeHtml(connection.name)}</h1>
        <div class="meta">${escapeHtml(describeConnection(connection))}</div>
      </div>
      <label>
        Schema
        <select id="schema">
          ${renderSchemaOptions(schemas, selectedSchema)}
        </select>
      </label>
      <label class="limit-label">
        Limit
        <select id="row-limit">
          ${renderRowLimitOptions(selectedRowLimit)}
        </select>
      </label>
      <button id="run" type="button">Run</button>
      <button id="clear" class="secondary" type="button">Clear</button>
    </section>
    <textarea id="sql" spellcheck="false">${escapeHtml(sql)}</textarea>
    <div id="status" class="${initialStatusClass}" role="status" aria-live="polite">${initialStatus}</div>
    <section id="results" class="results"></section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const schema = document.getElementById('schema');
    const rowLimit = document.getElementById('row-limit');
    const sql = document.getElementById('sql');
    const run = document.getElementById('run');
    const clear = document.getElementById('clear');
    const status = document.getElementById('status');
    const results = document.getElementById('results');

    function setBusy(isBusy) {
      run.disabled = isBusy;
      clear.disabled = isBusy;
      schema.disabled = isBusy;
      rowLimit.disabled = isBusy;
    }

    function setStatus(state, message) {
      status.className = state ? 'status ' + state : 'status';
      status.textContent = message || '';
    }

    function execute() {
      setBusy(true);
      setStatus('busy', 'Running...');
      vscode.postMessage({
        command: 'run',
        schema: schema.value,
        rowLimit: rowLimit.value,
        sql: sql.value
      });
    }

    run.addEventListener('click', execute);
    clear.addEventListener('click', () => {
      sql.value = '';
      results.innerHTML = '';
      setStatus('', '');
      sql.focus();
    });
    schema.addEventListener('change', () => {
      vscode.postMessage({
        command: 'schemaChanged',
        schema: schema.value,
        rowLimit: rowLimit.value
      });
    });
    rowLimit.addEventListener('change', () => {
      vscode.postMessage({
        command: 'rowLimitChanged',
        schema: schema.value,
        rowLimit: rowLimit.value
      });
    });
    sql.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        execute();
      }
    });
    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'focus') {
        if (message.schema !== undefined) {
          schema.value = message.schema;
        }
        if (message.rowLimit !== undefined) {
          rowLimit.value = message.rowLimit;
        }
        sql.focus();
        return;
      }
      if (message.type === 'results') {
        setBusy(false);
        setStatus(message.state, message.message);
        results.innerHTML = message.html || '';
        return;
      }
      if (message.type === 'status') {
        setBusy(message.state === 'busy');
        setStatus(message.state, message.message);
      }
    });
    sql.focus();
  </script>
</body>
</html>`;
}

function renderSchemaOptions(schemas, selectedSchema) {
  const names = schemas.map((schema) => schema.name);
  if (selectedSchema && !names.includes(selectedSchema)) {
    names.unshift(selectedSchema);
  }

  return [
    `<option value=""${selectedSchema ? '' : ' selected'}>No schema</option>`,
    ...names.map((name) => `<option value="${escapeHtml(name)}"${name === selectedSchema ? ' selected' : ''}>${escapeHtml(name)}</option>`)
  ].join('');
}

function renderRowLimitOptions(selectedRowLimit) {
  const rowLimit = normalizeRowLimit(selectedRowLimit);
  const options = ROW_LIMIT_OPTIONS.includes(rowLimit) || rowLimit === NO_ROW_LIMIT
    ? ROW_LIMIT_OPTIONS
    : [...ROW_LIMIT_OPTIONS, rowLimit].filter((value) => value !== NO_ROW_LIMIT).sort((left, right) => left - right);

  return [
    ...options.map((value) => `<option value="${value}"${value === rowLimit ? ' selected' : ''}>${value}</option>`),
    `<option value="${NO_ROW_LIMIT}"${rowLimit === NO_ROW_LIMIT ? ' selected' : ''}>No Limit</option>`
  ].join('');
}

function renderConnectionFormHtml() {
  const nonce = crypto.randomBytes(16).toString('base64');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --secondary-bg: var(--vscode-button-secondaryBackground);
      --secondary-fg: var(--vscode-button-secondaryForeground);
      --secondary-hover: var(--vscode-button-secondaryHoverBackground);
      --error: var(--vscode-errorForeground);
      --success: var(--vscode-testing-iconPassed);
    }
    body {
      margin: 0;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    main {
      max-width: 720px;
      padding: 24px;
    }
    h1 {
      margin: 0 0 18px;
      font-size: 18px;
      font-weight: 600;
    }
    form {
      display: grid;
      gap: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 120px;
      gap: 12px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--vscode-editor-foreground);
      font-weight: 600;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 7px 8px;
      color: var(--input-fg);
      background: var(--input-bg);
      font: inherit;
      font-weight: 400;
    }
    input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 4px;
    }
    button {
      border: 0;
      border-radius: 4px;
      padding: 7px 12px;
      color: var(--button-fg);
      background: var(--button-bg);
      font: inherit;
      cursor: pointer;
    }
    button:hover {
      background: var(--button-hover);
    }
    button.secondary {
      color: var(--secondary-fg);
      background: var(--secondary-bg);
    }
    button.secondary:hover {
      background: var(--secondary-hover);
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .status {
      min-height: 18px;
      color: var(--muted);
    }
    .status.error {
      color: var(--error);
    }
    .status.success {
      color: var(--success);
    }
    @media (max-width: 560px) {
      main {
        padding: 16px;
      }
      .grid {
        grid-template-columns: 1fr;
      }
      .actions {
        align-items: stretch;
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <main>
    <h1>MySQL Connection</h1>
    <form>
      <div class="grid">
        <label>
          Host
          <input id="host" name="host" value="127.0.0.1" required autocomplete="off">
        </label>
        <label>
          Port
          <input id="port" name="port" value="3306" inputmode="numeric" pattern="[0-9]+" required autocomplete="off">
        </label>
      </div>
      <div class="grid">
        <label>
          User
          <input id="user" name="user" value="root" required autocomplete="username">
        </label>
        <label>
          Password
          <input id="password" name="password" type="password" autocomplete="current-password">
        </label>
      </div>
      <label>
        Default Database
        <input id="database" name="database" autocomplete="off">
      </label>
      <label>
        Connection Name
        <input id="name" name="name" value="root@127.0.0.1" required autocomplete="off">
      </label>
      <div class="actions">
        <button id="save" type="submit">Save Connection</button>
        <button id="test" class="secondary" type="button">Test Connection</button>
      </div>
      <div id="status" class="status" role="status" aria-live="polite"></div>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.querySelector('form');
    const status = document.getElementById('status');
    const saveButton = document.getElementById('save');
    const testButton = document.getElementById('test');
    const hostInput = document.getElementById('host');
    const userInput = document.getElementById('user');
    const databaseInput = document.getElementById('database');
    const nameInput = document.getElementById('name');

    function value(id) {
      return document.getElementById(id).value;
    }

    function collect() {
      return {
        host: value('host'),
        port: value('port'),
        user: value('user'),
        password: value('password'),
        database: value('database'),
        name: value('name')
      };
    }

    function suggestedName() {
      const host = value('host').trim() || '127.0.0.1';
      const user = value('user').trim() || 'root';
      const database = value('database').trim();
      return database ? database + ' (' + host + ')' : user + '@' + host;
    }

    function syncName() {
      if (nameInput.dataset.touched === 'true') {
        return;
      }
      nameInput.value = suggestedName();
    }

    function setBusy(isBusy) {
      saveButton.disabled = isBusy;
      testButton.disabled = isBusy;
    }

    function setStatus(state, message) {
      status.className = state ? 'status ' + state : 'status';
      status.textContent = message || '';
    }

    function post(command) {
      if (!form.reportValidity()) {
        return;
      }
      setBusy(true);
      setStatus('busy', command === 'test' ? 'Testing connection...' : 'Saving connection...');
      vscode.postMessage({
        command,
        values: collect()
      });
    }

    hostInput.addEventListener('input', syncName);
    userInput.addEventListener('input', syncName);
    databaseInput.addEventListener('input', syncName);
    nameInput.addEventListener('input', () => {
      nameInput.dataset.touched = 'true';
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      post('save');
    });
    testButton.addEventListener('click', () => post('test'));
    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type !== 'status') {
        return;
      }
      setBusy(false);
      setStatus(message.state, message.message);
    });
  </script>
</body>
</html>`;
}

function renderResultHtml(result) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const body = result.kind === 'object' ? renderObjectDetails(result) : renderQueryResults(result);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --bg-soft: var(--vscode-editorWidget-background);
      --accent: var(--vscode-focusBorder);
    }
    body {
      margin: 0;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .shell {
      display: grid;
      gap: 14px;
      padding: 16px;
    }
    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
    }
    .title {
      margin: 0 0 4px;
      font-size: 15px;
      font-weight: 600;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
    }
    .pill {
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 3px 7px;
      color: var(--muted);
      white-space: nowrap;
    }
    .block {
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg-soft);
    }
    .block-title {
      border-bottom: 1px solid var(--border);
      padding: 8px 10px;
      font-weight: 600;
    }
    .scroller {
      overflow: auto;
      max-height: 62vh;
    }
    table {
      border-collapse: collapse;
      min-width: 100%;
      background: var(--vscode-editor-background);
    }
    th, td {
      border-right: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--vscode-editorWidget-background);
      font-weight: 600;
    }
    code, pre {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    pre {
      margin: 0;
      padding: 12px;
      overflow: auto;
      white-space: pre-wrap;
      background: var(--vscode-textCodeBlock-background);
    }
    .empty {
      color: var(--muted);
      padding: 16px;
    }
  </style>
</head>
<body>
  <main class="shell">
    ${body}
  </main>
</body>
</html>`;
}

function renderQueryResults(result) {
  const resultBlocks = result.resultSets.map((set, index) => {
    const title = set.label || `Result ${index + 1}`;
    if (!set.rows.length) {
      return `<section class="block">
        <div class="block-title">${escapeHtml(title)}</div>
        <div class="empty">${escapeHtml(set.message || 'No rows returned.')}</div>
      </section>`;
    }

    return `<section class="block">
      <div class="block-title">${escapeHtml(title)} · ${set.rows.length} row${set.rows.length === 1 ? '' : 's'}</div>
      <div class="scroller">${renderTable(set.rows)}</div>
    </section>`;
  }).join('');

  return `<header class="header">
    <div>
      <h1 class="title">${escapeHtml(result.connection.name)}</h1>
      <div class="meta">${escapeHtml(describeQueryTarget(result))}</div>
    </div>
    <span class="pill">${result.elapsedMs} ms</span>
  </header>
  <section class="block">
    <div class="block-title">SQL</div>
    <pre><code>${escapeHtml(result.sql)}</code></pre>
  </section>
  ${resultBlocks}`;
}

function renderObjectDetails(result) {
  const tableMetadata = result.objectType === 'table'
    ? [
        renderObjectTableBlock('Keys', result.keys, 'No keys found.'),
        renderObjectTableBlock('Indexes', result.indexes, 'No indexes found.'),
        renderObjectTableBlock('Foreign Keys', result.foreignKeys, 'No foreign keys found.'),
        renderObjectTableBlock('Triggers', result.triggers, 'No triggers found.')
      ].join('')
    : '';

  return `<header class="header">
    <div>
      <h1 class="title">${escapeHtml(result.objectName)}</h1>
      <div class="meta">${escapeHtml(result.connection.name)} · ${escapeHtml(result.schema)} · ${escapeHtml(result.objectType)}</div>
    </div>
    <span class="pill">${result.columns.length} column${result.columns.length === 1 ? '' : 's'}</span>
  </header>
  <section class="block">
    <div class="block-title">Columns</div>
    <div class="scroller">${renderTable(result.columns)}</div>
  </section>
  ${tableMetadata}
  <section class="block">
    <div class="block-title">DDL</div>
    <pre><code>${escapeHtml(result.ddl || 'No DDL available.')}</code></pre>
  </section>`;
}

function renderObjectTableBlock(title, rows = [], emptyLabel = 'No rows.') {
  return `<section class="block">
    <div class="block-title">${escapeHtml(title)}</div>
    <div class="scroller">${rows.length ? renderTable(rows) : `<div class="empty">${escapeHtml(emptyLabel)}</div>`}</div>
  </section>`;
}

function renderTable(rows) {
  if (!rows.length) {
    return '<div class="empty">No rows.</div>';
  }

  const columns = Array.from(rows.reduce((keys, row) => {
    Object.keys(row).forEach((key) => keys.add(key));
    return keys;
  }, new Set()));

  const head = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
  const body = rows.map((row) => {
    const cells = columns.map((column) => `<td>${escapeHtml(formatCell(row[column]))}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function formatCell(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (Buffer.isBuffer(value)) {
    return `<binary ${value.length} bytes>`;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function describeConnection(connection) {
  const base = `${connection.user}@${connection.host}:${connection.port}`;
  return connection.database ? `${base}/${connection.database}` : base;
}

function connectionStatusLabel(consoleContext) {
  const schema = consoleContext.schema ? `/${consoleContext.schema}` : '';
  return `${consoleContext.connection.name}${schema}`;
}

function schemaStatusTooltip(consoleContext) {
  const schema = consoleContext.schema || 'No schema selected';
  return `${describeConnection(consoleContext.connection)}\nSchema: ${schema}\nClick to select schema`;
}

function describeQueryTarget(result) {
  const schema = result.schema ? ` · ${result.schema}` : '';
  return `${describeConnection(result.connection)}${schema}`;
}

function secretKey(id) {
  return `${MYSQL_PASSWORD_PREFIX}${id}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  activate,
  deactivate
};
