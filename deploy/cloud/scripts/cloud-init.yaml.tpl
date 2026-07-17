#cloud-config
# Template variables: {{DOMAIN}} {{ACME_EMAIL}} {{IMAGE_TAG}} {{GIT_REF}}
package_update: true
packages:
  - curl
  - ca-certificates
  - gnupg
  - git
  - openssl
  - python3
  - jq

write_files:
  - path: /etc/codesteward/boot.env
    permissions: "0600"
    content: |
      DOMAIN={{DOMAIN}}
      ACME_EMAIL={{ACME_EMAIL}}
      IMAGE_TAG={{IMAGE_TAG}}
      GIT_REF={{GIT_REF}}

runcmd:
  - |
    set -euo pipefail
    # shellcheck disable=SC1091
    . /etc/codesteward/boot.env
    export DOMAIN ACME_EMAIL IMAGE_TAG
    REF="${GIT_REF:-main}"
    INSTALL_DIR=/opt/codesteward
    if [[ ! -d "$INSTALL_DIR/.git" ]]; then
      git clone --depth 1 --branch "$REF" https://github.com/Codesteward/codesteward.git "$INSTALL_DIR"
    fi
    cd "$INSTALL_DIR"
    git fetch --depth 1 origin "$REF" || true
    git checkout "$REF" || true
    export DOMAIN ACME_EMAIL IMAGE_TAG
    bash "$INSTALL_DIR/deploy/cloud/first-boot.sh"
