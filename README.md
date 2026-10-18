# Stashly: ask Alexa+ where it is

An MCP server (spec 2025-11-25, Streamable HTTP) that remembers where things are kept in a shared space, such as a wardrobe shared by two sisters.

**Tools:** `find_item`, `put_item`, `list_box`, `item_history`

## Run it
1. Install Node.js 20+
2. `npm install`
3. `npm run dev`  -> server at http://localhost:3000/mcp

## Try it
In a second terminal: `npx @modelcontextprotocol/inspector`, choose transport "Streamable HTTP" and URL `http://localhost:3000/mcp`, then call `put_item` and `find_item`.

## Optional password
Set `API_KEY=secret` before starting; callers must send `Authorization: Bearer secret`.

## Status
First version: data lives in `data.json`. Planned: DynamoDB storage, Bedrock fuzzy matching, AWS deploy, Alexa+ connection.

License: MIT
