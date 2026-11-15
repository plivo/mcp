# Plivo plugin for Grok Build

Connects Grok Build to the hosted Plivo MCP server, so it can send SMS, make calls, manage phone numbers and call
the Plivo API on your own Plivo account.

The plugin contains only an MCP server reference (`.mcp.json`). It ships no code, skills, commands or hooks.

## Sign-in

The first time Grok Build uses the server, it opens Plivo's sign-in page in your browser, where you sign in with your
Plivo account and approve the connection. No API key or token is stored in this plugin.

## Network endpoints and credentials

- **Endpoint:** `https://mcp.plivo.com/mcp`, the hosted Plivo MCP server. The plugin calls nothing else.
- **Credential:** the sign-in token Grok Build receives when you sign in with Plivo. Grok Build keeps it; you can
  revoke it from the Plivo console.

## Data

Requests go to Plivo's API through the MCP server, only for what you ask: reading your numbers, calls and messages,
or sending a message, placing a call or changing a number. Plivo keeps these records under its
[privacy policy](https://www.plivo.com/legal/privacy/).

## Approvals

Anything that costs money, cannot be undone, gives lasting access to the account or changes where calls and messages
go asks for your approval before it is sent.

## Support

[support.plivo.com](https://support.plivo.com/)
