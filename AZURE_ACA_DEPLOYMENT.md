# ConnectWise Manage MCP — Azure Container Apps Deployment Guide

**OAuth 2.1 + Entra ID · All secrets in Key Vault · Claude.ai web + Claude Code CLI**

---

## What This Guide Covers

This guide deploys the ConnectWise Manage MCP server to **Azure Container Apps (ACA)** using:

- **OAuth 2.1 with Entra ID** — Claude.ai web authenticates via your Azure AD tenant. No shared bearer tokens.
- **Key Vault for all config** — every environment variable, including static values, lives in Key Vault. Nothing is hardcoded or stored in shell history.
- **Managed Identity** — the Container App pulls secrets from Key Vault and images from ACR with no stored credentials.
- **Log Analytics** — all container logs stream automatically to Azure Monitor.

Two image paths are documented. Choose the one that fits your situation:

| Path | When to use |
|---|---|
| **A — With ACR** | You are running a fork with custom changes |
| **B — Without ACR** | You are deploying the upstream image from GHCR |

Both paths converge at Phase 7. Only the image reference differs.

### What This Guide Does NOT Cover

- **STDIO / Claude Desktop** — Claude Desktop uses the `stdio` transport and does not need a hosted server. See `README.md` for Claude Desktop setup.
- **GitHub Actions CI/CD** — image builds are manual in this guide. Automating pushes to ACR via GitHub Actions is straightforward once the infrastructure is in place.

---

## Architecture

```
Claude.ai (web)
     │
     │  HTTPS  ← ACA provides TLS automatically, no Caddy needed
     ▼
Azure Container Apps (external ingress, port 8080)
  {app}.{env}.{region}.azurecontainerapps.io  (or your custom domain)
     │
     ├── GET  /.well-known/oauth-protected-resource   ← RFC 9728
     ├── GET  /.well-known/oauth-authorization-server ← RFC 8414
     ├── POST /register                               ← RFC 7591
     ├── GET  /authorize  → proxies to Entra ID
     ├── POST /token      → proxies to Entra ID
     ├── GET  /health
     └── POST /mcp        ← MCP JSON-RPC (JWT-validated)
          │
          ▼
     Key Vault (all secrets via Managed Identity)
          │
          ▼
     ConnectWise Manage REST API
```

**Why no Caddy?** ACA terminates TLS and provides HTTPS automatically via a managed certificate on every app. Caddy is only needed for self-hosted deployments where you manage your own reverse proxy.

---

## Prerequisites

- **Azure CLI** installed and logged in (`az login`)
- **Docker Desktop** running (Path A only)
- **Entra ID app registration** completed — follow [`entra-app-registration.md`](entra-app-registration.md) before continuing. You need:
  - `AZURE_CLIENT_ID` (Application ID)
  - `AZURE_TENANT_ID` (Directory ID)
  - Redirect URI `https://claude.ai/api/mcp/auth_callback` registered under **Mobile and desktop applications**
  - `accessTokenAcceptedVersion: 2` set in the app manifest
  - API scope `api://<client-id>/access_as_user` created
  - App role `CWM.Access` created and assigned to the relevant users or groups

```powershell
# Verify you're logged in to the right subscription
az account show
az account set --subscription "YOUR_SUBSCRIPTION_NAME_OR_ID"
```

---

## Variables

Set these once. Every subsequent command references them — no copy-pasting GUIDs.

```powershell
# === Customize these ===
$RESOURCE_GROUP       = "rg-cwm-mcp"
$LOCATION             = "eastus"           # eastus, eastus2, westus2, etc.
$KEYVAULT_NAME        = "kv-cwm-mcp"       # Globally unique, 3-24 chars
$ACA_ENV_NAME         = "aca-env-cwm"
$ACA_APP_NAME         = "connectwise-manage-mcp"
$IDENTITY_NAME        = "id-cwm-mcp"
$LAW_NAME             = "law-cwm-mcp"      # Log Analytics workspace

# === Path A only (fork / custom build) ===
$ACR_NAME             = "acrcwmmcp"        # Globally unique, alphanumeric only, 5-50 chars

# === From your Entra ID app registration (entra-app-registration.md) ===
$AZURE_TENANT_ID      = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
$AZURE_CLIENT_ID      = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
$AZURE_AUDIENCE       = "api://$AZURE_CLIENT_ID"

# === ConnectWise Manage API credentials ===
# Company ID: the short identifier you use to log in to CWM
# Public/private key: create under Members > API Members in CWM
# Client ID: register at developer.connectwise.com
$CW_COMPANY_ID        = "yourcompany"
$CW_PUBLIC_KEY        = ""
$CW_PRIVATE_KEY       = ""
$CW_CLIENT_ID         = ""

# CWM API base URL — choose the region that matches your instance:
#   Cloud NA (default): https://api-na.myconnectwise.net
#   Cloud EU:           https://api-eu.myconnectwise.net
#   Cloud AU:           https://api-au.myconnectwise.net
#   Self-hosted:        https://cwm.yourcompany.com
$CW_URL               = "https://api-na.myconnectwise.net"

# Set to "false" only for self-hosted instances with self-signed TLS certs
$CW_REJECT_UNAUTHORIZED = "true"

# === Optional: static bearer token for Claude Code CLI ===
# Generate with: openssl rand -hex 32
# Leave empty ("") to disable CLI token auth and use OAuth only
$MCP_BEARER_TOKEN     = ""
```

