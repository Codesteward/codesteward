# AWS — Launch Stack

## One-click

After this file is on `main` (public raw URL):

[![Launch Stack](https://img.shields.io/badge/AWS-Launch%20Stack-FF9900?logo=amazon-aws&logoColor=white)](https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?templateURL=https://raw.githubusercontent.com/Codesteward/codesteward/main/deploy/cloud/aws/cloudformation.yaml&stackName=codesteward)

Or:

```text
https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/quickcreate?templateURL=https://raw.githubusercontent.com/Codesteward/codesteward/main/deploy/cloud/aws/cloudformation.yaml&stackName=codesteward
```

## Parameters

| Parameter | Notes |
|-----------|--------|
| `InstanceType` | Default `t3.large` (8 GB) |
| `Domain` | Optional — enables Let's Encrypt via nginx edge |
| `AcmeEmail` | Used when Domain is set |
| `ImageTag` | Default `1.5.0` |
| `AllowedCIDR` | Restrict `0.0.0.0/0` for real use |

## After create

1. Point Domain A record at stack output `PublicIP` (if using TLS).
2. Wait ~5–10 minutes for first-boot (Docker + pull + compose).
3. `sudo cat /var/lib/codesteward/credentials.txt` (SSM or SSH).
4. Open UI → sign in with Keycloak → **Settings → Models**.

## Local validate

```bash
aws cloudformation validate-template \
  --template-body file://deploy/cloud/aws/cloudformation.yaml
```
