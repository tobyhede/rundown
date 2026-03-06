---
name: Rundown CLI Installation
description: Install Rundown CLI and create your first runbook
tags:
  - examples
  - installation
scenarios:
  full-install:
    description: Complete installation and verification
    commands:
      - rd run --prompted install.runbook.md
      - rd pass  # 1.1 Verify Node.js
      - rd pass  # 2.1 Install globally
      - rd pass  # 2.2 Verify installation
      - rd yes   # 3 Getting Started
      - rd pass  # 3.1 Create first runbook
      - rd pass  # 3.2 Run first runbook
    result: COMPLETE
  minimal-install:
    description: Installation only, skip getting started
    commands:
      - rd run --prompted install.runbook.md
      - rd pass  # 1.1 Verify Node.js
      - rd pass  # 2.1 Install globally
      - rd pass  # 2.2 Verify installation
      - rd pass  # 3.1 Create first runbook
      - rd pass  # 3.2 Run first runbook
    result: COMPLETE
  prerequisites-fail:
    description: Fail early if Node.js prerequisite not met
    commands:
      - rd run --prompted install.runbook.md
      - rd fail
    result: STOP
---

# Rundown CLI Installation

Install the Rundown CLI and create your first runbook.

**OBJECTIVE:** Install the Rundown CLI and verify it works.

**DONE WHEN:** `rd --version` returns a version number
and a test runbook executes successfully.

**TODO:**

- [ ] Verify Node.js v18.0.0+ is installed
- [ ] Install the Rundown CLI globally
- [ ] Create a simple runbook
- [ ] Execute the runbook

## 1 Prerequisites

### 1.1 Verify Node.js

- PASS: CONTINUE
- FAIL: STOP "Node.js v18.0.0 or higher is required"

Verify Node.js v18.0.0 or higher is installed.

```bash
node --version
```

## 2 Install the CLI

### 2.1 Install globally

- PASS: CONTINUE
- FAIL: RETRY 1 STOP "Failed to install Rundown CLI"

Install the Rundown CLI globally using npm.

```bash
npm i -g @rundown-org/cli
```

### 2.2 Verify installation

- PASS: CONTINUE
- FAIL: STOP "Rundown CLI installation verification failed"

Verify the installation succeeded.

```bash
rd --version
```

## 3 Getting Started

Would you like to create and run a simple "Hello World" runbook?

### 3.1 Create first runbook

- PASS: CONTINUE
- FAIL: STOP "Failed to create runbook"

Create a file named `hello.runbook.md`.

````bash
echo "---
name: Hello World
---

# Hello World

Print a message.

```bash
echo 'Hello from Rundown!'
```
"
 > hello.runbook.md
````

### 3.2 Run first runbook

- PASS: COMPLETE "Rundown CLI installed and verified with hello.runbook.md"
- FAIL: STOP "Failed to run example runbook"

Execute the runbook.

```bash
rd run hello.runbook.md
```