> **Note:** `$AZURE_AUDIENCE` is constructed from `$AZURE_CLIENT_ID`. If token validation fails later, check the server logs for the actual `aud` claim and set this to match exactly.

---

## Phase 1 — Azure AD Pre-check

Before deploying infrastructure, confirm your app registration is correctly configured. A misconfigured registration is the most common cause of OAuth failures.

```powershell
# Verify the app registration exists
az ad app show --id $AZURE_CLIENT_ID --query "{name:displayName, id:appId}" --output table

# Confirm redirect URI is under Mobile/Desktop (not SPA or Web)
# Expected: ["https://claude.ai/api/mcp/auth_callback"]
az ad app show --id $AZURE_CLIENT_ID --query "publicClient.redirectUris" --output json

# Confirm the CWM.Access app role exists
az ad app show --id $AZURE_CLIENT_ID --query "appRoles[?value=='CWM.Access'].{name:displayName,value:value,enabled:isEnabled}" --output table

# Confirm accessTokenAcceptedVersion is 2 in the manifest
# Check in the portal: App Registration → Manifest → "accessTokenAcceptedVersion": 2
# If it reads null or 1, update it before proceeding.
```

**Expected redirect URI output:**
```json
[
  "https://claude.ai/api/mcp/auth_callback"
]
```

If anything is missing, complete the steps in [`entra-app-registration.md`](entra-app-registration.md) before continuing.

---

## Phase 2 — Resource Group and Key Vault

```powershell
# --- Resource Group ---
az group create `
  --name $RESOURCE_GROUP `
  --location $LOCATION

# --- Key Vault ---
# enable-rbac-authorization true: use Azure RBAC instead of legacy access policies.
az keyvault create `
  --name $KEYVAULT_NAME `
  --resource-group $RESOURCE_GROUP `
  --location $LOCATION `
  --enable-rbac-authorization true

# Save the Key Vault resource ID for role assignments
$KV_RESOURCE_ID = az keyvault show `
  --name $KEYVAULT_NAME `
  --query id `
  --output tsv
```

### Path A only — Azure Container Registry

Skip this block if you are using the upstream GHCR image (Path B).

```powershell
# admin-enabled false: use Managed Identity to pull images, not admin credentials
az acr create `
  --resource-group $RESOURCE_GROUP `
  --name $ACR_NAME `
  --sku Basic `
  --admin-enabled false

$ACR_LOGIN_SERVER = az acr show `
  --name $ACR_NAME `
  --query loginServer `
  --output tsv

$ACR_RESOURCE_ID = az acr show `
  --name $ACR_NAME `
  --query id `
  --output tsv

Write-Host "ACR login server: $ACR_LOGIN_SERVER"
```

---

## Phase 3 — Log Analytics Workspace and Managed Identity

### Log Analytics

ACA streams all container stdout/stderr to Log Analytics automatically. The MCP server logs every tool call, OAuth event, and error — all of it appears here.

```powershell
az monitor log-analytics workspace create `
  --resource-group $RESOURCE_GROUP `
  --workspace-name $LAW_NAME `
  --location $LOCATION

$LAW_CUSTOMER_ID = az monitor log-analytics workspace show `
  --resource-group $RESOURCE_GROUP `
  --workspace-name $LAW_NAME `
  --query customerId `
  --output tsv

$LAW_KEY = az monitor log-analytics workspace get-shared-keys `
  --resource-group $RESOURCE_GROUP `
  --workspace-name $LAW_NAME `
  --query primarySharedKey `
  --output tsv
```

### Managed Identity

The Container App uses this identity to pull images from ACR (Path A) and read secrets from Key Vault.

```powershell
az identity create `
  --name $IDENTITY_NAME `
  --resource-group $RESOURCE_GROUP

$IDENTITY_PRINCIPAL_ID = az identity show `
  --name $IDENTITY_NAME `
  --resource-group $RESOURCE_GROUP `
  --query principalId `
  --output tsv

$IDENTITY_RESOURCE_ID = az identity show `
  --name $IDENTITY_NAME `
  --resource-group $RESOURCE_GROUP `
  --query id `
  --output tsv

# --- Role: Key Vault Secrets User ---
az role assignment create `
  --assignee $IDENTITY_PRINCIPAL_ID `
  --role "Key Vault Secrets User" `
  --scope $KV_RESOURCE_ID

