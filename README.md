# Fourmolu Warning

Fourmolu Warning reports Haskell files that do not pass a Fourmolu formatting
check, without modifying them automatically.

## Features

- checks saved `.hs` files;
- publishes a VS Code warning and a preferred formatting quick fix;
- supports standalone files, simple workspaces and multi-root workspaces;
- provides configurable include and exclude globs;
- supports additional Fourmolu arguments and a custom executable path;
- distinguishes formatting differences from Fourmolu parser or execution errors.

## Requirements

Install `fourmolu` in the environment where the extension runs. For remote SSH,
WSL and devcontainer workspaces, this means the remote environment rather than
the local machine.

By default, the extension runs `fourmolu` from `PATH`. Set
`fourmoluWarning.executablePath` when the executable is elsewhere.

## Usage

Open a Haskell workspace and save a `.hs` file. An unformatted file receives a
warning at the start of the document and in the Problems panel. Use the lightbulb
quick fix or one of these commands:

- `Fourmolu: Check Current File`
- `Fourmolu: Format Current File`

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `fourmoluWarning.enabled` | `true` | Enables diagnostics. |
| `fourmoluWarning.checkOnSave` | `true` | Checks matching files after save. |
| `fourmoluWarning.executablePath` | `fourmolu` | Executable name or path. |
| `fourmoluWarning.include` | `["**/*.hs"]` | Workspace-relative files to check. |
| `fourmoluWarning.exclude` | build directories | Workspace-relative files to ignore. |
| `fourmoluWarning.extraArguments` | `[]` | Arguments placed before Fourmolu's mode and file arguments. |

Example workspace configuration:

```json
{
  "fourmoluWarning.include": [
    "services/**/*.hs",
    "libs/**/*.hs"
  ],
  "fourmoluWarning.extraArguments": [
    "-o", "-XImportQualifiedPost",
    "-o", "-XOverloadedRecordDot",
    "-o", "-XOverloadedLabels"
  ]
}
```

Relative executable paths and `${workspaceFolder}` are resolved separately for
each workspace folder:

```json
{
  "fourmoluWarning.executablePath": "tools/fourmolu"
}
```

## Development

The tests use Node.js built-ins and a fake Fourmolu process; they do not modify
Haskell files.

```bash
npm test
```

To launch an Extension Development Host from this directory:

```bash
code --new-window --extensionDevelopmentPath="$PWD" /path/to/haskell-workspace
```

## Packaging and publishing

Install the official VS Code extension CLI, then use the package scripts:

```bash
npm install --global @vscode/vsce
npm run package
npm run publish
```

The `publisher` field in `package.json` must match a publisher created in the
Visual Studio Marketplace before publishing.
