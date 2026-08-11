FROM ubuntu:latest

WORKDIR /elastic-agent/

# The selected provider is non-secret configuration. DEEPSEEK_API_KEY is supplied
# separately by the runtime environment and must never be baked into this image.
# Inject it at launch with Docker's `--env DEEPSEEK_API_KEY` option; secure
# runtime-secret persistence is intentionally handled separately.
ENV LLM_PROVIDER=deepseek-v4

RUN apt update
RUN apt -y install npm

COPY package.json /elastic-agent/package.json
RUN npm install