# --- Role: AcrPull (Path A only) ---
# Skip if using GHCR (Path B)
az role assignment create `
  --assignee $IDENTITY_PRINCIPAL_ID `
  --role "AcrPull" `
  --scope $ACR_RESOURCE_ID

Write-Host "Identity principal ID: $IDENTITY_PRINCIPAL_ID"
Write-Host "Identity resource ID:  $IDENTITY_RESOURCE_ID"
```

> Role assignments can take 1–2 minutes to propagate. If you hit permission errors in later phases, wait a moment and retry.

---

## Phase 4 — Container Apps Environment

```powershell
az extension add --name containerapp --upgrade

az containerapp env create `
  --name $ACA_ENV_NAME `
  --resource-group $RESOURCE_GROUP `
  --location $LOCATION `
  --logs-workspace-id $LAW_CUSTOMER_ID `
  --logs-workspace-key $LAW_KEY
```

---

## Phase 5 — Store All Secrets in Key Vault

Every configuration value lives in Key Vault. The Container App references all of these via `secretref:`.

```powershell
# --- ConnectWise Manage ---
az keyvault secret set --vault-name $KEYVAULT_NAME --name "CW-COMPANY-ID"          --value $CW_COMPANY_ID
az keyvault secret set --vault-name $KEYVAULT_NAME --name "CW-PUBLIC-KEY"           --value $CW_PUBLIC_KEY
az keyvault secret set --vault-name $KEYVAULT_NAME --name "CW-PRIVATE-KEY"          --value $CW_PRIVATE_KEY
az keyvault secret set --vault-name $KEYVAULT_NAME --name "CW-CLIENT-ID"            --value $CW_CLIENT_ID
az keyvault secret set --vault-name $KEYVAULT_NAME --name "CW-URL"                  --value $CW_URL
az keyvault secret set --vault-name $KEYVAULT_NAME --name "CW-REJECT-UNAUTHORIZED"  --value $CW_REJECT_UNAUTHORIZED

# --- Entra ID / OAuth ---
az keyvault secret set --vault-name $KEYVAULT_NAME --name "AZURE-TENANT-ID"         --value $AZURE_TENANT_ID
az keyvault secret set --vault-name $KEYVAULT_NAME --name "AZURE-CLIENT-ID"         --value $AZURE_CLIENT_ID
az keyvault secret set --vault-name $KEYVAULT_NAME --name "AZURE-AUDIENCE"          --value $AZURE_AUDIENCE
az keyvault secret set --vault-name $KEYVAULT_NAME --name "AZURE-REQUIRED-ROLE"     --value "CWM.Access"

# --- MCP Server ---
az keyvault secret set --vault-name $KEYVAULT_NAME --name "MCP-TRANSPORT"           --value "http"
az keyvault secret set --vault-name $KEYVAULT_NAME --name "MCP-HTTP-PORT"           --value "8080"
az keyvault secret set --vault-name $KEYVAULT_NAME --name "MCP-HTTP-HOST"           --value "0.0.0.0"
az keyvault secret set --vault-name $KEYVAULT_NAME --name "AUTH-MODE"               --value "env"
az keyvault secret set --vault-name $KEYVAULT_NAME --name "MCP-OAUTH-ENABLED"       --value "true"

# --- Optional: Static bearer token for Claude Code CLI ---
# Skip (or set to a random string) if you do not need CLI access
# Generate: openssl rand -hex 32
az keyvault secret set --vault-name $KEYVAULT_NAME --name "MCP-BEARER-TOKEN"        --value $MCP_BEARER_TOKEN

# --- Runtime ---
az keyvault secret set --vault-name $KEYVAULT_NAME --name "NODE-ENV"                --value "production"
az keyvault secret set --vault-name $KEYVAULT_NAME --name "LOG-LEVEL"               --value "info"

