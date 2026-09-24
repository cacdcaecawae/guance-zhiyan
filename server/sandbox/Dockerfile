FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir python-docx==1.2.0 openpyxl==3.1.5 python-pptx==1.0.2 reportlab==4.4.3 \
    && mkdir -p /opt/gczy /workspace \
    && chown 1000:1000 /workspace
WORKDIR /opt/gczy
RUN npm install --omit=dev --save-exact @deepseek-ai/cordis@4.0.4 @deepseek-ai/dsh-fs-local@0.1.7-rc.1
COPY server/sandbox/fs-worker.mjs /opt/gczy/fs-worker.mjs
ENV PATH="/opt/venv/bin:${PATH}"
WORKDIR /workspace
# OpenSandbox's execd runs as root; every app command explicitly uses uid/gid 1000.
CMD ["tail", "-f", "/dev/null"]
