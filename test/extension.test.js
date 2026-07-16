"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const Module = require("node:module");
const path = require("node:path");
const { after, before, test } = require("node:test");

const workspaceRoot = path.resolve(__dirname, "fixture-workspace");
const callbacks = {};
const commands = new Map();
const diagnosticsByUri = new Map();
const executions = [];
const settings = new Map();
let workspaceFolders;
let processBehavior = () => ({ exitCode: 0, stdout: "", stderr: "" });
let quickFixProvider;

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.scheme = "file";
  }

  toString() {
    return `file://${this.fsPath}`;
  }
}

workspaceFolders = [makeWorkspaceFolder(workspaceRoot)];

class Diagnostic {
  constructor(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}

class RelativePattern {
  constructor(base, pattern) {
    this.baseUri = typeof base === "string" ? new Uri(base) : base.uri;
    this.pattern = pattern;
  }
}

const diagnosticCollection = {
  clear: () => diagnosticsByUri.clear(),
  delete: (uri) => diagnosticsByUri.delete(uri.toString()),
  dispose: () => {},
  set: (uri, values) => diagnosticsByUri.set(uri.toString(), values),
};

const vscode = {
  CodeAction,
  CodeActionKind: { QuickFix: "quickfix" },
  Diagnostic,
  DiagnosticSeverity: { Warning: 1 },
  RelativePattern,
  Range: class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
      Object.assign(this, { startLine, startCharacter, endLine, endCharacter });
    }
  },
  Uri,
  commands: {
    registerCommand(name, callback) {
      commands.set(name, callback);
      return { dispose() {} };
    },
  },
  languages: {
    createDiagnosticCollection: () => diagnosticCollection,
    match(selector, document) {
      const relativePath = path
        .relative(selector.pattern.baseUri.fsPath, document.uri.fsPath)
        .split(path.sep)
        .join("/");
      return matchesGlob(relativePath, selector.pattern.pattern) ? 10 : 0;
    },
    registerCodeActionsProvider(_selector, provider) {
      quickFixProvider = provider;
      return { dispose() {} };
    },
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({
      appendLine() {},
      dispose() {},
      show() {},
    }),
    showWarningMessage: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (name, fallback) =>
        settings.has(name) ? settings.get(name) : fallback,
    }),
    getWorkspaceFolder(uri) {
      return workspaceFolders.find((folder) => {
        const relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
        return relativePath === "" || !relativePath.startsWith("..");
      });
    },
    onDidChangeConfiguration(callback) {
      callbacks.changeConfiguration = callback;
      return { dispose() {} };
    },
    onDidChangeTextDocument(callback) {
      callbacks.change = callback;
      return { dispose() {} };
    },
    onDidCloseTextDocument(callback) {
      callbacks.close = callback;
      return { dispose() {} };
    },
    onDidSaveTextDocument(callback) {
      callbacks.save = callback;
      return { dispose() {} };
    },
    openTextDocument: async (uri) => makeDocument(uri.fsPath),
    textDocuments: [],
  },
};

const originalLoad = Module._load;
const originalExecFile = childProcess.execFile;

before(() => {
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") {
      return vscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  childProcess.execFile = (executable, args, options, callback) => {
    executions.push({ executable, args, options });
    const result = processBehavior(args);
    const error = result.exitCode === 0
      ? null
      : Object.assign(new Error("Fourmolu failed"), { code: result.exitCode });
    setImmediate(() => callback(error, result.stdout, result.stderr));
  };

  const extension = require("../extension");
  extension.activate({ subscriptions: [] });
});

after(() => {
  require("../extension").deactivate();
  Module._load = originalLoad;
  childProcess.execFile = originalExecFile;
});

