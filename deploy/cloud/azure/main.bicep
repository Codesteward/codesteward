// Codesteward Review cloud trial — single Linux VM + Docker Compose stack.

@description('Base name for resources')
param namePrefix string = 'codesteward'

@description('Azure region')
param location string = resourceGroup().location

@description('VM size (8 GB+ recommended)')
param vmSize string = 'Standard_D2s_v5'

@description('Admin username for SSH')
param adminUsername string = 'azureuser'

@description('SSH public key')
@secure()
param adminPublicKey string

@description('Optional public DNS name for TLS (A record → public IP)')
param domain string = ''

@description('Let\'s Encrypt email when domain is set')
param acmeEmail string = ''

@description('Container image tag')
param imageTag string = '1.5.0'

@description('Git ref to clone')
param gitRef string = 'main'

var vmName = '${namePrefix}-vm'
var nicName = '${namePrefix}-nic'
var pipName = '${namePrefix}-pip'
var nsgName = '${namePrefix}-nsg'
var vnetName = '${namePrefix}-vnet'

// format() so domain/imageTag/etc. are real Bicep interpolations (''' multi-line can leave ${} literal)
var cloudInit = format('''#cloud-config
package_update: true
packages:
  - git
  - curl
  - ca-certificates
  - openssl
  - python3
  - jq
  - gnupg
write_files:
  - path: /etc/codesteward/boot.env
    permissions: '0600'
    content: |
      DOMAIN={0}
      ACME_EMAIL={1}
      IMAGE_TAG={2}
      GIT_REF={3}
runcmd:
  - |
    set -euo pipefail
    exec >>/var/log/codesteward-user-data.log 2>&1
    echo "codesteward cloud-init start"
    set -a
    . /etc/codesteward/boot.env
    set +a
    export DOMAIN ACME_EMAIL IMAGE_TAG
    export PUBLIC_IP="$(curl -fsS --max-time 3 -H Metadata:true --noproxy '*' \
      'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-12-13&format=text' || true)"
    REF="${{GIT_REF:-main}}"
    INSTALL_DIR=/opt/codesteward
    if [[ ! -d "$INSTALL_DIR/.git" ]]; then
      git clone --depth 1 --branch "$REF" https://github.com/Codesteward/codesteward.git "$INSTALL_DIR" \
        || git clone --depth 1 https://github.com/Codesteward/codesteward.git "$INSTALL_DIR"
    fi
    cd "$INSTALL_DIR"
    git fetch --depth 1 origin "$REF" || true
    git checkout "$REF" 2>/dev/null || true
    bash "$INSTALL_DIR/deploy/cloud/first-boot.sh"
    echo "codesteward cloud-init done"
''', domain, acmeEmail, imageTag, gitRef)

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: nsgName
  location: location
  properties: {
    securityRules: [
      {
        name: 'SSH'
        properties: {
          priority: 1000
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '22'
        }
      }
      {
        name: 'HTTP'
        properties: {
          priority: 1010
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '80'
        }
      }
      {
        name: 'HTTPS'
        properties: {
          priority: 1020
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '443'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.60.0.0/16'] }
    subnets: [
      {
        name: 'default'
        properties: {
          addressPrefix: '10.60.1.0/24'
          networkSecurityGroup: { id: nsg.id }
        }
      }
    ]
  }
}

resource pip 'Microsoft.Network/publicIPAddresses@2023-09-01' = {
  name: pipName
  location: location
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2023-09-01' = {
  name: nicName
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: { id: vnet.properties.subnets[0].id }
          privateIPAllocationMethod: 'Dynamic'
          publicIPAddress: { id: pip.id }
        }
      }
    ]
    networkSecurityGroup: { id: nsg.id }
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2023-09-01' = {
  name: vmName
  location: location
  properties: {
    hardwareProfile: { vmSize: vmSize }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: adminPublicKey
            }
          ]
        }
      }
      customData: base64(cloudInit)
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: { storageAccountType: 'Premium_LRS' }
        diskSizeGB: 40
      }
    }
    networkProfile: {
      networkInterfaces: [ { id: nic.id } ]
    }
  }
}

output publicIp string = pip.properties.ipAddress
output uiUrl string = 'http://${pip.properties.ipAddress}/'
output credentialsPath string = '/var/lib/codesteward/credentials.txt'
output sshHint string = 'ssh ${adminUsername}@${pip.properties.ipAddress}'
