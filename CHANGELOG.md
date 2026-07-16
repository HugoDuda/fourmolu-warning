# Changelog

## 0.3.1

Update README.md to reflect the new version of Fourmolu.

## 0.3.0

- report Fourmolu formatting differences on their affected source blocks.
- show the formatted Fourmolu output when hovering a formatting warning.
- report reordered import groups as one formatting block.
- report reformatted module documentation with its declaration as one block.
- check saved Haskell files when they are opened.
- use dedicated diagnostics for reordered imports and documentation comments.

## 0.2.0

- check all `.hs` files by default;
- add configurable include and exclude patterns;
- add configurable Fourmolu arguments and executable path;
- support multi-root workspaces.

## 0.1.0

- initial implementation.
