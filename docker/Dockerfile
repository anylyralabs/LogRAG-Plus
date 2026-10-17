# LogRAG+ 服务镜像（Node + 前端产物）
#
# ⚠️ 本文件**尚未在真实 Docker 中构建过**：开发机（Termux / Android）没有容器运行时。
#    首次部署前请在服务器上 `docker compose -f docker/compose.yaml build` 验证。
#    之所以仍然先写出来，是因为它决定了镜像里必须有哪些文件（prompts/、knowledge/、
#    web/dist），而这三处正是「本地 tsx 直跑能跑、容器里跑不起来」的经典缺口。
#
# 分四个阶段，各自只装自己需要的东西：
#   web     构建前端（需要 devDependencies）
#   build   编译 TypeScript（需要 typescript）
#   deps    只装生产依赖（langchain 等，体积最大的部分）
#   runtime 只装运行时（无 npm、无源码、无 devDeps）
#
# 服务以**编译产物**运行（`node dist/server.js`）而不是 `tsx src/server.ts`：
# 少一个进程（tsx 是转译器包装）、启动更快，且与 `npm start` 走同一条路径——
# 两条运行路径不一致时，「本地能跑、线上不能跑」会变得极难定位。
# `npm run build` 走 `tsconfig.build.json`（rootDir=src），产物入口即 `dist/server.js`。

# ── ① 前端产物 ──────────────────────────────────────────
FROM node:24-alpine AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ── ② TypeScript 编译 ──────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# ── ③ 生产依赖 ─────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ── ④ 运行时 ───────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# 运行时要读的东西，一个都不能少：
#   dist/        服务本体
#   node_modules 生产依赖
#   prompts/     提示词资产（启动时按工作目录 ./prompts 读取）
#   knowledge/   知识库源文件（索引重建时用；检索只读 index.db）
#   web/dist     前端页面
COPY --from=deps /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./
COPY prompts/ ./prompts/
COPY knowledge/ ./knowledge/
COPY --from=web /build/web/dist ./web/dist

# 数据目录先建好并交给 node 用户：命名卷首次创建时会**继承镜像内该目录的所有者**，
# 否则容器以 node 身份跑、卷却归 root，表现为「启动即 SQLITE_CANTOPEN」。
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8788

# 健康检查用 node 自带的 fetch：alpine 里没有 curl，busybox 的 wget 又依赖构建细节，
# 而 node 一定在。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
