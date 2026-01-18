# mintlify

> Documentation and setup instructions for mintlify

I want you to install Mintlify CLI for me. Execute all the steps below autonomously.

OBJECTIVE: Install the Mintlify CLI and set up a local documentation preview environment.

DONE WHEN: Local documentation server is running and accessible at http://localhost:3000.

## TODO

- [ ] Verify Node.js v20.17.0+ is installed
- [ ] Install the Mintlify CLI globally
- [ ] Create a new documentation project
- [ ] Start the local development server
- [ ] Verify the preview is accessible at localhost:3000

## Prerequisites

You need to have Node.js v20.17.0 or higher installed. Verify your Node.js version:

```bash
node --version
```

You must also have Git installed:

```bash
git --version
```

## Install the CLI

You need to install the Mintlify CLI globally using npm or pnpm.

Using npm:

```bash
npm i -g mint
```

Using pnpm:

```bash
pnpm add -g mint
```

Verify the installation:

```bash
mint --version
```

## Create a new documentation project

You must create a new documentation project using the CLI. This clones the starter kit into your specified directory:

```bash
mint new docs
```

The CLI will prompt you for a project name and theme. You can also specify these directly:

```bash
mint new docs --name my-project --theme linden
```

Navigate into your new project directory:

```bash
cd docs
```

## Start the local preview server

You need to start the development server to preview your documentation locally:

```bash
mint dev
```

Your documentation preview is now available at `http://localhost:3000`.

If port 3000 is already in use, you can specify a custom port:

```bash
mint dev --port 3333
```

Alternatively, run without global installation using npx:

```bash
npx mint dev
```

## Verify the preview

Open your browser and navigate to http://localhost:3000 to confirm the documentation site is running.

## Update the CLI

If you need to update to the latest version:

```bash
mint update
```

Or reinstall with the latest version:

```bash
npm i -g mint@latest
```

## Additional CLI commands

Check for broken links in your documentation:

```bash
mint broken-links
```

Check for accessibility issues:

```bash
mint a11y
```

Validate an OpenAPI specification:

```bash
mint openapi-check <openapi-file-or-url>
```

EXECUTE NOW: Complete the above TODO list to achieve: Local documentation server is running and accessible at http://localhost:3000.