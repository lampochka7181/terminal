# Supabase MCP Configuration for Cursor

## Quick Setup

To set up Supabase MCP in Cursor, follow these steps:

### Step 1: Get Your Personal Access Token

1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Click your profile → **Access Tokens**
3. Click **Generate New Token**
4. Name it "Cursor MCP" and copy the token

### Step 2: Open Cursor MCP Settings

1. Press `Cmd/Ctrl + Shift + P` to open the command palette
2. Type "MCP" and select "MCP Settings" or "Preferences: Open MCP Settings"

### Step 3: Add Supabase MCP Server

Add the following configuration to your MCP settings (replace `YOUR_ACCESS_TOKEN` with your PAT):

**For Windows with WSL (if using nvm):**
If Node.js is installed via nvm, use the Linux path format:

```json
{
  "mcpServers": {
    "supabase": {
      "command": "wsl",
      "args": [
        "bash",
        "-c",
        "source /home/alexd/.nvm/nvm.sh && npx -y @supabase/mcp-server-supabase@latest --access-token YOUR_ACCESS_TOKEN --project-ref zsypbmpfoqtfsuwkuvvy"
      ]
    }
  }
}
```

**Important:** Use `/home/alexd/.nvm/nvm.sh` (Linux path), NOT Windows paths like `C:\Users\...` when running in WSL.

**Or use the full path (replace with your npx path):**
```json
{
  "mcpServers": {
    "supabase": {
      "command": "wsl",
      "args": [
        "/home/alexd/.nvm/versions/node/v20.19.6/bin/npx",
        "-y",
        "@supabase/mcp-server-supabase@latest",
        "--access-token",
        "YOUR_ACCESS_TOKEN",
        "--project-ref",
        "zsypbmpfoqtfsuwkuvvy"
      ]
    }
  }
}
```

**For Windows (if Node.js is installed on Windows):**
```json
{
  "mcpServers": {
    "supabase": {
      "command": "npx",
      "args": [
        "-y",
        "@supabase/mcp-server-supabase@latest",
        "--access-token",
        "YOUR_ACCESS_TOKEN",
        "--project-ref",
        "zsypbmpfoqtfsuwkuvvy"
      ]
    }
  }
}
```

### Step 4: Restart Cursor

After adding the configuration, restart Cursor to apply the changes.

## Project Information

- **Project ID/Ref**: `zsypbmpfoqtfsuwkuvvy`
- **Project URL**: `https://zsypbmpfoqtfsuwkuvvy.supabase.co`

## Testing the Setup

Once configured, try asking Cursor:
- "Show me the database schema for this Supabase project"
- "List all tables in the database"
- "What's the structure of the markets table?"




