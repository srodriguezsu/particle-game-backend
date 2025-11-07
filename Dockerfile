# Usa una imagen oficial de Node
FROM node:20-alpine

# Crea el directorio de la app
WORKDIR /usr/src/app

# Copia los archivos necesarios
COPY package*.json ./

# Instala dependencias en modo producción
RUN npm install --only=production

# Copia el resto del código
COPY . .

# Expone el puerto 8080
EXPOSE 8080

# Comando de inicio
CMD ["node", "server.js"]
