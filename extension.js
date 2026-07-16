"use strict";

const childProcess = require("child_process");
const path = require("path");
const vscode = require("vscode");

const SOURCE = "fourmolu-warning";
const CHECK_COMMAND = "fourmoluWarning.checkCurrentFile";
const FORMAT_COMMAND = "fourmoluWarning.formatCurrentFile";
const CHECK_DELAY_MS = 250;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

let diagnostics;
let output;
const generations = new Map();
const pendingChecks = new Map();
const reportedToolFailures = new Map();

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection(SOURCE);
  output = vscode.window.createOutputChannel("Fourmolu Warning");

  context.subscriptions.push(
    diagnostics,
    output,
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (setting(document, "checkOnSave", true)) {
        scheduleCheck(document);
      }
    }),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      invalidate(document.uri);
      diagnostics.delete(document.uri);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      cancelScheduledCheck(document.uri);
      generations.delete(document.uri.toString());
      diagnostics.delete(document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("fourmoluWarning")) {
        return;
      }

      diagnostics.clear();
      for (const document of vscode.workspace.textDocuments) {
        if (!document.isDirty) {
          scheduleCheck(document);
        }
      }
    }),
    vscode.commands.registerCommand(CHECK_COMMAND, checkCurrentFile),
    vscode.commands.registerCommand(FORMAT_COMMAND, formatCurrentFile),
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file", pattern: "**/*.hs" },
      new FourmoluQuickFixProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );
}

function deactivate() {
  for (const timeout of pendingChecks.values()) {
    clearTimeout(timeout);
  }
  pendingChecks.clear();
}

class FourmoluQuickFixProvider {
  provideCodeActions(document, _range, context) {
    const fourmoluDiagnostic = context.diagnostics.find(
      (diagnostic) =>
        diagnostic.source === SOURCE && diagnostic.code === "unformatted",
    );
    if (!fourmoluDiagnostic) {
      return [];
    }

    const action = new vscode.CodeAction(
      "Format this file with Fourmolu",
      vscode.CodeActionKind.QuickFix,
    );
    action.command = {
      command: FORMAT_COMMAND,
      title: "Format this file with Fourmolu",
      arguments: [document.uri],
    };
    action.diagnostics = [fourmoluDiagnostic];
    action.isPreferred = true;
    return [action];
  }
}

function setting(document, name, fallback) {
  return vscode.workspace
    .getConfiguration("fourmoluWarning", document.uri)
    .get(name, fallback);
}

function scheduleCheck(document) {
  cancelScheduledCheck(document.uri);
  const key = document.uri.toString();
  const timeout = setTimeout(() => {
    pendingChecks.delete(key);
    void checkDocument(document);
  }, CHECK_DELAY_MS);
  pendingChecks.set(key, timeout);
}

function cancelScheduledCheck(uri) {
  const key = uri.toString();
  const timeout = pendingChecks.get(key);
  if (timeout) {
    clearTimeout(timeout);
    pendingChecks.delete(key);
  }
}

function invalidate(uri) {
  const key = uri.toString();
  const generation = (generations.get(key) || 0) + 1;
  generations.set(key, generation);
  return generation;
}

function isCurrent(uri, generation) {
  return generations.get(uri.toString()) === generation;
}

async function checkCurrentFile(uri) {
  const document = await targetDocument(uri);
  if (!document) {
    return;
  }
  if (document.isDirty && !(await document.save())) {
    void vscode.window.showWarningMessage(
      "Fourmolu check cancelled because the file could not be saved.",
    );
    return;
  }

  cancelScheduledCheck(document.uri);
  await checkDocument(document);
}

async function formatCurrentFile(uri) {
  const document = await targetDocument(uri);
  if (!document) {
    return;
  }
  const context = workspaceContext(document);
  if (!context) {
    return;
  }
  if (document.isDirty && !(await document.save())) {
    void vscode.window.showWarningMessage(
      "Fourmolu formatting cancelled because the file could not be saved.",
    );
    return;
  }

  cancelScheduledCheck(document.uri);
  invalidate(document.uri);
  diagnostics.delete(document.uri);

  const executable = selectExecutable(document, context.root);
  const extraArguments = setting(document, "extraArguments", []);
  const result = await runFourmolu(
    executable,
    [...extraArguments, "-i", document.uri.fsPath],
    context.root,
  );

  if (!result.started || result.exitCode !== 0) {
    reportToolFailure(context.root, executable, result);
    return;
  }

  reportedToolFailures.delete(context.root);
  scheduleCheck(document);
}

async function targetDocument(uri) {
  if (uri instanceof vscode.Uri) {
    return vscode.workspace.openTextDocument(uri);
  }
  return vscode.window.activeTextEditor?.document;
}

async function checkDocument(document) {
  const context = workspaceContext(document);
  if (!context || document.isDirty) {
    diagnostics.delete(document.uri);
    return;
  }

  const generation = invalidate(document.uri);
  const executable = selectExecutable(document, context.root);
  const extraArguments = setting(document, "extraArguments", []);
  const check = await runFourmolu(
    executable,
    [...extraArguments, "-m", "check", "-q", document.uri.fsPath],
    context.root,
  );

  if (!isCurrent(document.uri, generation)) {
    return;
  }
  if (!check.started) {
    diagnostics.delete(document.uri);
    reportToolFailure(context.root, executable, check);
    return;
  }
  if (check.exitCode === 0) {
    diagnostics.delete(document.uri);
    reportedToolFailures.delete(context.root);
    return;
  }

  // A check-mode failure can mean either bad formatting or a parser/tool
  // error. Formatting to stdout lets us distinguish those without touching
  // the file; this second process only runs when the CI-equivalent check fails.
  const probe = await runFourmolu(
    executable,
    [...extraArguments, document.uri.fsPath],
    context.root,
  );
  if (!isCurrent(document.uri, generation)) {
    return;
  }
  if (!probe.started) {
    diagnostics.delete(document.uri);
    reportToolFailure(context.root, executable, probe);
    return;
  }

  if (probe.exitCode === 0) {
    setDiagnostic(
      document,
      "This file does not pass the configured Fourmolu formatting check.",
      "unformatted",
    );
    reportedToolFailures.delete(context.root);
    return;
  }

  const detail = summarizeOutput(probe.output || check.output);
  setDiagnostic(
    document,
    detail
      ? `Fourmolu could not check this file: ${detail}`
      : "Fourmolu could not check this file. See the Fourmolu Warning output.",
    "check-failed",
  );
  writeFailure(executable, context.root, probe);
}

function workspaceContext(document) {
  if (
    !setting(document, "enabled", true) ||
    document.uri.scheme !== "file" ||
    path.extname(document.uri.fsPath) !== ".hs"
  ) {
    return undefined;
  }

  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const root = folder ? folder.uri.fsPath : path.dirname(document.uri.fsPath);
  const globBase = folder || root;

  const includes = setting(document, "include", ["**/*.hs"]);
  const excludes = setting(document, "exclude", [
    "**/dist-newstyle/**",
    "**/.stack-work/**",
  ]);
  const matches = (pattern) =>
    vscode.languages.match(
      { scheme: "file", pattern: new vscode.RelativePattern(globBase, pattern) },
      document,
    ) > 0;

  if (!includes.some(matches) || excludes.some(matches)) {
    return undefined;
  }

  return { root };
}

