ARG NODE_IMAGE=node@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
FROM ${NODE_IMAGE}
WORKDIR /opt/forge
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY isolated-pi-session.mjs entrypoint.mjs ./
USER 65532:65532
ENV HOME=/tmp
ENTRYPOINT ["/usr/local/bin/node", "/opt/forge/entrypoint.mjs"]
