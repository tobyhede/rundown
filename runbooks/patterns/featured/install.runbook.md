---
name: Mintlify CLI Installation
description: Install Mintlify CLI and set up local documentation preview
tags:
  - featured
  - installation
scenarios:
  full-install:
    description: Complete installation with all optional sections
    commands:
      - rd run --prompted install.runbook.md
      - rd pass  # 1.1 Verify Node.js
      - rd pass  # 1.2 Verify Git
      - rd pass  # 2.1 Install globally
      - rd pass  # 2.2 Verify installation
      - rd pass  # 3.1 Create new project
      - rd pass  # 3.2 Navigate to project
      - rd pass  # 4 Start Local Preview Server
      - rd pass  # 5 Verify the Preview
      - rd yes   # 6 Continue to Optional Sections
      - rd pass  # 7.1 Update command
      - rd pass  # 7.2 Reinstall latest
      - rd pass  # 8.1 Check broken links
      - rd pass  # 8.2 Check accessibility
      - rd pass  # 8.3 Validate OpenAPI
    result: COMPLETE
  minimal-install:
    description: Core installation stopping after verification
    commands:
      - rd run --prompted install.runbook.md
      - rd pass  # 1.1 Verify Node.js
      - rd pass  # 1.2 Verify Git
      - rd pass  # 2.1 Install globally
      - rd pass  # 2.2 Verify installation
      - rd pass  # 3.1 Create new project
      - rd pass  # 3.2 Navigate to project
      - rd pass  # 4 Start Local Preview Server
      - rd pass  # 5 Verify the Preview
      - rd no    # 6 Continue to Optional Sections (skip)
    result: COMPLETE
  prerequisites-fail:
    description: Fail early if Node.js prerequisite not met
    commands:
      - rd run --prompted install.runbook.md
      - rd fail
    result: STOP
---

# Mintlify CLI Installation

Install the Mintlify CLI and set up a local documentation preview environment.

**OBJECTIVE:** Install the Mintlify CLI and set up a local documentation preview environment.

**DONE WHEN:** Local documentation server is running and accessible at http://localhost:3000.

**TODO:**
- [ ] Verify Node.js v20.17.0+ is installed
- [ ] Install the Mintlify CLI globally
- [ ] Create a new documentation project
- [ ] Start the local development server
- [ ] Verify the preview is accessible at localhost:3000

## 1 Prerequisites

### 1.1 Verify Node.js

- PASS: CONTINUE
- FAIL: STOP "Node.js v20.17.0 or higher is required"

Verify Node.js v20.17.0 or higher is installed.

```bash
node --version
```

### 1.2 Verify Git

- PASS: CONTINUE
- FAIL: STOP "Git is required"

Verify Git is installed.

```bash
git --version
```

## 2 Install the CLI

### 2.1 Install globally

- PASS: CONTINUE
- FAIL: RETRY 1 STOP "Failed to install Mintlify CLI"

Install the Mintlify CLI globally using npm.

Alternatively, use pnpm: `pnpm add -g mint`

```bash
npm i -g mint
```

### 2.2 Verify installation

- PASS: CONTINUE
- FAIL: STOP "Mintlify CLI installation verification failed"

Verify the installation succeeded.

```bash
mint --version
```

## 3 Create Documentation Project

### 3.1 Create new project

- PASS: CONTINUE
- FAIL: STOP "Failed to create documentation project"

Create a new documentation project. The CLI will prompt for a project name and theme.

You can also specify these directly: `mint new docs --name my-project --theme linden`

```bash
mint new docs
```

### 3.2 Navigate to project

- PASS: CONTINUE
- FAIL: STOP "Failed to navigate to project directory"

Navigate into the new project directory.

```bash
cd docs
```

## 4 Start Local Preview Server

- PASS: CONTINUE
- FAIL: RETRY 1 GOTO TroubleshootPreview

Start the development server to preview documentation locally. The server will be available at http://localhost:3000.

If port 3000 is already in use, you can specify a custom port: `mint dev --port 3333`

Alternatively, run without global installation: `npx mint dev`

```bash
mint dev
```

## 5 Verify the Preview

- PASS: CONTINUE
- FAIL: GOTO TroubleshootPreview

Open your browser and navigate to http://localhost:3000 to confirm the documentation site is running.

## 6 Continue to Optional Sections

- YES: CONTINUE
- NO: COMPLETE "Mintlify CLI installed and documentation preview running at http://localhost:3000"

Installation complete. Would you like to continue to optional CLI update and additional commands sections?

## 7 Update the CLI

### 7.1 Update command

- PASS: CONTINUE
- FAIL: CONTINUE

Update to the latest version using the built-in update command.

```bash
mint update
```

### 7.2 Reinstall latest

- PASS: CONTINUE
- FAIL: CONTINUE

Alternatively, reinstall with the latest version.

```bash
npm i -g mint@latest
```

## 8 Additional CLI Commands

### 8.1 Check broken links

- PASS: CONTINUE
- FAIL: CONTINUE

Check for broken links in your documentation.

```bash
mint broken-links
```

### 8.2 Check accessibility

- PASS: CONTINUE
- FAIL: CONTINUE

Check for accessibility issues.

```bash
mint a11y
```

### 8.3 Validate OpenAPI

- PASS: COMPLETE "Mintlify CLI installation and documentation complete"
- FAIL: COMPLETE "Mintlify CLI installation complete (OpenAPI validation requires a spec file)"

Validate an OpenAPI specification file.

```bash prompt
mint openapi-check <openapi-file-or-url>
```

## TroubleshootPreview

- PASS: CONTINUE
- FAIL: STOP "Unable to start documentation preview"

If port 3000 is already in use, try a custom port:

```bash prompt
mint dev --port 3333
```
