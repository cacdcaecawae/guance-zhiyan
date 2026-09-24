FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir python-docx==1.2.0 openpyxl==3.1.5 python-pptx==1.0.2 reportlab==4.4.3 \
    && mkdir -p /opt/gczy /workspace \
    && chown 1000:1000 /workspace
WORKDIR /opt/gczy
COPY server/sandbox/package.json server/sandbox/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server/sandbox/fs-worker.mjs /opt/gczy/fs-worker.mjs
ENV PATH="/opt/venv/bin:${PATH}"
WORKDIR /workspace
# OpenSandbox's execd runs as root; every app command explicitly uses uid/gid 1000.
CMD ["tail", "-f", "/dev/null"]
