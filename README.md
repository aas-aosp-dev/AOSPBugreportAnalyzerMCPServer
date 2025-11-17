# AOSPBugreportAnalyzer MCP Server

This repository contains a minimal [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that exposes GitHub tools over stdio for integration with the AOSPBugreportAnalyzer project.

## Requirements

- Node.js 18+
- A GitHub personal access token with read access to the repositories you want to inspect.

## Installation

```bash
npm install
```

## Configuration

Set the required environment variables before starting the server:

```
GITHUB_TOKEN=ghp_xxx # required
GITHUB_DEFAULT_OWNER=aas-aosp-dev # optional
GITHUB_DEFAULT_REPO=AOSPBugreportAnalyzer # optional
```

## Development

Run the server directly from TypeScript using `tsx`:

```bash
npm run dev
```

## Production build

```bash
npm run build
npm start
```

The server listens on stdio and is meant to be started as a subprocess. All JSON-RPC communication happens via stdout, while logs should be written to stderr.