# Note: MCP-SERVER-URL is set in Phase 8 after the ACA FQDN is known.
```

### Retrieve Secret URIs

ACA Key Vault references require the versioned secret URI. Retrieve all of them now:

```powershell
$KV_URI_CW_COMPANY    = az keyvault secret show --vault-name $KEYVAULT_NAME --name "CW-COMPANY-ID"         --query id --output tsv
$KV_URI_CW_PUBLIC     = az keyvault secret show --vault-name $KEYVAULT_NAME --name "CW-PUBLIC-KEY"          --query id --output tsv
$KV_URI_CW_PRIVATE    = az keyvault secret show --vault-name $KEYVAULT_NAME --name "CW-PRIVATE-KEY"         --query id --output tsv
$KV_URI_CW_CLIENT     = az keyvault secret show --vault-name $KEYVAULT_NAME --name "CW-CLIENT-ID"           --query id --output tsv
$KV_URI_CW_URL        = az keyvault secret show --vault-name $KEYVAULT_NAME --name "CW-URL"                 --query id --output tsv
$KV_URI_CW_REJECT     = az keyvault secret show --vault-name $KEYVAULT_NAME --name "CW-REJECT-UNAUTHORIZED" --query id --output tsv
$KV_URI_TENANT_ID     = az keyvault secret show --vault-name $KEYVAULT_NAME --name "AZURE-TENANT-ID"        --query id --output tsv
$KV_URI_CLIENT_ID     = az keyvault secret show --vault-name $KEYVAULT_NAME --name "AZURE-CLIENT-ID"        --query id --output tsv
$KV_URI_AUDIENCE      = az keyvault secret show --vault-name $KEYVAULT_NAME --name "AZURE-AUDIENCE"         --query id --output tsv
$KV_URI_REQUIRED_ROLE = az keyvault secret show --vault-name $KEYVAULT_NAME --name "AZURE-REQUIRED-ROLE"    --query id --output tsv
$KV_URI_TRANSPORT     = az keyvault secret show --vault-name $KEYVAULT_NAME --name "MCP-TRANSPORT"          --query id --output tsv
$KV_URI_HTTP_PORT     = az keyvault secret show --vault-name $KEYVAULT_NAME --name "MCP-HTTP-PORT"          --query id --output tsv
$KV_URI_HTTP_HOST     = az keyvault secret show --vault-name $KEYVAULT_NAME --name "MCP-HTTP-HOST"          --query id --output tsv
$KV_URI_AUTH_MODE     = az keyvault secret show --vault-name $KEYVAULT_NAME --name "AUTH-MODE"              --query id --output tsv
$KV_URI_OAUTH         = az keyvault secret show --vault-name $KEYVAULT_NAME --name "MCP-OAUTH-ENABLED"      --query id --output tsv
$KV_URI_BEARER        = az keyvault secret show --vault-name $KEYVAULT_NAME --name "MCP-BEARER-TOKEN"       --query id --output tsv
$KV_URI_NODE_ENV      = az keyvault secret show --vault-name $KEYVAULT_NAME --name "NODE-ENV"               --query id --output tsv
$KV_URI_LOG_LEVEL     = az keyvault secret show --vault-name $KEYVAULT_NAME --name "LOG-LEVEL"              --query id --output tsv
```

---

## Phase 6 — Container Image

### Path A — Build and Push to ACR (fork / custom build)

Use this path if you are deploying a fork with custom changes.

```powershell
# Authenticate Docker to ACR using your Azure login (no admin password needed)
az acr login --name $ACR_NAME

# Build from the repo root
docker build -t "$ACR_LOGIN_SERVER/connectwise-manage-mcp:latest" .

# Push to ACR
docker push "$ACR_LOGIN_SERVER/connectwise-manage-mcp:latest"

# Verify the image is there
az acr repository list --name $ACR_NAME --output table

# Set the image reference variable used in Phase 7
$IMAGE_REF = "$ACR_LOGIN_SERVER/connectwise-manage-mcp:latest"
```

### Path B — Use Upstream GHCR Image (no ACR required)

Use this path if you are deploying the unmodified upstream image. No Docker build needed; skip the ACR steps in Phases 2 and 3 as well.

```powershell
# Set the image reference variable used in Phase 7
$IMAGE_REF = "ghcr.io/wyre-ai/connectwise-manage-mcp:latest"
```

> **Note:** If your fork's changes are merged upstream, you can switch from Path A to Path B and decommission ACR entirely.

---

## Phase 7 — Deploy Container App (Step 1: without MCP_SERVER_URL)

### Why two steps?

`MCP_SERVER_URL` must be set to the Container App's public HTTPS URL — it appears in the OAuth discovery documents that Claude.ai reads. But ACA generates this URL only after the app is created.

In this step we create the app with all secrets except `MCP_SERVER_URL`. The server starts and passes health checks, but OAuth will not work yet because the discovery endpoints return `http://localhost:8080` as the server URL. **Do not connect Claude.ai yet.**

### Path A — With ACR

