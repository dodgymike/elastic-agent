FROM ubuntu:latest

WORKDIR /elastic-agent/

RUN apt update
RUN apt -y install npm

COPY package.json /elastic-agent/package.json
RUN npm install

