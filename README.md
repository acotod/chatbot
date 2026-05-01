# chatbot

Backend para flujos conversacionales en WhatsApp con Prisma, PostgreSQL y Redis.

## Desarrollo local

Si ejecutas comandos desde tu host, como `npx prisma migrate dev`, el archivo `.env` debe apuntar a `localhost` para PostgreSQL y Redis porque `postgres` y `redis` son nombres resolubles solo dentro de la red de Docker Compose.

Docker Compose ya sobreescribe esas variables dentro de los contenedores, por lo que el backend en Docker sigue usando `postgres:5432` y `redis:6379`.