```powershell
az containerapp create `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --environment $ACA_ENV_NAME `
  --image $IMAGE_REF `
  --registry-server $ACR_LOGIN_SERVER `
  --registry-identity $IDENTITY_RESOURCE_ID `
  --user-assigned $IDENTITY_RESOURCE_ID `
  --target-port 8080 `
  --ingress external `
  --min-replicas 1 `
  --max-replicas 3 `
  --cpu 0.5 `
  --memory 1.0Gi `
  --secrets `
    "cw-company-id=keyvaultref:$KV_URI_CW_COMPANY,identityref:$IDENTITY_RESOURCE_ID" `
    "cw-public-key=keyvaultref:$KV_URI_CW_PUBLIC,identityref:$IDENTITY_RESOURCE_ID" `
    "cw-private-key=keyvaultref:$KV_URI_CW_PRIVATE,identityref:$IDENTITY_RESOURCE_ID" `
    "cw-client-id=keyvaultref:$KV_URI_CW_CLIENT,identityref:$IDENTITY_RESOURCE_ID" `
    "cw-url=keyvaultref:$KV_URI_CW_URL,identityref:$IDENTITY_RESOURCE_ID" `
    "cw-reject-unauthorized=keyvaultref:$KV_URI_CW_REJECT,identityref:$IDENTITY_RESOURCE_ID" `
    "azure-tenant-id=keyvaultref:$KV_URI_TENANT_ID,identityref:$IDENTITY_RESOURCE_ID" `
    "azure-client-id=keyvaultref:$KV_URI_CLIENT_ID,identityref:$IDENTITY_RESOURCE_ID" `
    "azure-audience=keyvaultref:$KV_URI_AUDIENCE,identityref:$IDENTITY_RESOURCE_ID" `
    "azure-required-role=keyvaultref:$KV_URI_REQUIRED_ROLE,identityref:$IDENTITY_RESOURCE_ID" `
    "mcp-transport=keyvaultref:$KV_URI_TRANSPORT,identityref:$IDENTITY_RESOURCE_ID" `
    "mcp-http-port=keyvaultref:$KV_URI_HTTP_PORT,identityref:$IDENTITY_RESOURCE_ID" `
    "mcp-http-host=keyvaultref:$KV_URI_HTTP_HOST,identityref:$IDENTITY_RESOURCE_ID" `
    "auth-mode=keyvaultref:$KV_URI_AUTH_MODE,identityref:$IDENTITY_RESOURCE_ID" `
    "mcp-oauth-enabled=keyvaultref:$KV_URI_OAUTH,identityref:$IDENTITY_RESOURCE_ID" `
    "mcp-bearer-token=keyvaultref:$KV_URI_BEARER,identityref:$IDENTITY_RESOURCE_ID" `
    "node-env=keyvaultref:$KV_URI_NODE_ENV,identityref:$IDENTITY_RESOURCE_ID" `
    "log-level=keyvaultref:$KV_URI_LOG_LEVEL,identityref:$IDENTITY_RESOURCE_ID" `
  --env-vars `
    "CW_MANAGE_COMPANY_ID=secretref:cw-company-id" `
    "CW_MANAGE_PUBLIC_KEY=secretref:cw-public-key" `
    "CW_MANAGE_PRIVATE_KEY=secretref:cw-private-key" `
    "CW_MANAGE_CLIENT_ID=secretref:cw-client-id" `
    "CW_MANAGE_URL=secretref:cw-url" `
    "CW_MANAGE_REJECT_UNAUTHORIZED=secretref:cw-reject-unauthorized" `
    "AZURE_TENANT_ID=secretref:azure-tenant-id" `
    "AZURE_CLIENT_ID=secretref:azure-client-id" `
    "AZURE_AUDIENCE=secretref:azure-audience" `
    "AZURE_REQUIRED_ROLE=secretref:azure-required-role" `
    "MCP_TRANSPORT=secretref:mcp-transport" `
    "MCP_HTTP_PORT=secretref:mcp-http-port" `
    "MCP_HTTP_HOST=secretref:mcp-http-host" `
    "AUTH_MODE=secretref:auth-mode" `
    "MCP_OAUTH_ENABLED=secretref:mcp-oauth-enabled" `
    "MCP_BEARER_TOKEN=secretref:mcp-bearer-token" `
    "NODE_ENV=secretref:node-env" `
    "LOG_LEVEL=secretref:log-level"
