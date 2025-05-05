# Plivo MCP Integration

A FastMCP (Model Context Protocol) plugin to interact with [Plivo's API](https://www.plivo.com/) for sending SMS, making calls, creating applications/endpoints, and retrieving call/message details.

This plugin is compatible with [Claude Desktop](https://modelcontextprotocol.io/quickstart/user) and allows Claude to interact with telephony workflows programmatically.

## 🚀 Features

- **Send SMS** via Plivo
- **Make Voice Calls** with custom answer/hangup/ring URLs
- **Create Voice Applications** for call routing
- **Create SIP Endpoints** for VoIP use
- **Get Call Detail Records (CDRs)**
- **Get Message Detail Records (MDRs)**

All capabilities are exposed as MCP tools using the `fastmcp` framework.

## ⚙️ Installation

Install Python dependencies:

```bash
pip install fastmcp plivo
```

## 📂 Usage with Claude Desktop

### 1. Clone or download this repo

```bash
git clone https://github.com/your-org/plivo-mcp.git
cd plivo-mcp
```

### 2. Configure Claude Desktop

Create or edit the Claude Desktop `config.json` file (refer to [Claude Setup Guide](https://modelcontextprotocol.io/quickstart/user)):

```json
{
  "mcpServers": {
    "plivo": {
      "command": "python3",
      "args": ["/absolute/path/to/plivo_mcp_server.py"],
      "env": {
        "PLIVO_AUTH_ID": "your_auth_id",
        "PLIVO_AUTH_TOKEN": "your_auth_token",
        "MY_NUMBER": "your_verified_number"
      }
    }
  }
}
```

Then launch Claude Desktop and connect to the Plivo MCP server from Claude's tool menu.

### 3. Run the MCP Server manually (for debugging)

```bash
python3 plivo_mcp_server.py
```

### 4. Claude Desktop Setup Steps (from official guide)

To get started with Claude Desktop:

1. Download the Claude Desktop app from the [official site](https://modelcontextprotocol.io/quickstart/user#downloads).
2. Install and launch the app.
3. Open your `config.json` file and add the MCP server block as shown above.
4. In Claude Desktop, open your `config.json` file and modify it as shown in step 3 above.
5. Enable the server, and Claude will auto-discover tools.
6. Start chatting and invoke tools like `plivo/send_sms` or `plivo/make_call` using natural language.

## 📝 MCP Tools Provided

| Tool Name            | Description                             |
|----------------------|-----------------------------------------|
| `send_sms`           | Send an SMS using Plivo                 |
| `make_call`          | Make an outbound voice call             |
| `create_application` | Create a voice app on Plivo             |
| `create_endpoint`    | Create a SIP endpoint for VoIP          |
| `get_cdr`            | Get details of a past call (CDR)        |
| `get_mdr`            | Get details of a past SMS message (MDR) |

## 🔧 Example Prompts for Claude

### Send SMS

```text
Use tool plivo/send_sms with to_number: "+14155551234" and text: "Your appointment is confirmed."
```

### Make a Call

```text
Use tool plivo/make_call with from_number: "+14156667777", to_number: "+14155551234", answer_url: "https://example.com/answer.xml", hangup_url: "https://example.com/hangup", ring_url: "https://example.com/ring", machine_detection: "hangup"
```

### Create an Endpoint

```text
Use tool plivo/create_endpoint with username: "agent001", password: "securePass123", alias: "Agent SIP", app_id: "APP_ID_HERE"
```
