const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONNECTIONS_KEY = 'dbCruiser.connections';
const SESSION_SCHEMAS_KEY = 'dbCruiser.consoleSessionSchemas';
const SESSION_ROW_LIMITS_KEY = 'dbCruiser.consoleSessionRowLimits';
const SESSION_SQL_KEY = 'dbCruiser.consoleSessionSql';
const CONSOLE_MARKER = '-- db-cruiser:connection=';
const SCHEMA_MARKER = '-- db-cruiser:schema=';
const LEGACY_CONSOLE_MARKER = '-- database-pilot:connection=';
const MYSQL_PASSWORD_PREFIX = 'dbCruiser.mysql.password.';
const SSH_PASSWORD_PREFIX = 'dbCruiser.ssh.password.';
const SSH_PASSPHRASE_PREFIX = 'dbCruiser.ssh.passphrase.';
const DEFAULT_ROW_LIMIT = 500;
const ROW_LIMIT_OPTIONS = [5, 10, 20, 25, 100, 200, 300, 400, 500];
const NO_ROW_LIMIT = 'none';
const METADATA_CACHE_TTL_MS = 60 * 1000;
const CONNECTION_COLORS = [
  { id: 'default', label: 'Default', hex: '#8a8a8a', themeColor: undefined },
  { id: 'blue', label: 'Blue', hex: '#3794ff', themeColor: 'charts.blue' },
  { id: 'green', label: 'Green', hex: '#89d185', themeColor: 'charts.green' },
  { id: 'yellow', label: 'Yellow', hex: '#cca700', themeColor: 'charts.yellow' },
  { id: 'orange', label: 'Orange', hex: '#d18616', themeColor: 'charts.orange' },
  { id: 'red', label: 'Red', hex: '#f14c4c', themeColor: 'charts.red' },
  { id: 'purple', label: 'Purple', hex: '#b180d7', themeColor: 'charts.purple' }
];
const CONNECTION_COLOR_IDS = new Set(CONNECTION_COLORS.map((color) => color.id));
const SQL_RESERVED_WORDS = new Set([
  'add', 'all', 'alter', 'and', 'as', 'asc', 'between', 'by', 'case', 'create', 'cross',
  'delete', 'desc', 'distinct', 'drop', 'else', 'end', 'exists', 'from', 'full', 'group',
  'having', 'in', 'inner', 'insert', 'into', 'is', 'join', 'left', 'like', 'limit',
  'not', 'null', 'on', 'or', 'order', 'outer', 'right', 'select', 'set', 'then',
  'union', 'update', 'values', 'when', 'where'
]);

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const store = new ConnectionStore(context);
  const consoleSessions = new ConsoleSessionStore(context);
  const mysql = new MySqlAdapter(context.secrets);
  const provider = new DatabaseTreeProvider(store, mysql);
  const resultView = new ResultView(context.extensionUri);
  const sqlCompletionCache = new SqlCompletionMetadataCache(mysql);
  const sqlCompletionProvider = new SqlCompletionProvider(store, consoleSessions, sqlCompletionCache);
  const sqlConsoleView = new SqlConsoleView(mysql, consoleSessions, sqlCompletionCache, context.extensionUri);
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
    vscode.languages.registerCompletionItemProvider({ language: 'sql' }, sqlCompletionProvider, '.', ' ', '`'),
    vscode.window.registerTreeDataProvider('dbCruiser.connections', provider),
    vscode.commands.registerCommand('dbCruiser.addMySqlConnection', () => addMySqlConnection(store, mysql, provider)),
    vscode.commands.registerCommand('dbCruiser.editConnection', (node) => editConnection(node, store, mysql, provider)),
    vscode.commands.registerCommand('dbCruiser.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('dbCruiser.removeConnection', (node) => removeConnection(node, store, provider)),
    vscode.commands.registerCommand('dbCruiser.testConnection', (node) => testConnection(node, mysql)),
    vscode.commands.registerCommand('dbCruiser.openSqlConsole', async (node) => {
      await openSqlConsole(node, store, consoleSessions, sqlConsoleView);
      updateStatus();
    }),
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

  async add(connection, credentials) {
    const connections = this.all();
    const existingIndex = connections.findIndex((saved) => saved.id === connection.id);
    if (existingIndex >= 0) {
      connections[existingIndex] = connection;
    } else {
      connections.push(connection);
    }
    await this.context.globalState.update(CONNECTIONS_KEY, connections);

    const mysqlPassword = normalizeCredentialValue(
      typeof credentials === 'object' && credentials !== null ? credentials.mysqlPassword : credentials
    );
    const sshPassword = normalizeCredentialValue(credentials?.sshPassword);
    const sshPassphrase = normalizeCredentialValue(credentials?.sshPassphrase);

    if (mysqlPassword !== undefined) {
      if (mysqlPassword.length > 0) {
        await this.context.secrets.store(secretKey(connection.id), mysqlPassword);
      } else {
        await this.context.secrets.delete(secretKey(connection.id));
      }
    }

    if (sshPassword !== undefined) {
      if (sshPassword.length > 0) {
        await this.context.secrets.store(sshPasswordSecretKey(connection.id), sshPassword);
      } else {
        await this.context.secrets.delete(sshPasswordSecretKey(connection.id));
      }
    }

    if (sshPassphrase !== undefined) {
      if (sshPassphrase.length > 0) {
        await this.context.secrets.store(sshPassphraseSecretKey(connection.id), sshPassphrase);
      } else {
        await this.context.secrets.delete(sshPassphraseSecretKey(connection.id));
      }
    }
  }

  async remove(id) {
    const connections = this.all().filter((connection) => connection.id !== id);
    await this.context.globalState.update(CONNECTIONS_KEY, connections);
    await this.context.secrets.delete(secretKey(id));
    await this.context.secrets.delete(sshPasswordSecretKey(id));
    await this.context.secrets.delete(sshPassphraseSecretKey(id));
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

  getSavedSql(connectionId) {
    const documents = this.context.workspaceState.get(SESSION_SQL_KEY, {});
    return documents[connectionId];
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

  async setSavedSql(connectionId, sql) {
    const documents = {
      ...this.context.workspaceState.get(SESSION_SQL_KEY, {})
    };
    documents[connectionId] = String(sql || '');
    await this.context.workspaceState.update(SESSION_SQL_KEY, documents);
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
      item.description = this.connection.ssh?.enabled ? 'MySQL via SSH' : 'MySQL';
      item.tooltip = describeConnection(this.connection);
      item.iconPath = connectionThemeIcon('server-environment', this.connection);
      item.contextValue = 'connection mysql';
      return item;
    }

    if (this.kind === 'schema') {
      const item = new vscode.TreeItem(this.schema, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = this.connection.database === this.schema ? 'default' : undefined;
      item.iconPath = connectionThemeIcon('database', this.connection);
      item.contextValue = 'schema';
      return item;
    }

    if (this.kind === 'group') {
      const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = connectionThemeIcon(this.icon, this.connection);
      item.contextValue = 'group';
      return item;
    }

    if (this.kind === 'object') {
      const item = new vscode.TreeItem(this.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = this.schema;
      item.iconPath = connectionThemeIcon(this.objectType === 'view' ? 'eye' : 'table', this.connection);
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
      item.iconPath = connectionThemeIcon(this.icon, this.connection);
      item.contextValue = `objectGroup objectGroup:${this.group}`;
      return item;
    }

    if (this.kind === 'column') {
      const item = new vscode.TreeItem(this.column.name, vscode.TreeItemCollapsibleState.None);
      item.description = formatColumnDescription(this.column);
      item.tooltip = this.column.columnKey === 'PRI' ? 'Primary key' : this.column.type || 'Column';
      item.iconPath = connectionThemeIcon(this.column.columnKey === 'PRI' ? 'key' : 'symbol-field', this.connection);
      item.contextValue = 'column';
      return item;
    }

    if (this.kind === 'key') {
      const item = new vscode.TreeItem(this.key.name, vscode.TreeItemCollapsibleState.None);
      item.description = formatKeyDescription(this.key);
      item.tooltip = formatKeyTooltip(this.key);
      item.iconPath = connectionThemeIcon(this.key.type === 'PRIMARY KEY' ? 'key' : 'symbol-key', this.connection);
      item.contextValue = 'key';
      return item;
    }

    if (this.kind === 'index') {
      const item = new vscode.TreeItem(this.index.name, vscode.TreeItemCollapsibleState.None);
      item.description = formatIndexDescription(this.index);
      item.tooltip = this.index.type || 'Index';
      item.iconPath = connectionThemeIcon(this.index.name === 'PRIMARY' ? 'key' : 'list-tree', this.connection);
      item.contextValue = 'index';
      return item;
    }

    if (this.kind === 'foreignKey') {
      const item = new vscode.TreeItem(this.foreignKey.name, vscode.TreeItemCollapsibleState.None);
      item.description = formatForeignKeyDescription(this.foreignKey);
      item.tooltip = formatForeignKeyTooltip(this.foreignKey);
      item.iconPath = connectionThemeIcon('references', this.connection);
      item.contextValue = 'foreignKey';
      return item;
    }

    if (this.kind === 'trigger') {
      const item = new vscode.TreeItem(this.trigger.name, vscode.TreeItemCollapsibleState.None);
      item.description = formatTriggerDescription(this.trigger);
      item.tooltip = this.trigger.statement || 'Trigger';
      item.iconPath = connectionThemeIcon('zap', this.connection);
      item.contextValue = 'trigger';
      return item;
    }

    if (this.kind === 'console') {
      const item = new vscode.TreeItem('SQL Console', vscode.TreeItemCollapsibleState.None);
      item.description = this.schema;
      item.iconPath = connectionThemeIcon('terminal', this.connection);
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
    this.sshDriver = undefined;
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

  loadSshDriver() {
    if (this.sshDriver) {
      return this.sshDriver;
    }

    try {
      this.sshDriver = require('ssh2').Client;
      return this.sshDriver;
    } catch (error) {
      throw new Error('SSH tunnel support needs the ssh2 package. Run npm install in this extension folder, then reload VS Code.');
    }
  }

  async connect(connection, credentialOverride, options = {}) {
    const mysql = this.loadDriver();
    const credentials = await this.resolveCredentials(connection, credentialOverride);
    const config = {
      user: connection.user,
      password: credentials.mysqlPassword,
      database: (options.database ?? connection.database) || undefined,
      multipleStatements: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      timezone: 'Z',
      connectTimeout: 10000
    };

    if (!connection.ssh?.enabled) {
      return mysql.createConnection({
        ...config,
        host: connection.host,
        port: connection.port
      });
    }

    const tunnel = await this.createSshTunnel(connection, credentials);
    try {
      const client = await mysql.createConnection({
        ...config,
        stream: tunnel.stream
      });
      tunnel.stream.once('close', () => tunnel.ssh.end());
      tunnel.stream.once('error', () => tunnel.ssh.end());
      return client;
    } catch (error) {
      tunnel.stream.destroy();
      tunnel.ssh.end();
      throw error;
    }
  }

  async resolveCredentials(connection, credentialOverride) {
    const override = typeof credentialOverride === 'object' && credentialOverride !== null
      ? credentialOverride
      : { mysqlPassword: credentialOverride };

    return {
      mysqlPassword: override.mysqlPassword !== undefined
        ? override.mysqlPassword
        : await this.secrets.get(secretKey(connection.id)) || '',
      sshPassword: override.sshPassword !== undefined
        ? override.sshPassword
        : await this.secrets.get(sshPasswordSecretKey(connection.id)) || '',
      sshPassphrase: override.sshPassphrase !== undefined
        ? override.sshPassphrase
        : await this.secrets.get(sshPassphraseSecretKey(connection.id)) || ''
    };
  }

  async createSshTunnel(connection, credentials) {
    const Client = this.loadSshDriver();
    const ssh = new Client();
    const sshConfig = await this.buildSshConfig(connection, credentials);

    return new Promise((resolve, reject) => {
      let settled = false;

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        ssh.end();
        reject(error);
      };

      ssh
        .once('ready', () => {
          ssh.forwardOut(
            '127.0.0.1',
            connection.port,
            connection.host,
            connection.port,
            (error, stream) => {
              if (error) {
                fail(error);
                return;
              }
              settled = true;
              resolve({ ssh, stream });
            }
          );
        })
        .once('error', fail)
        .once('end', () => fail(new Error('SSH connection ended before the MySQL tunnel was ready.')))
        .once('close', () => fail(new Error('SSH connection closed before the MySQL tunnel was ready.')))
        .connect(sshConfig);
    });
  }

  async buildSshConfig(connection, credentials) {
    const ssh = connection.ssh || {};
    const config = {
      host: ssh.host,
      port: ssh.port || 22,
      username: ssh.user,
      readyTimeout: 10000,
      keepaliveInterval: 20000
    };

    if (ssh.authMethod === 'privateKey') {
      config.privateKey = await fs.promises.readFile(expandHomePath(ssh.privateKeyPath), 'utf8');
      if (credentials.sshPassphrase) {
        config.passphrase = credentials.sshPassphrase;
      }
    } else {
      config.password = credentials.sshPassword;
    }

    return config;
  }

  async testConnection(connection, credentialOverride) {
    const client = await this.connect(connection, credentialOverride, { database: undefined });
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

  async completionMetadata(connection, schema) {
    const client = await this.connect(connection, undefined, { database: undefined });
    try {
      const [rows] = await client.execute(`
        select
          t.table_name as tableName,
          case when t.table_type = 'VIEW' then 'view' else 'table' end as objectType,
          c.column_name as columnName,
          c.column_type as columnType,
          c.is_nullable as nullable,
          c.column_key as columnKey,
          c.extra,
          c.ordinal_position as ordinal
        from information_schema.tables t
        left join information_schema.columns c
          on c.table_schema = t.table_schema
          and c.table_name = t.table_name
        where t.table_schema = ?
          and t.table_type in ('BASE TABLE', 'VIEW')
        order by t.table_name, c.ordinal_position
      `, [schema]);
      return buildCompletionMetadata(schema, rows);
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
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.panel = undefined;
    this.result = undefined;
  }

  show(title, result) {
    this.result = result;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'dbCruiser.results',
        'DB Cruiser Results',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );
      this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message));
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.result = undefined;
      });
    }

    this.panel.title = title;
    this.panel.iconPath = connectionPanelIconPath(this.extensionUri, result.connection);
    this.panel.webview.html = renderResultHtml(result);
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  async handleMessage(message) {
    if (!message || message.command !== 'exportResultSet') {
      return;
    }

    await exportQueryResultSet(this.result, message.resultSetIndex, message.format);
  }
}

class SqlConsoleView {
  /**
   * @param {MySqlAdapter} mysql
   * @param {ConsoleSessionStore} consoleSessions
   * @param {SqlCompletionMetadataCache} completionMetadataCache
   */
  constructor(mysql, consoleSessions, completionMetadataCache, extensionUri) {
    this.mysql = mysql;
    this.consoleSessions = consoleSessions;
    this.completionMetadataCache = completionMetadataCache;
    this.extensionUri = extensionUri;
    this.panels = new Map();
    this.panelResults = new WeakMap();
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
      existing.panel.iconPath = connectionPanelIconPath(this.extensionUri, connection);
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
    panel.iconPath = connectionPanelIconPath(this.extensionUri, connection);
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
      sql: this.consoleSessions.getSavedSql(connection.id) || ''
    });

    panel.webview.onDidReceiveMessage(async (message) => {
      if (!message || !['run', 'schemaChanged', 'rowLimitChanged', 'sqlChanged', 'completion', 'exportResultSet'].includes(message.command)) {
        return;
      }

      if (message.command === 'exportResultSet') {
        await exportQueryResultSet(this.panelResults.get(panel), message.resultSetIndex, message.format);
        return;
      }

      const nextSchema = String(message.schema || '').trim();
      const rowLimit = normalizeRowLimit(message.rowLimit);
      const sql = String(message.sql || '');

      if (message.command === 'completion') {
        await this.complete(panel, connection, nextSchema, sql, message.offset, message.requestId);
        return;
      }

      await this.consoleSessions.setSavedSchema(connection.id, nextSchema);
      await this.consoleSessions.setSavedRowLimit(connection.id, rowLimit);
      await this.consoleSessions.setSavedSql(connection.id, sql);
      panel.title = `${connection.name} Console`;

      if (message.command === 'sqlChanged') {
        return;
      }

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

      if (!hasRunnableSql(sql)) {
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

  async complete(panel, connection, schema, sql, offset, requestId) {
    const selectedSchema = schema || connection.database;
    const fallback = {
      type: 'completion',
      requestId,
      replaceStart: clampOffset(offset, sql),
      replaceEnd: clampOffset(offset, sql),
      items: []
    };

    if (!selectedSchema) {
      await panel.webview.postMessage(fallback);
      return;
    }

    try {
      const metadata = await this.completionMetadataCache.get(connection, selectedSchema);
      await panel.webview.postMessage({
        type: 'completion',
        requestId,
        ...buildSqlCompletionSuggestions(sql, offset, metadata)
      });
    } catch {
      await panel.webview.postMessage(fallback);
    }
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
      const result = {
        kind: 'query',
        connection,
        schema: schema || connection.database,
        sql,
        elapsedMs,
        resultSets
      };
      this.panelResults.set(panel, result);
      await panel.webview.postMessage({
        type: 'results',
        state: 'success',
        message: `Completed in ${elapsedMs} ms.`,
        html: renderQueryResults(result)
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

class SqlCompletionMetadataCache {
  /**
   * @param {MySqlAdapter} mysql
   */
  constructor(mysql) {
    this.mysql = mysql;
    this.entries = new Map();
  }

  async get(connection, schema) {
    if (!schema) {
      return emptyCompletionMetadata(schema);
    }

    const key = `${connection.id}:${schema}`;
    const existing = this.entries.get(key);
    if (existing && Date.now() - existing.createdAt < METADATA_CACHE_TTL_MS) {
      return existing.promise;
    }

    const promise = this.mysql.completionMetadata(connection, schema).catch((error) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, {
      createdAt: Date.now(),
      promise
    });
    return promise;
  }
}

class SqlCompletionProvider {
  /**
   * @param {ConnectionStore} store
   * @param {ConsoleSessionStore} consoleSessions
   * @param {SqlCompletionMetadataCache} metadataCache
   */
  constructor(store, consoleSessions, metadataCache) {
    this.store = store;
    this.consoleSessions = consoleSessions;
    this.metadataCache = metadataCache;
  }

  async provideCompletionItems(document, position, token) {
    const consoleContext = getConsoleContextForDocument(document, this.store, this.consoleSessions);
    if (!consoleContext?.connection) {
      return undefined;
    }

    const schema = consoleContext.schema || consoleContext.connection.database;
    if (!schema) {
      return undefined;
    }

    try {
      const metadata = await this.metadataCache.get(consoleContext.connection, schema);
      if (token.isCancellationRequested) {
        return undefined;
      }

      const sql = document.getText();
      const offset = document.offsetAt(position);
      return buildSqlCompletionList(document, position, sql, offset, metadata);
    } catch {
      return undefined;
    }
  }
}

async function addMySqlConnection(store, mysql, provider) {
  await openConnectionForm(store, mysql, provider);
}

async function editConnection(node, store, mysql, provider) {
  const connection = node?.connection || await pickConnection(store);
  if (!connection) {
    return;
  }
  await openConnectionForm(store, mysql, provider, connection);
}

async function openConnectionForm(store, mysql, provider, existingConnection) {
  const isEditing = Boolean(existingConnection);
  const panel = vscode.window.createWebviewPanel(
    'dbCruiser.connectionForm',
    isEditing ? 'Edit DB Cruiser Connection' : 'DB Cruiser MySQL Connection',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );
  const disposables = [];

  panel.webview.html = renderConnectionFormHtml({ connection: existingConnection });
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.command === 'pickSshKey') {
      await pickSshKeyFile(panel, message.currentPath);
      return;
    }

    if (!message || !['test', 'save'].includes(message.command)) {
      return;
    }

    const form = buildConnectionFromForm(message.values, existingConnection);
    if (form.errors.length > 0) {
      await panel.webview.postMessage({
        type: 'status',
        state: 'error',
        message: form.errors.join(' ')
      });
      return;
    }

    if (message.command === 'test') {
      await testConnectionFromForm(panel, mysql, form.connection, form.credentials);
      return;
    }

    await saveConnectionFromForm(panel, store, mysql, provider, form.connection, form.credentials, isEditing);
  }, undefined, disposables);

  panel.onDidDispose(() => {
    disposables.forEach((disposable) => disposable.dispose());
  });
}

async function testConnectionFromForm(panel, mysql, connection, credentials) {
  await panel.webview.postMessage({
    type: 'status',
    state: 'busy',
    message: 'Testing connection...'
  });

  try {
    await mysql.testConnection(connection, credentials);
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

async function saveConnectionFromForm(panel, store, mysql, provider, connection, credentials, isEditing = false) {
  await panel.webview.postMessage({
    type: 'status',
    state: 'busy',
    message: isEditing ? 'Updating connection...' : 'Saving connection...'
  });

  try {
    await mysql.testConnection(connection, credentials);
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

  await store.add(connection, credentials);
  provider.refresh();
  await panel.webview.postMessage({
    type: 'status',
    state: 'success',
    message: `${isEditing ? 'Updated' : 'Saved'} ${connection.name}.`
  });
  vscode.window.showInformationMessage(`${isEditing ? 'Updated' : 'Saved'} ${connection.name}.`);
  panel.dispose();
}

async function pickSshKeyFile(panel, currentPath) {
  const defaultPath = String(currentPath || '').trim() || path.join(os.homedir(), '.ssh');
  const expandedPath = expandHomePath(defaultPath);
  const defaultUri = vscode.Uri.file(defaultSshKeyPickerPath(expandedPath));
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    defaultUri,
    openLabel: 'Use Key File',
    title: 'Choose SSH Private Key'
  });

  if (!picked?.[0]) {
    return;
  }

  await panel.webview.postMessage({
    type: 'sshKeyPicked',
    path: picked[0].fsPath
  });
}

function defaultSshKeyPickerPath(filePath) {
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return path.dirname(filePath);
    }
  } catch {
    return path.join(os.homedir(), '.ssh');
  }
  return filePath;
}

function buildConnectionFromForm(values = {}, existingConnection) {
  const host = String(values.host || '').trim();
  const portText = String(values.port || '').trim();
  const user = String(values.user || '').trim();
  const database = String(values.database || '').trim();
  const nameInput = String(values.name || '').trim();
  const mysqlPassword = String(values.password ?? '');
  const color = normalizeConnectionColorId(values.color);
  const sshEnabled = values.sshEnabled === true || values.sshEnabled === 'true';
  const sshHost = String(values.sshHost || '').trim();
  const sshPortText = String(values.sshPort || '').trim();
  const sshUser = String(values.sshUser || '').trim();
  const sshAuthMethod = values.sshAuthMethod === 'privateKey' ? 'privateKey' : 'password';
  const sshPassword = String(values.sshPassword ?? '');
  const sshPrivateKeyPath = String(values.sshPrivateKeyPath || '').trim();
  const sshPassphrase = String(values.sshPassphrase ?? '');
  const port = Number(portText);
  const sshPort = Number(sshPortText);
  const errors = [];
  const isEditing = Boolean(existingConnection);

  if (!host) {
    errors.push('MySQL host is required.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('MySQL port must be between 1 and 65535.');
  }
  if (!user) {
    errors.push('MySQL user is required.');
  }

  if (sshEnabled) {
    if (!sshHost) {
      errors.push('SSH host is required.');
    }
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      errors.push('SSH port must be between 1 and 65535.');
    }
    if (!sshUser) {
      errors.push('SSH user is required.');
    }
    if (sshAuthMethod === 'password' && !sshPassword && !isEditing) {
      errors.push('SSH password is required for password authentication.');
    }
    if (sshAuthMethod === 'privateKey' && !sshPrivateKeyPath) {
      errors.push('Private key path is required for private key authentication.');
    }
  }

  const name = nameInput || suggestedConnectionName({ host, user, database });
  if (!name) {
    errors.push('Connection name is required.');
  }

  const connection = {
    id: existingConnection?.id || crypto.randomUUID(),
    type: 'mysql',
    name,
    host,
    port,
    user,
    database: database || undefined
  };
  if (color !== 'default') {
    connection.color = color;
  }

  if (sshEnabled) {
    connection.ssh = {
      enabled: true,
      host: sshHost,
      port: sshPort,
      user: sshUser,
      authMethod: sshAuthMethod,
      privateKeyPath: sshAuthMethod === 'privateKey' ? sshPrivateKeyPath : undefined
    };
  }

  const sshPasswordCredential = !sshEnabled && isEditing
    ? ''
    : sshEnabled && sshAuthMethod === 'password' && (!isEditing || sshPassword.length > 0)
      ? sshPassword
      : sshEnabled && sshAuthMethod === 'privateKey' && isEditing
        ? ''
        : undefined;
  const sshPassphraseCredential = !sshEnabled && isEditing
    ? ''
    : sshEnabled && sshAuthMethod === 'privateKey' && (!isEditing || sshPassphrase.length > 0)
      ? sshPassphrase
      : sshEnabled && sshAuthMethod === 'password' && isEditing
        ? ''
        : undefined;

  return {
    errors,
    credentials: {
      mysqlPassword: isEditing && mysqlPassword.length === 0 ? undefined : mysqlPassword,
      sshPassword: sshPasswordCredential,
      sshPassphrase: sshPassphraseCredential
    },
    connection
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
  if (!hasRunnableSql(sql)) {
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
        const maxRows = consoleContext?.connection
          ? consoleSessions.getSavedRowLimit(connection.id)
          : getMaxRows();
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

function hasRunnableSql(sql) {
  return String(sql || '')
    .replace(/--[^\r\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim().length > 0;
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

async function exportQueryResultSet(result, resultSetIndex, format) {
  const normalizedFormat = String(format || '').toLowerCase();
  const exporter = EXPORT_FORMATS[normalizedFormat];
  const setIndex = Number(resultSetIndex);
  const resultSet = result?.kind === 'query' && Number.isInteger(setIndex)
    ? result.resultSets?.[setIndex]
    : undefined;

  if (!exporter || !resultSet) {
    vscode.window.showWarningMessage('No query result data is available to export.');
    return;
  }

  if (!Array.isArray(resultSet.rows) || resultSet.rows.length === 0) {
    vscode.window.showInformationMessage('This result set has no rows to export.');
    return;
  }

  const content = exporter.serialize(resultSet.rows);
  const uri = await vscode.window.showSaveDialog({
    defaultUri: defaultExportUri(result, setIndex, exporter.extension),
    filters: {
      [exporter.label]: [exporter.extension]
    },
    saveLabel: `Export ${exporter.label}`
  });

  if (!uri) {
    return;
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  vscode.window.showInformationMessage(`Exported ${resultSet.rows.length} row${resultSet.rows.length === 1 ? '' : 's'} to ${uri.fsPath}.`);
}

const EXPORT_FORMATS = {
  csv: {
    label: 'CSV',
    extension: 'csv',
    serialize: serializeRowsAsCsv
  },
  json: {
    label: 'JSON',
    extension: 'json',
    serialize: serializeRowsAsJson
  },
  markdown: {
    label: 'Markdown',
    extension: 'md',
    serialize: serializeRowsAsMarkdown
  }
};

function defaultExportUri(result, resultSetIndex, extension) {
  const fileName = `${sanitizeFileName([
    result?.connection?.name || 'query',
    result?.schema,
    `result-${resultSetIndex + 1}`
  ].filter(Boolean).join('-'))}.${extension}`;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder
    ? vscode.Uri.joinPath(folder, fileName)
    : vscode.Uri.file(path.join(os.homedir(), fileName));
}

function sanitizeFileName(value) {
  return String(value || 'query-results')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'query-results';
}

function serializeRowsAsCsv(rows) {
  const columns = collectRowColumns(rows);
  const lines = [
    columns.map(csvCell).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(formatDelimitedExportValue(row[column]))).join(','))
  ];
  return `${lines.join('\r\n')}\r\n`;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

function serializeRowsAsJson(rows) {
  return `${JSON.stringify(rows.map(normalizeExportRow), null, 2)}\n`;
}

function serializeRowsAsMarkdown(rows) {
  const columns = collectRowColumns(rows);
  const header = `| ${columns.map(markdownCell).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => markdownCell(formatMarkdownExportValue(row[column]))).join(' | ')} |`);
  return `${[header, divider, ...body].join('\n')}\n`;
}

function collectRowColumns(rows) {
  return Array.from(rows.reduce((keys, row) => {
    Object.keys(row || {}).forEach((key) => keys.add(key));
    return keys;
  }, new Set()));
}

function normalizeExportRow(row) {
  return collectRowColumns([row]).reduce((normalized, column) => {
    normalized[column] = normalizeExportValue(row[column]);
    return normalized;
  }, {});
}

function normalizeExportValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeExportValue);
  }
  if (typeof value === 'object') {
    return Object.entries(value).reduce((normalized, [key, nestedValue]) => {
      normalized[key] = normalizeExportValue(nestedValue);
      return normalized;
    }, {});
  }
  return value;
}

function formatDelimitedExportValue(value) {
  const normalized = normalizeExportValue(value);
  if (normalized === null) {
    return '';
  }
  if (typeof normalized === 'object') {
    return JSON.stringify(normalized);
  }
  return String(normalized);
}

function formatMarkdownExportValue(value) {
  const normalized = normalizeExportValue(value);
  if (normalized === null) {
    return 'NULL';
  }
  if (typeof normalized === 'object') {
    return JSON.stringify(normalized);
  }
  return String(normalized);
}

function markdownCell(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function buildCompletionMetadata(schema, rows) {
  const metadata = emptyCompletionMetadata(schema);
  for (const row of rows) {
    if (!row.tableName) {
      continue;
    }

    const key = row.tableName.toLowerCase();
    let object = metadata.byLowerName.get(key);
    if (!object) {
      object = {
        name: row.tableName,
        type: row.objectType || 'table',
        columns: []
      };
      metadata.objects.push(object);
      metadata.byLowerName.set(key, object);
    }

    if (row.columnName) {
      object.columns.push({
        name: row.columnName,
        type: row.columnType,
        nullable: row.nullable,
        columnKey: row.columnKey,
        extra: row.extra,
        ordinal: row.ordinal
      });
    }
  }
  return metadata;
}

function emptyCompletionMetadata(schema) {
  return {
    schema,
    objects: [],
    byLowerName: new Map()
  };
}

function buildSqlCompletionList(document, position, sql, offset, metadata) {
  const statement = currentSqlStatement(sql, offset);
  const before = sql.slice(statement.start, offset);
  const range = completionWordRange(document, position);
  const references = extractTableReferences(statement.text, metadata);
  const memberContext = getMemberCompletionContext(before);

  if (memberContext) {
    const object = objectForQualifier(memberContext.qualifier, references, metadata);
    if (object) {
      return completionList(columnCompletionItems(object, range));
    }
  }

  if (isTableCompletionContext(before)) {
    return completionList(tableCompletionItems(metadata, range));
  }

  return completionList([
    ...aliasCompletionItems(references, range),
    ...referenceColumnCompletionItems(references, range)
  ]);
}

function buildSqlCompletionSuggestions(sql, offset, metadata) {
  const safeOffset = clampOffset(offset, sql);
  const statement = currentSqlStatement(sql, safeOffset);
  const before = sql.slice(statement.start, safeOffset);
  const replacement = completionTextRange(sql, safeOffset);
  const references = extractTableReferences(statement.text, metadata);
  const memberContext = getMemberCompletionContext(before);
  let items = [];

  if (memberContext) {
    const object = objectForQualifier(memberContext.qualifier, references, metadata);
    if (object) {
      items = columnCompletionSuggestions(object);
    }
  } else if (isTableCompletionContext(before)) {
    items = tableCompletionSuggestions(metadata);
  } else {
    items = [
      ...aliasCompletionSuggestions(references),
      ...referenceColumnCompletionSuggestions(references)
    ];
  }

  return {
    replaceStart: replacement.start,
    replaceEnd: replacement.end,
    items: filterCompletionSuggestions(items, replacement.prefix).slice(0, 80)
  };
}

function completionList(items) {
  return items.length ? new vscode.CompletionList(items, false) : undefined;
}

function currentSqlStatement(sql, offset) {
  const start = sql.lastIndexOf(';', Math.max(0, offset - 1)) + 1;
  const nextSemicolon = sql.indexOf(';', offset);
  const end = nextSemicolon === -1 ? sql.length : nextSemicolon;
  return {
    start,
    end,
    text: sql.slice(start, end)
  };
}

function completionWordRange(document, position) {
  return document.getWordRangeAtPosition(position, /`?[\w$]*`?/) || new vscode.Range(position, position);
}

function completionTextRange(sql, offset) {
  const text = String(sql || '');
  const safeOffset = clampOffset(offset, text);
  let start = safeOffset;
  let end = safeOffset;

  while (start > 0 && /[\w$`]/.test(text[start - 1])) {
    start -= 1;
  }
  while (end < text.length && /[\w$`]/.test(text[end])) {
    end += 1;
  }

  return {
    start,
    end,
    prefix: text.slice(start, safeOffset)
  };
}

function tableCompletionItems(metadata, range) {
  return metadata.objects.map((object) => {
    const item = new vscode.CompletionItem(object.name, object.type === 'view'
      ? vscode.CompletionItemKind.Interface
      : vscode.CompletionItemKind.Struct);
    item.detail = `${metadata.schema}.${object.name} ${object.type}`;
    item.insertText = formatSqlIdentifier(object.name);
    item.range = range;
    item.sortText = `1:${object.name}`;
    return item;
  });
}

function tableCompletionSuggestions(metadata) {
  return metadata.objects.map((object) => ({
    label: object.name,
    kind: object.type === 'view' ? 'view' : 'table',
    detail: `${metadata.schema}.${object.name} ${object.type}`,
    insertText: formatSqlIdentifier(object.name),
    filterText: object.name,
    sortText: `1:${object.name}`
  }));
}

function aliasCompletionItems(references, range) {
  const seen = new Set();
  const items = [];
  for (const reference of references) {
    if (!reference.alias || reference.alias === reference.tableName || seen.has(reference.alias.toLowerCase())) {
      continue;
    }
    seen.add(reference.alias.toLowerCase());
    const item = new vscode.CompletionItem(reference.alias, vscode.CompletionItemKind.Variable);
    item.detail = `Alias for ${reference.tableName}`;
    item.insertText = formatSqlIdentifier(reference.alias);
    item.range = range;
    item.sortText = `0:${reference.alias}`;
    items.push(item);
  }
  return items;
}

function aliasCompletionSuggestions(references) {
  const seen = new Set();
  const items = [];
  for (const reference of references) {
    if (!reference.alias || reference.alias === reference.tableName || seen.has(reference.alias.toLowerCase())) {
      continue;
    }
    seen.add(reference.alias.toLowerCase());
    items.push({
      label: reference.alias,
      kind: 'alias',
      detail: `Alias for ${reference.tableName}`,
      insertText: formatSqlIdentifier(reference.alias),
      filterText: reference.alias,
      sortText: `0:${reference.alias}`
    });
  }
  return items;
}

function referenceColumnCompletionItems(references, range) {
  const items = [];
  const seen = new Set();
  for (const reference of references) {
    if (!reference.object) {
      continue;
    }

    const qualifier = reference.alias || reference.tableName;
    for (const column of reference.object.columns) {
      const key = `${qualifier.toLowerCase()}.${column.name.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push(columnCompletionItem(reference.object, column, range, qualifier));
    }
  }

  if (references.length === 1 && references[0].object) {
    for (const column of references[0].object.columns) {
      const key = column.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push(columnCompletionItem(references[0].object, column, range));
    }
  }

  return items;
}

function referenceColumnCompletionSuggestions(references) {
  const items = [];
  const seen = new Set();
  for (const reference of references) {
    if (!reference.object) {
      continue;
    }

    const qualifier = reference.alias || reference.tableName;
    for (const column of reference.object.columns) {
      const key = `${qualifier.toLowerCase()}.${column.name.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push(columnCompletionSuggestion(reference.object, column, qualifier));
    }
  }

  if (references.length === 1 && references[0].object) {
    for (const column of references[0].object.columns) {
      const key = column.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push(columnCompletionSuggestion(references[0].object, column));
    }
  }

  return items;
}

function columnCompletionItems(object, range) {
  return object.columns.map((column) => columnCompletionItem(object, column, range));
}

function columnCompletionSuggestions(object) {
  return object.columns.map((column) => columnCompletionSuggestion(object, column));
}

function columnCompletionItem(object, column, range, qualifier) {
  const label = qualifier ? `${qualifier}.${column.name}` : column.name;
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Field);
  item.detail = [object.name, column.type].filter(Boolean).join(' ');
  item.documentation = formatColumnDescription(column) || undefined;
  item.insertText = qualifier
    ? `${formatSqlIdentifier(qualifier)}.${formatSqlIdentifier(column.name)}`
    : formatSqlIdentifier(column.name);
  item.range = range;
  item.sortText = qualifier ? `2:${label}` : `1:${label}`;
  return item;
}

function columnCompletionSuggestion(object, column, qualifier) {
  const label = qualifier ? `${qualifier}.${column.name}` : column.name;
  return {
    label,
    kind: 'column',
    detail: [object.name, column.type].filter(Boolean).join(' '),
    documentation: formatColumnDescription(column) || '',
    insertText: qualifier
      ? `${formatSqlIdentifier(qualifier)}.${formatSqlIdentifier(column.name)}`
      : formatSqlIdentifier(column.name),
    filterText: column.name,
    sortText: qualifier ? `2:${label}` : `1:${label}`
  };
}

function filterCompletionSuggestions(items, prefix) {
  const normalizedPrefix = normalizeCompletionFilterText(prefix);
  const filtered = normalizedPrefix
    ? items.filter((item) => normalizeCompletionFilterText(item.filterText || item.label).startsWith(normalizedPrefix))
    : items;
  return filtered.sort((left, right) => {
    const sort = String(left.sortText || left.label).localeCompare(String(right.sortText || right.label));
    return sort || String(left.label).localeCompare(String(right.label));
  });
}

function normalizeCompletionFilterText(value) {
  return unquoteIdentifier(String(value || '').replace(/^`/, '').replace(/`$/, '')).toLowerCase();
}

function clampOffset(offset, text) {
  const value = Number(offset);
  const length = String(text || '').length;
  if (!Number.isFinite(value)) {
    return length;
  }
  return Math.max(0, Math.min(length, Math.trunc(value)));
}

function extractTableReferences(sql, metadata) {
  const masked = maskSqlLiteralsAndComments(sql);
  const references = [];
  const seen = new Set();
  const identifier = sqlIdentifierPatternSource();
  const qualified = qualifiedSqlIdentifierPatternSource();
  const directPattern = new RegExp(`\\b(?:from|join|update|into)\\s+(${qualified})(?:\\s+(?:as\\s+)?(${identifier}))?`, 'gi');
  let match;

  while ((match = directPattern.exec(masked))) {
    addTableReference(references, seen, metadata, match[1], match[2]);
  }

  const fromPattern = /\bfrom\b([\s\S]*?)(?=\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|\bunion\b|;|$)/gi;
  while ((match = fromPattern.exec(masked))) {
    const segments = match[1].split(',');
    for (const segment of segments) {
      const beforeJoin = segment.split(/\b(?:inner|left|right|full|cross)?\s*join\b/i)[0];
      const beforeOn = beforeJoin.split(/\bon\b/i)[0].trim();
      const segmentMatch = beforeOn.match(new RegExp(`^(${qualified})(?:\\s+(?:as\\s+)?(${identifier}))?`, 'i'));
      if (segmentMatch) {
        addTableReference(references, seen, metadata, segmentMatch[1], segmentMatch[2]);
      }
    }
  }

  return references;
}

function addTableReference(references, seen, metadata, qualifiedName, aliasName) {
  const parts = splitQualifiedIdentifier(qualifiedName);
  const tableName = parts[parts.length - 1];
  if (!tableName || isSqlReservedIdentifier(tableName)) {
    return;
  }

  const alias = normalizeSqlAlias(aliasName);
  const object = objectForTableName(tableName, metadata);
  const key = `${tableName.toLowerCase()}:${(alias || tableName).toLowerCase()}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  references.push({
    tableName,
    alias: alias || tableName,
    object
  });
}

function normalizeSqlAlias(aliasName) {
  if (!aliasName) {
    return '';
  }
  const alias = unquoteIdentifier(aliasName);
  return alias && !isSqlReservedIdentifier(alias) ? alias : '';
}

function objectForQualifier(qualifier, references, metadata) {
  const normalized = unquoteIdentifier(qualifier).toLowerCase();
  const reference = references.find((candidate) => (
    candidate.alias?.toLowerCase() === normalized ||
    candidate.tableName.toLowerCase() === normalized
  ));
  return reference?.object || objectForTableName(qualifier, metadata);
}

function objectForTableName(tableName, metadata) {
  return metadata.byLowerName.get(unquoteIdentifier(tableName).toLowerCase());
}

function getMemberCompletionContext(sqlBefore) {
  const masked = maskSqlLiteralsAndComments(sqlBefore);
  const match = masked.match(/(`(?:``|[^`])*`|[A-Za-z_][\w$]*)\s*\.\s*(?:`[^`]*|[A-Za-z_][\w$]*)?$/);
  return match ? { qualifier: unquoteIdentifier(match[1]) } : undefined;
}

function isTableCompletionContext(sqlBefore) {
  const masked = maskSqlLiteralsAndComments(sqlBefore);
  const tail = masked.slice(-500);
  if (/\b(?:from|join|update|into)\s+[\w$`.]*$/i.test(tail)) {
    return true;
  }

  const lastComma = tail.lastIndexOf(',');
  if (lastComma === -1 || !/,\s*[\w$`]*$/i.test(tail)) {
    return false;
  }

  const lastFrom = lastKeywordIndex(tail, ['from']);
  const lastBlockingClause = lastKeywordIndex(tail, ['where', 'group', 'order', 'having', 'limit', 'on']);
  return lastComma > lastFrom && lastComma > lastBlockingClause;
}

function lastKeywordIndex(text, keywords) {
  return keywords.reduce((last, keyword) => {
    const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'gi');
    let match;
    let next = last;
    while ((match = pattern.exec(text))) {
      next = Math.max(next, match.index);
    }
    return next;
  }, -1);
}

function sqlIdentifierPatternSource() {
  return '`(?:``|[^`])*`|[A-Za-z_][\\w$]*';
}

function qualifiedSqlIdentifierPatternSource() {
  const identifier = sqlIdentifierPatternSource();
  return `(?:${identifier})(?:\\s*\\.\\s*(?:${identifier}))?`;
}

function splitQualifiedIdentifier(value) {
  const parts = [];
  let current = '';
  let inBacktick = false;
  const text = String(value || '').trim();

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '`') {
      current += char;
      if (inBacktick && text[index + 1] === '`') {
        current += text[index + 1];
        index += 1;
        continue;
      }
      inBacktick = !inBacktick;
      continue;
    }
    if (char === '.' && !inBacktick) {
      parts.push(unquoteIdentifier(current));
      current = '';
      continue;
    }
    current += char;
  }

  if (current) {
    parts.push(unquoteIdentifier(current));
  }
  return parts.filter(Boolean);
}

function unquoteIdentifier(value) {
  const text = String(value || '').trim();
  if (text.startsWith('`')) {
    const end = text.endsWith('`') ? text.length - 1 : text.length;
    return text.slice(1, end).replace(/``/g, '`');
  }
  return text;
}

function formatSqlIdentifier(value) {
  const text = String(value || '');
  return /^[A-Za-z_][\w$]*$/.test(text) && !isSqlReservedIdentifier(text)
    ? text
    : quoteIdentifier(text);
}

function isSqlReservedIdentifier(value) {
  return SQL_RESERVED_WORDS.has(String(value || '').toLowerCase());
}

function maskSqlLiteralsAndComments(sql) {
  return String(sql || '')
    .replace(/--[^\r\n]*/g, blankSqlMatch)
    .replace(/\/\*[\s\S]*?\*\//g, blankSqlMatch)
    .replace(/'(?:''|\\.|[^'\\])*'/g, blankSqlMatch)
    .replace(/"(?:\\"|""|[^"])*"/g, blankSqlMatch);
}

function blankSqlMatch(value) {
  return value.replace(/[^\r\n]/g, ' ');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const accentColor = escapeHtml(connectionAccentColor(connection));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --border: var(--vscode-panel-border, var(--vscode-editorWidget-border, transparent));
      --muted: var(--vscode-descriptionForeground, var(--vscode-editor-foreground));
      --bg-soft: var(--vscode-editorWidget-background, var(--vscode-sideBar-background, var(--vscode-editor-background)));
      --input-bg: var(--vscode-input-background, var(--vscode-editor-background));
      --input-fg: var(--vscode-input-foreground, var(--vscode-editor-foreground));
      --input-border: var(--vscode-input-border, var(--vscode-panel-border, transparent));
      --button-bg: var(--vscode-button-background, var(--vscode-button-secondaryBackground));
      --button-fg: var(--vscode-button-foreground, var(--vscode-button-secondaryForeground));
      --button-hover: var(--vscode-button-hoverBackground, var(--vscode-button-secondaryHoverBackground));
      --error: var(--vscode-errorForeground, #f14c4c);
      --success: var(--vscode-testing-iconPassed, #73c991);
      --suggest-bg: var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
      --suggest-fg: var(--vscode-editorSuggestWidget-foreground, var(--vscode-editor-foreground));
      --suggest-border: var(--vscode-editorSuggestWidget-border, var(--vscode-panel-border, transparent));
      --suggest-selected: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground));
      --sql-keyword: #569cd6;
      --sql-function: #dcdcaa;
      --sql-string: #ce9178;
      --sql-number: #b5cea8;
      --sql-comment: #6a9955;
      --sql-identifier: #9cdcfe;
      --sql-operator: #d4d4d4;
      --connection-color: ${accentColor};
    }
    body.vscode-light {
      --sql-keyword: #0000ff;
      --sql-function: #795e26;
      --sql-string: #a31515;
      --sql-number: #098658;
      --sql-comment: #008000;
      --sql-identifier: #267f99;
      --sql-operator: #000000;
    }
    body.vscode-dark {
      --sql-keyword: #569cd6;
      --sql-function: #dcdcaa;
      --sql-string: #ce9178;
      --sql-number: #b5cea8;
      --sql-comment: #6a9955;
      --sql-identifier: #9cdcfe;
      --sql-operator: #d4d4d4;
    }
    body.vscode-high-contrast {
      --sql-keyword: #75beff;
      --sql-function: #ffff66;
      --sql-string: #ffab70;
      --sql-number: #7ee787;
      --sql-comment: #a5a5a5;
      --sql-identifier: #9cdcfe;
      --sql-operator: var(--vscode-editor-foreground, #ffffff);
    }
    body.vscode-high-contrast-light {
      --sql-keyword: #0000ff;
      --sql-function: #795e26;
      --sql-string: #a31515;
      --sql-number: #098658;
      --sql-comment: #008000;
      --sql-identifier: #267f99;
      --sql-operator: var(--vscode-editor-foreground, #000000);
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
      border-top: 3px solid var(--connection-color);
      border-bottom: 1px solid var(--border);
      padding: 12px;
      background: var(--bg-soft);
    }
    .console-title {
      min-width: 180px;
      margin-right: auto;
    }
    .console-title h1 {
      display: flex;
      align-items: center;
      gap: 7px;
      margin: 0 0 3px;
      font-size: 14px;
      font-weight: 600;
    }
    .connection-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--connection-color);
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
    .editor-wrap {
      min-height: 0;
      position: relative;
      overflow: hidden;
      border-bottom: 1px solid var(--border);
      background: var(--input-bg);
    }
    .sql-highlight, textarea {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 12px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.45;
      tab-size: 2;
      white-space: pre-wrap;
      overflow-wrap: break-word;
    }
    .sql-highlight {
      position: absolute;
      inset: 0;
      overflow: auto;
      border: 0;
      color: var(--input-fg);
      background: transparent;
      pointer-events: none;
      user-select: none;
      scrollbar-width: none;
    }
    .sql-highlight::-webkit-scrollbar {
      display: none;
    }
    textarea {
      position: relative;
      z-index: 1;
      resize: none;
      border: 0;
      border-radius: 0;
      color: transparent;
      background: transparent;
      caret-color: var(--input-fg);
      -webkit-text-fill-color: transparent;
    }
    @media (forced-colors: active) {
      .sql-highlight, .sql-token, textarea {
        forced-color-adjust: none;
      }
    }
    textarea::selection {
      background: var(--vscode-editor-selectionBackground);
    }
    .sql-token.keyword {
      color: var(--sql-keyword);
      font-weight: 600;
    }
    .sql-token.function {
      color: var(--sql-function);
    }
    .sql-token.string {
      color: var(--sql-string);
    }
    .sql-token.number {
      color: var(--sql-number);
    }
    .sql-token.comment {
      color: var(--sql-comment);
      font-style: italic;
    }
    .sql-token.identifier {
      color: var(--sql-identifier);
    }
    .sql-token.operator {
      color: var(--sql-operator);
    }
    .completion-list {
      position: fixed;
      z-index: 20;
      box-sizing: border-box;
      min-width: 260px;
      max-width: min(560px, calc(100vw - 24px));
      max-height: 260px;
      overflow: auto;
      border: 1px solid var(--suggest-border);
      color: var(--suggest-fg);
      background: var(--suggest-bg);
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.22);
    }
    .completion-list[hidden] {
      display: none;
    }
    .completion-item {
      display: grid;
      grid-template-columns: 58px minmax(0, 1fr);
      gap: 8px;
      width: 100%;
      padding: 5px 8px;
      box-sizing: border-box;
      cursor: default;
    }
    .completion-item.active {
      background: var(--suggest-selected);
    }
    .completion-kind {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
    }
    .completion-main {
      min-width: 0;
    }
    .completion-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .completion-detail {
      margin-top: 2px;
      color: var(--muted);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
      border-left: 4px solid var(--connection-color);
      border-bottom: 1px solid var(--border);
      padding-left: 12px;
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
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border-bottom: 1px solid var(--border);
      padding: 8px 10px;
      font-weight: 600;
    }
    .export-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }
    .export-button {
      min-height: 22px;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 7px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font: inherit;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
    }
    .export-button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
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
        <h1><span class="connection-dot" aria-hidden="true"></span>${escapeHtml(connection.name)}</h1>
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
    <div class="editor-wrap">
      <pre id="sql-highlight" class="sql-highlight" aria-hidden="true"></pre>
      <textarea id="sql" spellcheck="false">${escapeHtml(sql)}</textarea>
      <div id="completion-list" class="completion-list" role="listbox" hidden></div>
    </div>
    <div id="status" class="${initialStatusClass}" role="status" aria-live="polite">${initialStatus}</div>
    <section id="results" class="results"></section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const schema = document.getElementById('schema');
    const rowLimit = document.getElementById('row-limit');
    const sql = document.getElementById('sql');
    const sqlHighlight = document.getElementById('sql-highlight');
    const run = document.getElementById('run');
    const clear = document.getElementById('clear');
    const status = document.getElementById('status');
    const results = document.getElementById('results');
    const completionList = document.getElementById('completion-list');
    let saveTimer;
    let completionTimer;
    let completionRequestId = 0;
    let completionState = {
      items: [],
      selectedIndex: 0,
      replaceStart: 0,
      replaceEnd: 0
    };

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

    function snapshot() {
      return {
        schema: schema.value,
        rowLimit: rowLimit.value,
        sql: sql.value
      };
    }

    const SQL_INDENT = '  ';
    const SQL_HIGHLIGHT_KEYWORDS = new Set('add all alter and as asc between by case create cross delete desc distinct drop else end exists from full group having in inner insert into is join left like limit not null on or order outer right select set then union update values when where with table view primary key foreign references index unique constraint database schema if begin commit rollback transaction'.split(' '));
    const SQL_HIGHLIGHT_FUNCTIONS = new Set('avg coalesce concat count curdate date_format ifnull lower max min now nullif round sum upper'.split(' '));

    function handleSqlChanged(options = {}) {
      updateHighlight();
      window.clearTimeout(saveTimer);
      vscode.setState(snapshot());
      saveTimer = window.setTimeout(() => post('sqlChanged'), 250);
      hideCompletion();
      if (options.complete !== false) {
        requestCompletionSoon();
      }
    }

    function updateHighlight() {
      sqlHighlight.innerHTML = highlightSql(sql.value);
      syncHighlightScroll();
    }

    function syncHighlightScroll() {
      sqlHighlight.scrollTop = sql.scrollTop;
      sqlHighlight.scrollLeft = sql.scrollLeft;
    }

    function highlightSql(source) {
      const text = String(source || '');
      let html = '';
      let index = 0;

      while (index < text.length) {
        const char = text[index];
        const next = text[index + 1];

        if (char === '-' && next === '-') {
          const end = readLineComment(text, index);
          html += highlightToken(text.slice(index, end), 'comment');
          index = end;
          continue;
        }

        if (char === '#') {
          const end = readLineComment(text, index);
          html += highlightToken(text.slice(index, end), 'comment');
          index = end;
          continue;
        }

        if (char === '/' && next === '*') {
          const end = readBlockComment(text, index);
          html += highlightToken(text.slice(index, end), 'comment');
          index = end;
          continue;
        }

        if (char === "'" || char === '"') {
          const end = readQuoted(text, index, char);
          html += highlightToken(text.slice(index, end), 'string');
          index = end;
          continue;
        }

        if (char === '\`') {
          const end = readQuoted(text, index, char);
          html += highlightToken(text.slice(index, end), 'identifier');
          index = end;
          continue;
        }

        if (isDigit(char)) {
          const end = readNumber(text, index);
          html += highlightToken(text.slice(index, end), 'number');
          index = end;
          continue;
        }

        if (isWordStart(char)) {
          const end = readWord(text, index);
          const word = text.slice(index, end);
          const lower = word.toLowerCase();
          const tokenClass = SQL_HIGHLIGHT_KEYWORDS.has(lower)
            ? 'keyword'
            : SQL_HIGHLIGHT_FUNCTIONS.has(lower) && nextNonSpace(text, end) === '('
              ? 'function'
              : '';
          html += tokenClass ? highlightToken(word, tokenClass) : escapeHighlightHtml(word);
          index = end;
          continue;
        }

        if ('()[],.;=*<>!+-/%'.includes(char)) {
          html += highlightToken(char, 'operator');
          index += 1;
          continue;
        }

        html += escapeHighlightHtml(char);
        index += 1;
      }

      if (!html) {
        return ' ';
      }
      return text.endsWith('\\n') ? html + ' ' : html;
    }

    function highlightToken(value, tokenClass) {
      return '<span class="sql-token ' + tokenClass + '">' + escapeHighlightHtml(value) + '</span>';
    }

    function escapeHighlightHtml(value) {
      const text = String(value || '');
      let escaped = '';
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === '&') {
          escaped += '&amp;';
        } else if (char === '<') {
          escaped += '&lt;';
        } else if (char === '>') {
          escaped += '&gt;';
        } else if (char === '"') {
          escaped += '&quot;';
        } else {
          escaped += char;
        }
      }
      return escaped;
    }

    function readLineComment(text, start) {
      let cursor = start;
      while (cursor < text.length && text[cursor] !== '\\n') {
        cursor += 1;
      }
      return cursor;
    }

    function readBlockComment(text, start) {
      let cursor = start + 2;
      while (cursor < text.length) {
        if (text[cursor] === '*' && text[cursor + 1] === '/') {
          return cursor + 2;
        }
        cursor += 1;
      }
      return text.length;
    }

    function readQuoted(text, start, quote) {
      let cursor = start + 1;
      while (cursor < text.length) {
        const char = text[cursor];
        if (char === '\\\\') {
          cursor += 2;
          continue;
        }
        if (char === quote) {
          if (text[cursor + 1] === quote) {
            cursor += 2;
            continue;
          }
          return cursor + 1;
        }
        cursor += 1;
      }
      return text.length;
    }

    function readNumber(text, start) {
      let cursor = start;
      while (cursor < text.length && (isDigit(text[cursor]) || text[cursor] === '.')) {
        cursor += 1;
      }
      return cursor;
    }

    function readWord(text, start) {
      let cursor = start;
      while (cursor < text.length && isWordPart(text[cursor])) {
        cursor += 1;
      }
      return cursor;
    }

    function nextNonSpace(text, start) {
      let cursor = start;
      while (cursor < text.length && isInlineSpace(text[cursor])) {
        cursor += 1;
      }
      return text[cursor] || '';
    }

    function isInlineSpace(char) {
      return char === ' ' || char === '\\t';
    }

    function isDigit(char) {
      const code = char ? char.charCodeAt(0) : 0;
      return code >= 48 && code <= 57;
    }

    function isWordStart(char) {
      const code = char ? char.charCodeAt(0) : 0;
      return char === '_' || char === '$' || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    }

    function isWordPart(char) {
      return isWordStart(char) || isDigit(char);
    }

    function insertSmartNewline() {
      const start = sql.selectionStart;
      const end = sql.selectionEnd;
      const indent = nextSqlIndent(sql.value, start);
      sql.setRangeText('\\n' + indent, start, end, 'end');
      handleSqlChanged({ complete: false });
    }

    function nextSqlIndent(value, offset) {
      const lineStart = value.lastIndexOf('\\n', Math.max(0, offset - 1)) + 1;
      const line = value.slice(lineStart, offset);
      let indent = leadingIndent(line);
      const normalized = normalizeSqlLineForIndent(line);
      if (shouldIndentNextSqlLine(normalized)) {
        indent += SQL_INDENT;
      }
      return indent;
    }

    function leadingIndent(line) {
      let cursor = 0;
      while (cursor < line.length && (line[cursor] === ' ' || line[cursor] === '\\t')) {
        cursor += 1;
      }
      return line.slice(0, cursor).split('\\t').join(SQL_INDENT);
    }

    function normalizeSqlLineForIndent(line) {
      let output = '';
      let index = 0;
      while (index < line.length) {
        const char = line[index];
        const next = line[index + 1];
        if ((char === '-' && next === '-') || char === '#') {
          break;
        }
        if (char === '/' && next === '*') {
          index = readBlockComment(line, index);
          continue;
        }
        if (char === "'" || char === '"' || char === '\`') {
          output += ' ';
          index = readQuoted(line, index, char);
          continue;
        }
        output += char;
        index += 1;
      }
      return output.trim();
    }

    function shouldIndentNextSqlLine(line) {
      const lower = line.toLowerCase();
      if (!lower) {
        return false;
      }
      if (lower.endsWith('(') || lower.endsWith(',')) {
        return true;
      }

      const firstWord = firstSqlWord(lower);
      if (firstWord === 'select' && !hasSqlWord(lower, 'from')) {
        return true;
      }
      if (['where', 'having', 'on', 'set', 'values'].includes(firstWord)) {
        return true;
      }
      return ['case', 'then', 'else', 'begin'].includes(lastSqlWord(lower));
    }

    function firstSqlWord(line) {
      let cursor = 0;
      while (cursor < line.length && !isWordStart(line[cursor])) {
        cursor += 1;
      }
      const start = cursor;
      while (cursor < line.length && isWordPart(line[cursor])) {
        cursor += 1;
      }
      return line.slice(start, cursor);
    }

    function lastSqlWord(line) {
      let cursor = line.length - 1;
      while (cursor >= 0 && !isWordPart(line[cursor])) {
        cursor -= 1;
      }
      const end = cursor + 1;
      while (cursor >= 0 && isWordPart(line[cursor])) {
        cursor -= 1;
      }
      return line.slice(cursor + 1, end);
    }

    function hasSqlWord(line, word) {
      let cursor = 0;
      while (cursor < line.length) {
        if (!isWordStart(line[cursor])) {
          cursor += 1;
          continue;
        }
        const start = cursor;
        while (cursor < line.length && isWordPart(line[cursor])) {
          cursor += 1;
        }
        if (line.slice(start, cursor) === word) {
          return true;
        }
      }
      return false;
    }

    function indentSelection(outdent) {
      const value = sql.value;
      const start = sql.selectionStart;
      const end = sql.selectionEnd;
      const selected = value.slice(start, end);

      if (!selected.includes('\\n')) {
        if (outdent) {
          outdentCurrentLine();
          return;
        }
        sql.setRangeText(SQL_INDENT, start, end, 'end');
        handleSqlChanged({ complete: false });
        return;
      }

      const lineStart = value.lastIndexOf('\\n', Math.max(0, start - 1)) + 1;
      const selectedEnd = end > start && value[end - 1] === '\\n' ? end - 1 : end;
      const nextLineBreak = value.indexOf('\\n', selectedEnd);
      const blockEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
      const original = value.slice(lineStart, blockEnd);
      const changed = original
        .split('\\n')
        .map((line) => outdent ? removeOneIndent(line) : SQL_INDENT + line)
        .join('\\n');

      sql.setRangeText(changed, lineStart, blockEnd, 'select');
      handleSqlChanged({ complete: false });
    }

    function outdentCurrentLine() {
      const value = sql.value;
      const start = sql.selectionStart;
      const end = sql.selectionEnd;
      const lineStart = value.lastIndexOf('\\n', Math.max(0, start - 1)) + 1;
      const nextLineBreak = value.indexOf('\\n', start);
      const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
      const line = value.slice(lineStart, lineEnd);
      const nextLine = removeOneIndent(line);
      const removed = line.length - nextLine.length;
      if (!removed) {
        return;
      }

      sql.setRangeText(nextLine, lineStart, lineEnd, 'preserve');
      sql.selectionStart = Math.max(lineStart, start - removed);
      sql.selectionEnd = Math.max(sql.selectionStart, end - removed);
      handleSqlChanged({ complete: false });
    }

    function removeOneIndent(line) {
      if (line.startsWith(SQL_INDENT)) {
        return line.slice(SQL_INDENT.length);
      }
      if (line.startsWith('\\t') || line.startsWith(' ')) {
        return line.slice(1);
      }
      return line;
    }

    function post(command) {
      const state = snapshot();
      vscode.setState(state);
      vscode.postMessage({
        command,
        ...state
      });
    }

    function requestCompletion() {
      window.clearTimeout(completionTimer);
      sendCompletionRequest(++completionRequestId);
    }

    function requestCompletionSoon() {
      const requestId = ++completionRequestId;
      window.clearTimeout(completionTimer);
      completionTimer = window.setTimeout(() => sendCompletionRequest(requestId), 120);
    }

    function sendCompletionRequest(requestId) {
      const state = snapshot();
      vscode.setState(state);
      vscode.postMessage({
        command: 'completion',
        ...state,
        offset: sql.selectionStart,
        requestId
      });
    }

    function hideCompletion() {
      window.clearTimeout(completionTimer);
      completionList.hidden = true;
      completionList.innerHTML = '';
      completionState = {
        ...completionState,
        items: []
      };
    }

    function showCompletion(message) {
      if (message.requestId !== completionRequestId) {
        return;
      }

      const items = Array.isArray(message.items) ? message.items : [];
      if (!items.length) {
        hideCompletion();
        return;
      }

      completionState = {
        items,
        selectedIndex: 0,
        replaceStart: Number.isInteger(message.replaceStart) ? message.replaceStart : sql.selectionStart,
        replaceEnd: Number.isInteger(message.replaceEnd) ? message.replaceEnd : sql.selectionEnd
      };
      completionList.innerHTML = '';
      items.forEach((item, index) => completionList.appendChild(renderCompletionItem(item, index)));
      completionList.hidden = false;
      setCompletionSelection(0);
      positionCompletionList();
    }

    function renderCompletionItem(item, index) {
      const row = document.createElement('div');
      row.className = 'completion-item';
      row.setAttribute('role', 'option');
      row.dataset.index = String(index);

      const kind = document.createElement('div');
      kind.className = 'completion-kind';
      kind.textContent = completionKindLabel(item.kind);

      const main = document.createElement('div');
      main.className = 'completion-main';

      const label = document.createElement('div');
      label.className = 'completion-label';
      label.textContent = item.label || item.insertText || '';

      const detail = document.createElement('div');
      detail.className = 'completion-detail';
      detail.textContent = item.detail || item.documentation || '';

      main.appendChild(label);
      if (detail.textContent) {
        main.appendChild(detail);
      }
      row.appendChild(kind);
      row.appendChild(main);
      row.addEventListener('mousemove', () => setCompletionSelection(index));
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        acceptCompletion(index);
      });
      return row;
    }

    function completionKindLabel(kind) {
      return {
        alias: 'alias',
        column: 'field',
        table: 'table',
        view: 'view'
      }[kind] || 'item';
    }

    function setCompletionSelection(index) {
      if (!completionState.items.length) {
        return;
      }
      const length = completionState.items.length;
      completionState.selectedIndex = ((index % length) + length) % length;
      [...completionList.querySelectorAll('.completion-item')].forEach((row, rowIndex) => {
        const active = rowIndex === completionState.selectedIndex;
        row.classList.toggle('active', active);
        row.setAttribute('aria-selected', active ? 'true' : 'false');
        if (active) {
          row.scrollIntoView({ block: 'nearest' });
        }
      });
    }

    function acceptCompletion(index = completionState.selectedIndex) {
      const item = completionState.items[index];
      if (!item) {
        return;
      }
      const insertText = item.insertText || item.label || '';
      sql.focus();
      sql.setRangeText(insertText, completionState.replaceStart, completionState.replaceEnd, 'end');
      handleSqlChanged({ complete: false });
    }

    function positionCompletionList() {
      if (completionList.hidden) {
        return;
      }
      const point = caretPoint(sql);
      const width = Math.min(560, Math.max(260, completionList.offsetWidth || 260));
      const height = Math.min(260, completionList.scrollHeight || 180);
      const left = Math.min(Math.max(8, point.left), Math.max(8, window.innerWidth - width - 8));
      const top = point.top + height + 8 > window.innerHeight
        ? Math.max(8, point.top - height - 24)
        : point.top;
      completionList.style.left = left + 'px';
      completionList.style.top = top + 'px';
    }

    function caretPoint(textarea) {
      const style = window.getComputedStyle(textarea);
      const mirror = document.createElement('div');
      const properties = [
        'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
        'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'textTransform',
        'wordSpacing', 'textIndent', 'lineHeight'
      ];
      properties.forEach((property) => {
        mirror.style[property] = style[property];
      });
      mirror.style.position = 'absolute';
      mirror.style.visibility = 'hidden';
      mirror.style.whiteSpace = 'pre-wrap';
      mirror.style.overflowWrap = 'break-word';
      mirror.style.top = '0';
      mirror.style.left = '-9999px';
      mirror.textContent = textarea.value.slice(0, textarea.selectionStart);

      const marker = document.createElement('span');
      marker.textContent = String.fromCharCode(8203);
      mirror.appendChild(marker);
      document.body.appendChild(mirror);

      const rect = textarea.getBoundingClientRect();
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.45 || 20;
      const point = {
        left: rect.left + marker.offsetLeft - textarea.scrollLeft,
        top: rect.top + marker.offsetTop - textarea.scrollTop + lineHeight
      };
      mirror.remove();
      return point;
    }

    function execute() {
      setBusy(true);
      setStatus('busy', 'Running...');
      post('run');
    }

    const restored = vscode.getState();
    if (restored) {
      if (typeof restored.sql === 'string') {
        sql.value = restored.sql;
      }
      if (typeof restored.schema === 'string') {
        schema.value = restored.schema;
      }
      if (restored.rowLimit !== undefined) {
        rowLimit.value = restored.rowLimit;
      }
    }
    updateHighlight();

    run.addEventListener('click', execute);
    clear.addEventListener('click', () => {
      sql.value = '';
      results.innerHTML = '';
      setStatus('', '');
      handleSqlChanged({ complete: false });
      sql.focus();
    });
    results.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-export-format]');
      if (!button || !results.contains(button)) {
        return;
      }

      vscode.postMessage({
        command: 'exportResultSet',
        format: button.dataset.exportFormat,
        resultSetIndex: Number(button.dataset.resultSet)
      });
    });
    schema.addEventListener('change', () => {
      hideCompletion();
      post('schemaChanged');
    });
    rowLimit.addEventListener('change', () => {
      post('rowLimitChanged');
    });
    sql.addEventListener('input', () => {
      handleSqlChanged();
    });
    sql.addEventListener('click', () => {
      if (!completionList.hidden) {
        requestCompletionSoon();
      }
    });
    sql.addEventListener('scroll', () => {
      syncHighlightScroll();
      positionCompletionList();
    });
    window.addEventListener('beforeunload', () => {
      post('sqlChanged');
    });
    sql.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        hideCompletion();
        execute();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && (event.code === 'Space' || event.key === ' ')) {
        event.preventDefault();
        requestCompletion();
        return;
      }
      if (!completionList.hidden) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setCompletionSelection(completionState.selectedIndex + 1);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setCompletionSelection(completionState.selectedIndex - 1);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          acceptCompletion();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          hideCompletion();
          return;
        }
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        insertSmartNewline();
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        indentSelection(event.shiftKey);
      }
    });
    document.addEventListener('click', (event) => {
      if (event.target !== sql && !completionList.contains(event.target)) {
        hideCompletion();
      }
    });
    window.addEventListener('resize', positionCompletionList);
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
      if (message.type === 'completion') {
        showCompletion(message);
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

function renderConnectionColorOptions(selectedColor) {
  const normalizedColor = normalizeConnectionColorId(selectedColor);
  return CONNECTION_COLORS.map((color) => {
    const checked = color.id === normalizedColor ? ' checked' : '';
    const dotClass = color.id === 'default' ? 'color-dot' : `color-dot color-${color.id}`;
    return `<label class="color-option">
      <input type="radio" name="color" value="${escapeHtml(color.id)}"${checked}>
      <span class="color-chip"><span class="${dotClass}" aria-hidden="true"></span>${escapeHtml(color.label)}</span>
    </label>`;
  }).join('');
}

function renderConnectionFormHtml({ connection } = {}) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const isEditing = Boolean(connection);
  const ssh = connection?.ssh || {};
  const sshAuthMethod = ssh.authMethod === 'privateKey' ? 'privateKey' : 'password';
  const selectedColor = normalizeConnectionColorId(connection?.color);
  const title = isEditing ? 'Edit MySQL Connection' : 'MySQL Connection';
  const saveLabel = isEditing ? 'Update Connection' : 'Save Connection';
  const testLabel = isEditing ? 'Test Changes' : 'Test Connection';

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
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    fieldset {
      display: grid;
      gap: 12px;
      margin: 0;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    legend {
      padding: 0 4px;
      color: var(--vscode-editor-foreground);
      font-weight: 600;
    }
    label {
      display: grid;
      gap: 6px;
      min-width: 0;
      color: var(--vscode-editor-foreground);
      font-weight: 600;
    }
    .check {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .check input {
      width: auto;
    }
    #sshFields {
      display: grid;
      gap: 12px;
    }
    .path-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }
    .color-swatches {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .color-option {
      display: inline-flex;
      font-weight: 500;
    }
    .color-option input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    .color-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 3px 8px;
      background: var(--input-bg);
      cursor: pointer;
    }
    .color-option input:focus + .color-chip,
    .color-option input:checked + .color-chip {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .color-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--vscode-icon-foreground);
    }
    .color-blue {
      background: #3794ff;
    }
    .color-green {
      background: #89d185;
    }
    .color-yellow {
      background: #cca700;
    }
    .color-orange {
      background: #d18616;
    }
    .color-red {
      background: #f14c4c;
    }
    .color-purple {
      background: #b180d7;
    }
    input,
    select {
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
    input:focus,
    select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    [hidden] {
      display: none !important;
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
      .path-row {
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
    <h1>${escapeHtml(title)}</h1>
    <form>
      <div class="grid">
        <label>
          MySQL Host
          <input id="host" name="host" value="${escapeHtml(connection?.host || '127.0.0.1')}" required autocomplete="off">
        </label>
        <label>
          MySQL Port
          <input id="port" name="port" value="${escapeHtml(connection?.port || 3306)}" inputmode="numeric" pattern="[0-9]+" required autocomplete="off">
        </label>
      </div>
      <div class="grid">
        <label>
          MySQL User
          <input id="user" name="user" value="${escapeHtml(connection?.user || 'root')}" required autocomplete="username">
        </label>
        <label>
          MySQL Password
          <input id="password" name="password" type="password" autocomplete="current-password" placeholder="${isEditing ? 'Leave blank to keep saved password' : ''}">
        </label>
      </div>
      <fieldset>
        <legend>Connection Color</legend>
        <div class="color-swatches" role="radiogroup" aria-label="Connection color">
          ${renderConnectionColorOptions(selectedColor)}
        </div>
      </fieldset>
      <fieldset>
        <legend>SSH Tunnel</legend>
        <label class="check">
          <input id="sshEnabled" name="sshEnabled" type="checkbox"${ssh.enabled ? ' checked' : ''}>
          Use SSH Tunnel
        </label>
        <div id="sshFields"${ssh.enabled ? '' : ' hidden'}>
          <div class="grid">
            <label>
              SSH Host
              <input id="sshHost" name="sshHost" value="${escapeHtml(ssh.host || '')}" autocomplete="off">
            </label>
            <label>
              SSH Port
              <input id="sshPort" name="sshPort" value="${escapeHtml(ssh.port || 22)}" inputmode="numeric" pattern="[0-9]+" autocomplete="off">
            </label>
          </div>
          <div class="grid">
            <label>
              SSH User
              <input id="sshUser" name="sshUser" value="${escapeHtml(ssh.user || '')}" autocomplete="username">
            </label>
            <label>
              SSH Auth
              <select id="sshAuthMethod" name="sshAuthMethod">
                <option value="password"${sshAuthMethod === 'password' ? ' selected' : ''}>Password</option>
                <option value="privateKey"${sshAuthMethod === 'privateKey' ? ' selected' : ''}>Private Key</option>
              </select>
            </label>
          </div>
          <label id="sshPasswordLabel">
            SSH Password
            <input id="sshPassword" name="sshPassword" type="password" autocomplete="current-password" placeholder="${isEditing ? 'Leave blank to keep saved password' : ''}">
          </label>
          <label id="sshPrivateKeyPathLabel" hidden>
            Private Key Path
            <div class="path-row">
              <input id="sshPrivateKeyPath" name="sshPrivateKeyPath" value="${escapeHtml(ssh.privateKeyPath || '')}" autocomplete="off">
              <button id="pickSshKey" class="secondary" type="button">Browse</button>
            </div>
          </label>
          <label id="sshPassphraseLabel" hidden>
            Key Passphrase
            <input id="sshPassphrase" name="sshPassphrase" type="password" autocomplete="current-password" placeholder="${isEditing ? 'Leave blank to keep saved passphrase' : ''}">
          </label>
        </div>
      </fieldset>
      <label>
        Default Database
        <input id="database" name="database" value="${escapeHtml(connection?.database || '')}" autocomplete="off">
      </label>
      <label>
        Connection Name
        <input id="name" name="name" value="${escapeHtml(connection?.name || 'root@127.0.0.1')}" required autocomplete="off">
      </label>
      <div class="actions">
        <button id="save" type="submit">${escapeHtml(saveLabel)}</button>
        <button id="test" class="secondary" type="button">${escapeHtml(testLabel)}</button>
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
    const sshEnabledInput = document.getElementById('sshEnabled');
    const sshFields = document.getElementById('sshFields');
    const sshHostInput = document.getElementById('sshHost');
    const sshPortInput = document.getElementById('sshPort');
    const sshUserInput = document.getElementById('sshUser');
    const sshAuthMethodInput = document.getElementById('sshAuthMethod');
    const sshPasswordInput = document.getElementById('sshPassword');
    const sshPrivateKeyPathInput = document.getElementById('sshPrivateKeyPath');
    const sshPassphraseInput = document.getElementById('sshPassphrase');
    const sshPasswordLabel = document.getElementById('sshPasswordLabel');
    const sshPrivateKeyPathLabel = document.getElementById('sshPrivateKeyPathLabel');
    const sshPassphraseLabel = document.getElementById('sshPassphraseLabel');
    const pickSshKeyButton = document.getElementById('pickSshKey');
    if (${isEditing ? 'true' : 'false'}) {
      nameInput.dataset.touched = 'true';
    }

    function value(id) {
      return document.getElementById(id).value;
    }

    function collect() {
      return {
        host: value('host'),
        port: value('port'),
        user: value('user'),
        password: value('password'),
        color: document.querySelector('input[name="color"]:checked')?.value || 'default',
        sshEnabled: sshEnabledInput.checked,
        sshHost: value('sshHost'),
        sshPort: value('sshPort'),
        sshUser: value('sshUser'),
        sshAuthMethod: value('sshAuthMethod'),
        sshPassword: value('sshPassword'),
        sshPrivateKeyPath: value('sshPrivateKeyPath'),
        sshPassphrase: value('sshPassphrase'),
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

    function setRequired(input, isRequired) {
      input.required = isRequired;
      input.disabled = !isRequired && input.id !== 'sshPassphrase';
    }

    function syncSshFields() {
      const enabled = sshEnabledInput.checked;
      const usesPrivateKey = sshAuthMethodInput.value === 'privateKey';
      sshFields.hidden = !enabled;
      sshPasswordLabel.hidden = !enabled || usesPrivateKey;
      sshPrivateKeyPathLabel.hidden = !enabled || !usesPrivateKey;
      sshPassphraseLabel.hidden = !enabled || !usesPrivateKey;
      setRequired(sshHostInput, enabled);
      setRequired(sshPortInput, enabled);
      setRequired(sshUserInput, enabled);
      setRequired(sshPasswordInput, enabled && !usesPrivateKey);
      setRequired(sshPrivateKeyPathInput, enabled && usesPrivateKey);
      sshPassphraseInput.disabled = !enabled || !usesPrivateKey;
      sshAuthMethodInput.disabled = !enabled;
      pickSshKeyButton.disabled = !enabled || !usesPrivateKey;
    }

    function post(command) {
      if (!form.reportValidity()) {
        return;
      }
      setBusy(true);
      setStatus('busy', command === 'test' ? 'Testing connection...' : '${isEditing ? 'Updating connection...' : 'Saving connection...'}');
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
    sshEnabledInput.addEventListener('change', syncSshFields);
    sshAuthMethodInput.addEventListener('change', syncSshFields);
    pickSshKeyButton.addEventListener('click', () => {
      vscode.postMessage({
        command: 'pickSshKey',
        currentPath: value('sshPrivateKeyPath')
      });
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      post('save');
    });
    testButton.addEventListener('click', () => post('test'));
    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type !== 'status') {
        if (message.type === 'sshKeyPicked' && message.path) {
          sshPrivateKeyPathInput.value = message.path;
        }
        return;
      }
      setBusy(false);
      setStatus(message.state, message.message);
    });
    syncSshFields();
  </script>
</body>
</html>`;
}

function renderResultHtml(result) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const body = result.kind === 'object' ? renderObjectDetails(result) : renderQueryResults(result);
  const accentColor = escapeHtml(connectionAccentColor(result.connection));

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
      --accent: var(--vscode-focusBorder);
      --connection-color: ${accentColor};
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
      border-top: 3px solid var(--connection-color);
      padding: 16px;
    }
    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      border-left: 4px solid var(--connection-color);
      border-bottom: 1px solid var(--border);
      padding-left: 12px;
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
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border-bottom: 1px solid var(--border);
      padding: 8px 10px;
      font-weight: 600;
    }
    .export-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }
    .export-button {
      min-height: 22px;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 7px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font: inherit;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
    }
    .export-button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
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
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-export-format]');
      if (!button) {
        return;
      }

      vscode.postMessage({
        command: 'exportResultSet',
        format: button.dataset.exportFormat,
        resultSetIndex: Number(button.dataset.resultSet)
      });
    });
  </script>
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
      <div class="block-title">
        <span>${escapeHtml(title)} · ${set.rows.length} row${set.rows.length === 1 ? '' : 's'}</span>
        ${renderExportActions(index)}
      </div>
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

function renderExportActions(resultSetIndex) {
  return `<div class="export-actions" aria-label="Export result set">
    ${renderExportButton(resultSetIndex, 'csv', 'CSV')}
    ${renderExportButton(resultSetIndex, 'json', 'JSON')}
    ${renderExportButton(resultSetIndex, 'markdown', 'Markdown')}
  </div>`;
}

function renderExportButton(resultSetIndex, format, label) {
  return `<button class="export-button" type="button" data-export-format="${format}" data-result-set="${resultSetIndex}">${label}</button>`;
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
  const database = connection.database ? `/${connection.database}` : '';
  const ssh = connection.ssh?.enabled ? ` via SSH ${connection.ssh.user}@${connection.ssh.host}:${connection.ssh.port}` : '';
  return `${base}${database}${ssh}`;
}

function normalizeConnectionColorId(value) {
  const id = String(value || 'default');
  return CONNECTION_COLOR_IDS.has(id) ? id : 'default';
}

function connectionColorOption(connection) {
  const id = normalizeConnectionColorId(connection?.color);
  return CONNECTION_COLORS.find((color) => color.id === id) || CONNECTION_COLORS[0];
}

function connectionThemeIcon(icon, connection) {
  const color = connectionColorOption(connection);
  return color.themeColor
    ? new vscode.ThemeIcon(icon, new vscode.ThemeColor(color.themeColor))
    : new vscode.ThemeIcon(icon);
}

function connectionAccentColor(connection) {
  return connectionColorOption(connection).hex;
}

function connectionPanelIconPath(extensionUri, connection) {
  const color = connectionColorOption(connection);
  const iconName = color.id === 'default' ? 'icon.svg' : `connection-${color.id}.svg`;
  return vscode.Uri.joinPath(extensionUri, 'resources', iconName);
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

function sshPasswordSecretKey(id) {
  return `${SSH_PASSWORD_PREFIX}${id}`;
}

function sshPassphraseSecretKey(id) {
  return `${SSH_PASSPHRASE_PREFIX}${id}`;
}

function normalizeCredentialValue(value) {
  return value === undefined ? undefined : String(value);
}

function expandHomePath(filePath) {
  if (!filePath || filePath === '~') {
    return filePath;
  }
  if (filePath.startsWith(`~${path.sep}`) || filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
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