```

### Path B — Without ACR (GHCR public image)

The command is identical except there is no `--registry-server`, `--registry-identity`, or `AcrPull` needed. ACA can pull public GHCR images without credentials.

```powershell
az containerapp create `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --environment $ACA_ENV_NAME `
  --image $IMAGE_REF `
  --user-assigned $IDENTITY_RESOURCE_ID `
  --target-port 8080 `
  --ingress external `
  --min-replicas 1 `
  --max-replicas 3 `
  --cpu 0.5 `
  --memory 1.0Gi `
  --secrets `
    "cw-company-id=keyvaultref:$KV_URI_CW_COMPANY,identityref:$IDENTITY_RESOURCE_ID" `
    "cw-public-key=keyvaultref:$KV_URI_CW_PUBLIC,identityref:$IDENTITY_RESOURCE_ID" `
    "cw-private-key=keyvaultref:$KV_URI_CW_PRIVATE,identityref:$IDENTITY_RESOURCE_ID" `
    "cw-client-id=keyvaultref:$KV_URI_CW_CLIENT,identityref:$IDENTITY_RESOURCE_ID" `
    "cw-url=keyvaultref:$KV_URI_CW_URL,identityref:$IDENTITY_RESOURCE_ID" `
    "cw-reject-unauthorized=keyvaultref:$KV_URI_CW_REJECT,identityref:$IDENTITY_RESOURCE_ID" `
    "azure-tenant-id=keyvaultref:$KV_URI_TENANT_ID,identityref:$IDENTITY_RESOURCE_ID" `
    "azure-client-id=keyvaultref:$KV_URI_CLIENT_ID,identityref:$IDENTITY_RESOURCE_ID" `
    "azure-audience=keyvaultref:$KV_URI_AUDIENCE,identityref:$IDENTITY_RESOURCE_ID" `
    "azure-required-role=keyvaultref:$KV_URI_REQUIRED_ROLE,identityref:$IDENTITY_RESOURCE_ID" `
    "mcp-transport=keyvaultref:$KV_URI_TRANSPORT,identityref:$IDENTITY_RESOURCE_ID" `
    "mcp-http-port=keyvaultref:$KV_URI_HTTP_PORT,identityref:$IDENTITY_RESOURCE_ID" `
    "mcp-http-host=keyvaultref:$KV_URI_HTTP_HOST,identityref:$IDENTITY_RESOURCE_ID" `
    "auth-mode=keyvaultref:$KV_URI_AUTH_MODE,identityref:$IDENTITY_RESOURCE_ID" `
    "mcp-oauth-enabled=keyvaultref:$KV_URI_OAUTH,identityref:$IDENTITY_RESOURCE_ID" `
    "mcp-bearer-token=keyvaultref:$KV_URI_BEARER,identityref:$IDENTITY_RESOURCE_ID" `
    "node-env=keyvaultref:$KV_URI_NODE_ENV,identityref:$IDENTITY_RESOURCE_ID" `
    "log-level=keyvaultref:$KV_URI_LOG_LEVEL,identityref:$IDENTITY_RESOURCE_ID" `
  --env-vars `
    "CW_MANAGE_COMPANY_ID=secretref:cw-company-id" `
    "CW_MANAGE_PUBLIC_KEY=secretref:cw-public-key" `
    "CW_MANAGE_PRIVATE_KEY=secretref:cw-private-key" `
    "CW_MANAGE_CLIENT_ID=secretref:cw-client-id" `
    "CW_MANAGE_URL=secretref:cw-url" `
    "CW_MANAGE_REJECT_UNAUTHORIZED=secretref:cw-reject-unauthorized" `
    "AZURE_TENANT_ID=secretref:azure-tenant-id" `
    "AZURE_CLIENT_ID=secretref:azure-client-id" `
    "AZURE_AUDIENCE=secretref:azure-audience" `
    "AZURE_REQUIRED_ROLE=secretref:azure-required-role" `
    "MCP_TRANSPORT=secretref:mcp-transport" `
    "MCP_HTTP_PORT=secretref:mcp-http-port" `
    "MCP_HTTP_HOST=secretref:mcp-http-host" `
    "AUTH_MODE=secretref:auth-mode" `
    "MCP_OAUTH_ENABLED=secretref:mcp-oauth-enabled" `
    "MCP_BEARER_TOKEN=secretref:mcp-bearer-token" `
    "NODE_ENV=secretref:node-env" `
    "LOG_LEVEL=secretref:log-level"
```

### Confirm it started

```powershell
# Get the public FQDN — save this, you'll need it throughout
$MCP_FQDN = az containerapp show `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --query properties.configuration.ingress.fqdn `
  --output tsv

Write-Host "Container App URL: https://$MCP_FQDN"

# Health check — should return {"status":"ok","transport":"http","authMode":"env","oauthEnabled":true,...}
Invoke-RestMethod -Uri "https://$MCP_FQDN/health"
```

If the health check returns 200 with `"oauthEnabled": true`, the container is running and Key Vault access is working. Proceed to Phase 8.

---

## Phase 8 — Set MCP_SERVER_URL (Step 2: complete OAuth config)

Now that we have the FQDN, store it in Key Vault and wire it into the Container App. This makes the OAuth discovery endpoints return the correct URLs.

```powershell
$MCP_SERVER_URL = "https://$MCP_FQDN"

# Store in Key Vault
az keyvault secret set `
  --vault-name $KEYVAULT_NAME `
  --name "MCP-SERVER-URL" `
  --value $MCP_SERVER_URL

$KV_URI_MCP_URL = az keyvault secret show `
  --vault-name $KEYVAULT_NAME `
  --name "MCP-SERVER-URL" `
  --query id `
  --output tsv

# Add the secret reference to the Container App
az containerapp secret set `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --secrets "mcp-server-url=keyvaultref:$KV_URI_MCP_URL,identityref:$IDENTITY_RESOURCE_ID"

# Wire the env var to the new secret — this triggers a new revision automatically
az containerapp update `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --set-env-vars "MCP_SERVER_URL=secretref:mcp-server-url"

Write-Host "MCP Server URL: $MCP_SERVER_URL"
Write-Host "MCP Endpoint:   $MCP_SERVER_URL/mcp"
```

### Verify the OAuth discovery documents

```powershell
# Protected resource — authorization_servers must equal ["https://{your-fqdn}"]
$pr = Invoke-RestMethod -Uri "https://$MCP_FQDN/.well-known/oauth-protected-resource"
Write-Host "authorization_servers: $($pr.authorization_servers)"

# Authorization server metadata — issuer must equal "https://{your-fqdn}"
$as = Invoke-RestMethod -Uri "https://$MCP_FQDN/.well-known/oauth-authorization-server"
Write-Host "issuer:                 $($as.issuer)"
Write-Host "authorization_endpoint: $($as.authorization_endpoint)"
Write-Host "token_endpoint:         $($as.token_endpoint)"
```

If `issuer` still shows `http://localhost:8080`, the new revision hasn't finished deploying. Wait 30 seconds and retry.

