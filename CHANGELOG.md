# Change Log

All notable changes to the "vscode-xlens" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Preset picker: folder checkbox cycles through unchecked → track directory ([-]) → select all files recursively ([x]) → unchecked; partial selection clicks to select-all
- Preset picker: click any row to select/unselect; selected rows are highlighted
- Preset picker: files show VS Code-style extension-based colored icons (TypeScript, JavaScript, images, PDF, etc.)
- Preset directories are re-resolved on every refresh and now include untracked files, so renames/deletes/new files under tracked dirs are picked up automatically
- Preset JSON no longer persists `fileCount` (it is derived from `files.length` at load time)
- Preset names now support Chinese and other Unicode characters
- Preset picker toolbar adds Expand all / Collapse all buttons
- XLens Explorer view title bar adds Expand All button next to Collapse All