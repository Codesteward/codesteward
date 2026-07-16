# Codesteward Keycloak — official Keycloak + login theme + bootstrap realm.
#
# Image tags match **upstream Keycloak** (not product semver), so operators can
# see at a glance whether they run the latest patched IdP with our theme:
#
#   ghcr.io/<owner>/<repo>/keycloak:26.7.0   # same as quay.io/keycloak/keycloak:26.7.0
#   ghcr.io/<owner>/<repo>/keycloak:latest   # newest base we published
#
# Pin file: KEYCLOAK_VERSION (used by CI release + weekly base-update workflow).
#
# Build:
#   KC=$(cat KEYCLOAK_VERSION)
#   docker build --build-arg KEYCLOAK_VERSION=$KC -t codesteward-keycloak:$KC \
#     -f Dockerfile .

ARG KEYCLOAK_VERSION=26.7.0
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}

USER root

COPY --chown=1000:0 themes/codesteward /opt/keycloak/themes/codesteward

ARG REALM_FILE=realm-codesteward.json
COPY --chown=1000:0 ${REALM_FILE} /opt/keycloak/data/import/realm-codesteward.json

USER 1000

# Expose base version for `docker inspect` / k8s labels
ARG KEYCLOAK_VERSION
LABEL org.opencontainers.image.title="Codesteward Keycloak" \
      org.opencontainers.image.description="Keycloak with Codesteward login theme and bootstrap realm" \
      org.opencontainers.image.source="https://github.com/Codesteward/codesteward" \
      org.opencontainers.image.version="${KEYCLOAK_VERSION}" \
      org.codesteward.keycloak.base="${KEYCLOAK_VERSION}"