---

## Phase 9 — Connect Claude.ai

1. Go to **Claude.ai → Settings → Integrations → Add custom integration**
2. Enter URL: `https://{your-fqdn}/mcp`
3. Select **OAuth 2.0**
4. Click **Connect** — a Microsoft login page should appear
5. Sign in with your Entra ID account
6. The integration should show as **Connected**

**Test it:**

```
List all open tickets
```

or

```
Search for companies matching "Acme"
```

---

## Optional: Claude Code CLI Access

The server supports a static `MCP_BEARER_TOKEN` alongside OAuth, allowing Claude Code CLI users to connect without going through the OAuth browser flow.

If you set `$MCP_BEARER_TOKEN` in the Variables section above, add the server to Claude Code CLI with:

```bash
claude mcp add --transport http cwm "https://$MCP_FQDN/mcp" \
  --header "Authorization: Bearer YOUR_BEARER_TOKEN"
```

> The bearer token uses timing-safe comparison internally. Generate a strong token with `openssl rand -hex 32` and store it only in Key Vault — never in shell history or config files.

---

## Optional: Custom Domain

```powershell
# Add your custom hostname
az containerapp hostname add `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --hostname "mcp.yourcompany.com"

# The command outputs a verification token and CNAME target.
# In your DNS provider, create:
#   CNAME  mcp.yourcompany.com  →  {your-fqdn}.azurecontainerapps.io
#   TXT    asuid.mcp            →  {verification-token from above}

# Once DNS propagates, bind the managed certificate
az containerapp hostname bind `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --hostname "mcp.yourcompany.com" `
  --environment $ACA_ENV_NAME `
  --validation-method CNAME
```

Then update `MCP-SERVER-URL` in Key Vault to your custom domain and trigger a new revision:

```powershell
az keyvault secret set `
  --vault-name $KEYVAULT_NAME `
  --name "MCP-SERVER-URL" `
  --value "https://mcp.yourcompany.com"

az containerapp update `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --image $IMAGE_REF
```

---

## Maintenance

### View Live Logs

```powershell
# Stream live from the Container App
az containerapp logs show `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --follow

# Or query Log Analytics for historical logs
# In the Azure portal: Log Analytics → $LAW_NAME → Logs
# Sample Kusto query:
# ContainerAppConsoleLogs_CL
# | where ContainerAppName_s == "connectwise-manage-mcp"
# | project TimeGenerated, Log_s
# | order by TimeGenerated desc
# | take 100
```

### Update to a New Image Version (Path A)

```powershell
cd /path/to/connectwise-manage-mcp
git pull

az acr login --name $ACR_NAME
docker build -t "$ACR_LOGIN_SERVER/connectwise-manage-mcp:latest" .
docker push "$ACR_LOGIN_SERVER/connectwise-manage-mcp:latest"

az containerapp update `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --image "$ACR_LOGIN_SERVER/connectwise-manage-mcp:latest"
```

### Update to a New Image Version (Path B)

```powershell
# Force ACA to pull the latest GHCR image by triggering a new revision
az containerapp update `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --image "ghcr.io/wyre-ai/connectwise-manage-mcp:latest"
```

### Rotate ConnectWise API Keys

```powershell
az keyvault secret set `
  --vault-name $KEYVAULT_NAME `
  --name "CW-PUBLIC-KEY" `
  --value "NEW_PUBLIC_KEY"

az keyvault secret set `
  --vault-name $KEYVAULT_NAME `
  --name "CW-PRIVATE-KEY" `
  --value "NEW_PRIVATE_KEY"

# Force a restart to pick up the new secret versions
az containerapp update `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --image $IMAGE_REF
```

### Rotate the Static Bearer Token

```powershell
$NEW_TOKEN = (openssl rand -hex 32)

az keyvault secret set `
  --vault-name $KEYVAULT_NAME `
  --name "MCP-BEARER-TOKEN" `
  --value $NEW_TOKEN

az containerapp update `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --image $IMAGE_REF

Write-Host "New bearer token: $NEW_TOKEN"
# Update the token in Claude Code CLI:
# claude mcp remove cwm
# claude mcp add --transport http cwm "https://$MCP_FQDN/mcp" --header "Authorization: Bearer $NEW_TOKEN"
```

### Teardown

```powershell
# Remove all resources at once — Key Vault uses soft delete by default (90-day recovery)
az group delete --name $RESOURCE_GROUP --yes --no-wait

# Permanently delete the Key Vault immediately (optional)
az keyvault purge --name $KEYVAULT_NAME --location $LOCATION
```

---

## Troubleshooting

### "Couldn't reach the MCP server" in Claude.ai

Check that `MCP_SERVER_URL` is set correctly:

```powershell
$as = Invoke-RestMethod -Uri "https://$MCP_FQDN/.well-known/oauth-authorization-server"
$as.issuer
# Must equal "https://{your-fqdn}", not "http://localhost:8080"
```

