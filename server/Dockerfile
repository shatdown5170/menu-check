# Cloud Run 용 컨테이너 (asia-northeast3)
FROM node:22-slim

WORKDIR /app

# 의존성 먼저 설치 (레이어 캐시 활용)
COPY package*.json ./
RUN npm install --omit=dev

# 앱 소스 복사
COPY . .

# Cloud Run은 PORT 환경변수를 주입 (기본 8080)
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "index.js"]