function selectExecutable(document, root) {
  const configured =
    String(setting(document, "executablePath", "fourmolu")).trim() ||
    "fourmolu";
  const expanded = configured.replaceAll("${workspaceFolder}", root);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return expanded.includes("/") || expanded.includes("\\")
    ? path.resolve(root, expanded)
    : expanded;
}

function runFourmolu(executable, args, cwd) {
  return new Promise((resolve) => {
    childProcess.execFile(
      executable,
      args,
      { cwd, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        const outputText = `${stdout || ""}${stderr || ""}`.trim();
        if (!error) {
          resolve({ started: true, exitCode: 0, output: outputText });
          return;
        }

        if (typeof error.code === "number") {
          resolve({
            started: true,
            exitCode: error.code,
            output: outputText || error.message,
          });
          return;
        }

        resolve({
          started: false,
          exitCode: undefined,
          output: outputText || error.message,
        });
      },
    );
  });
}

function setDiagnostic(document, message, code) {
  const line = document.lineAt(0);
  const range = new vscode.Range(0, 0, 0, Math.min(line.text.length, 1));
  const diagnostic = new vscode.Diagnostic(
    range,
    message,
    vscode.DiagnosticSeverity.Warning,
  );
  diagnostic.source = SOURCE;
  diagnostic.code = code;
  diagnostics.set(document.uri, [diagnostic]);
}

function reportToolFailure(root, executable, result) {
  const detail = summarizeOutput(result.output) || "unknown execution error";
  const message = `Could not run ${executable}: ${detail}`;
  writeFailure(executable, root, result);

  if (reportedToolFailures.get(root) === message) {
    return;
  }
  reportedToolFailures.set(root, message);
  void vscode.window.showWarningMessage(
    "Fourmolu Warning could not run Fourmolu. Open its output for details.",
    "Show Output",
  ).then((choice) => {
    if (choice === "Show Output") {
      output.show(true);
    }
  });
}

function writeFailure(executable, root, result) {
  output.appendLine(`[${new Date().toISOString()}] Fourmolu failed`);
  output.appendLine(`cwd: ${root}`);
  output.appendLine(`executable: ${executable}`);
  output.appendLine(`exit code: ${result.exitCode ?? "not started"}`);
  if (result.output) {
    output.appendLine(result.output);
  }
  output.appendLine("");
}

function summarizeOutput(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

module.exports = { activate, deactivate };