If it shows `localhost`, `MCP-SERVER-URL` in Key Vault wasn't picked up. Check:

1. The secret exists: `az keyvault secret show --vault-name $KEYVAULT_NAME --name "MCP-SERVER-URL"`
2. The Container App has the env var: `az containerapp show --name $ACA_APP_NAME --resource-group $RESOURCE_GROUP --query "properties.template.containers[0].env"`
3. Force a new revision: `az containerapp update --name $ACA_APP_NAME --resource-group $RESOURCE_GROUP --image $IMAGE_REF`

### OAuth Opens but Shows AADSTS50011 (Redirect URI Mismatch)

The URI `https://claude.ai/api/mcp/auth_callback` is not registered, or it is registered under the wrong platform (Web or SPA instead of Mobile and desktop applications).

Go to: **Azure portal → App registrations → {your app} → Authentication → Mobile and desktop applications → Add URI**

Add exactly: `https://claude.ai/api/mcp/auth_callback`

### AADSTS65001 — User Has Not Consented / No Role Assigned

The user has not been assigned the `CWM.Access` app role.

Go to: **Azure portal → Enterprise applications → CWM-MCP-Server → Users and groups → Add user/group**

Select the user or group, assign the **CWM Access** role, and click **Assign**. See [`entra-app-registration.md`](entra-app-registration.md) Step 8 for details.

### OAuth Completes but Token Validation Fails (Audience Mismatch)

Check server logs for the actual audience in the token:

```powershell
az containerapp logs show `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --follow
# Look for: "[auth]" log lines containing "tokenAudience"
```

Update `AZURE-AUDIENCE` in Key Vault to match the `tokenAudience` value exactly, then restart:

```powershell
az keyvault secret set `
  --vault-name $KEYVAULT_NAME `
  --name "AZURE-AUDIENCE" `
  --value "THE_ACTUAL_AUDIENCE_FROM_LOGS"

az containerapp update `
  --name $ACA_APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --image $IMAGE_REF
```

### Container Fails to Start (Key Vault Access Denied)

The Managed Identity doesn't have the `Key Vault Secrets User` role yet. Role assignments can take a few minutes to propagate.

```powershell
az role assignment list `
  --assignee $IDENTITY_PRINCIPAL_ID `
  --role "Key Vault Secrets User" `
  --scope $KV_RESOURCE_ID `
  --output table
```

If the assignment is missing, re-run the role assignment from Phase 3 and wait 2 minutes before redeploying.

### `accessTokenAcceptedVersion` Resets

Azure occasionally resets this during manifest edits. If token issuer validation starts failing after previously working, re-check the app manifest in the portal and ensure `"accessTokenAcceptedVersion": 2` is present (integer, not string).

### ConnectWise API Returns 401

Verify the credentials stored in Key Vault are correct:

```powershell
az keyvault secret show --vault-name $KEYVAULT_NAME --name "CW-PUBLIC-KEY"  --query value --output tsv
az keyvault secret show --vault-name $KEYVAULT_NAME --name "CW-COMPANY-ID"  --query value --output tsv
```

Also confirm the API member exists and is active in CWM under **Members → API Members**, and that the Client ID matches what is registered at `developer.connectwise.com`.

---

## Cost Estimate

| Resource | Tier | Approx. Monthly |
|---|---|---|
| Azure Container Apps | Consumption (1 replica, 0.5 vCPU / 1 GB) | ~$10–15 |
| Azure Container Registry | Basic (Path A only) | ~$5 |
| Azure Key Vault | Standard (< 10K ops/mo) | ~$0.03 |
| Log Analytics | Pay-per-GB (low volume) | ~$2–5 |
| **Total (Path A)** | | **~$17–25/month** |
| **Total (Path B, no ACR)** | | **~$12–20/month** |

---

## Security Summary

| Control | Implementation |
|---|---|
| No secrets in source control | All values in Key Vault |
| No secrets in shell history | Variables set once, referenced via `$KV_URI_*` |
| No admin credentials for ACR | Managed Identity with AcrPull role (Path A) |
| Transport encryption | ACA enforces HTTPS, no Caddy needed |
| Authentication | Short-lived Azure AD JWTs (OAuth 2.1 with PKCE) |
| Role-based access control | `CWM.Access` app role enforced on every request |
| No shared bearer tokens | OAuth-only for Claude.ai; optional static token for CLI only |
| Timing-safe token comparison | Bearer token uses `crypto.timingSafeEqual` to prevent oracle attacks |
| Non-root container user | `cwmanage` (UID 1001) |
| Request body size limit | 64 KB enforced on OAuth endpoints |
| Audit trail | Log Analytics captures all tool calls and auth events |

---

*ConnectWise Manage MCP v1.2.0 · March 2026*
*Entra ID app registration: [`entra-app-registration.md`](entra-app-registration.md)*
*Self-hosted / Docker deployment: [`README.md`](README.md)*
