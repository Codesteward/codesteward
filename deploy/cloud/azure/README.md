# Azure — Deploy to Azure

## Portal (Bicep → template)

From a machine with Azure CLI:

```bash
az group create -n codesteward-rg -l eastus
az deployment group create \
  -g codesteward-rg \
  -f deploy/cloud/azure/main.bicep \
  --parameters adminPublicKey="$(cat ~/.ssh/id_rsa.pub)" imageTag=1.2.0
```

## Deploy button (after ARM export is published)

Convert Bicep when ready:

```bash
az bicep build -f deploy/cloud/azure/main.bicep --outfile deploy/cloud/azure/azuredeploy.json
```

Then:

```text
https://portal.azure.com/#create/Microsoft.Template/uri/<urlencoded-raw-github-azuredeploy.json>
```

Badge (once `azuredeploy.json` is on `main`):

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FCodesteward%2Fcodesteward%2Fmain%2Fdeploy%2Fcloud%2Fazure%2Fazuredeploy.json)

> Note: `adminPublicKey` is required; set it in the portal parameters form.

## After deploy

1. Optional: point Domain at the public IP output.
2. Wait for first-boot; then `ssh` and `sudo cat /var/lib/codesteward/credentials.txt`.
3. Open UI → Keycloak login → **Settings → Models**.