test("reports any unformatted .hs file and offers a quick fix", async () => {
  reset();
  processBehavior = (args) => ({
    exitCode: args.includes("check") ? 1 : 0,
    stdout: "",
    stderr: "",
  });
  const document = makeDocument(
    path.join(workspaceRoot, "src", "Example", "Unformatted.hs"),
  );

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 2);
  assert.deepEqual(executions[0].args, [
    "-m",
    "check",
    "-q",
    document.uri.fsPath,
  ]);
  assert.equal(executions[0].executable, "fourmolu");
  assert.equal(executions[0].options.cwd, workspaceRoot);
  const [diagnostic] = diagnosticsByUri.get(document.uri.toString());
  assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Warning);
  assert.equal(diagnostic.code, "unformatted");

  const actions = quickFixProvider.provideCodeActions(document, undefined, {
    diagnostics: [diagnostic],
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].command.command, "fourmoluWarning.formatCurrentFile");
});

test("clears the diagnostic when the Fourmolu check passes", async () => {
  reset();
  processBehavior = () => ({ exitCode: 0, stdout: "", stderr: "" });
  const document = makeDocument(
    path.join(workspaceRoot, "test", "ExampleSpec.hs"),
  );
  diagnosticsByUri.set(document.uri.toString(), [{ code: "unformatted" }]);

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 1);
  assert.equal(diagnosticsByUri.has(document.uri.toString()), false);
});

test("ignores files matched by the default build-directory exclusions", async () => {
  reset();
  const document = makeDocument(
    path.join(workspaceRoot, ".stack-work", "generated", "Ignored.hs"),
  );

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 0);
  assert.equal(diagnosticsByUri.size, 0);
});

test("supports custom globs, arguments and a workspace-relative executable", async () => {
  reset();
  settings.set("include", ["services/**/*.hs"]);
  settings.set("exclude", ["**/Generated/**"]);
  settings.set("extraArguments", ["-o", "-XImportQualifiedPost"]);
  settings.set("executablePath", "tools/fourmolu");
  const document = makeDocument(
    path.join(workspaceRoot, "services", "api", "Handler.hs"),
  );

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 1);
  assert.equal(
    executions[0].executable,
    path.join(workspaceRoot, "tools", "fourmolu"),
  );
  assert.deepEqual(executions[0].args, [
    "-o",
    "-XImportQualifiedPost",
    "-m",
    "check",
    "-q",
    document.uri.fsPath,
  ]);
});

test("uses the workspace folder containing the file in a multi-root workspace", async () => {
  reset();
  const secondRoot = path.resolve(__dirname, "second-workspace");
  workspaceFolders = [
    makeWorkspaceFolder(workspaceRoot),
    makeWorkspaceFolder(secondRoot),
  ];
  const document = makeDocument(path.join(secondRoot, "src", "Second.hs"));

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 1);
  assert.equal(executions[0].options.cwd, secondRoot);
});

test("uses the saved file's directory outside a workspace", async () => {
  reset();
  workspaceFolders = [];
  const document = makeDocument("/tmp/fourmolu-warning-fixture/Standalone.hs");

  callbacks.save(document);
  await waitForCheck();

  assert.equal(executions.length, 1);
  assert.equal(
    executions[0].options.cwd,
    "/tmp/fourmolu-warning-fixture",
  );
});

function makeDocument(filePath) {
  return {
    isDirty: false,
    lineAt: () => ({ text: "module Example where" }),
    save: async () => true,
    uri: new Uri(filePath),
  };
}

function reset() {
  executions.length = 0;
  diagnosticsByUri.clear();
  settings.clear();
  workspaceFolders = [makeWorkspaceFolder(workspaceRoot)];
}

function waitForCheck() {
  return new Promise((resolve) => setTimeout(resolve, 325));
}

function makeWorkspaceFolder(root) {
  return { uri: new Uri(root) };
}

function matchesGlob(relativePath, glob) {
  const expression = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**/", "\u0000")
    .replaceAll("**", "\u0001")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", "(?:.*/)?")
    .replaceAll("\u0001", ".*");
  return new RegExp(`^${expression}$`).test(relativePath);
}
