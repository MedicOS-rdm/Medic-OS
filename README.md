# MedicOs — Plataforma multi-consultorio (SaaS) para varios médicos

MVP funcional de una plataforma que **varios médicos independientes,
que ni se conocen entre sí, pueden usar al mismo tiempo sin ver los datos
del otro**. Cada consultorio (clínica) tiene sus propios pacientes, citas,
expedientes, recetas, secretarias y configuración — completamente
aislados de los demás a nivel de base de datos, no solo de pantalla.

Módulos incluidos:

- **Agenda**: gestión de pacientes, creación de citas y flujo de estatus
  en tiempo real (Programada → Confirmada → En sala de espera → En
  consulta → Finalizada, con salidas a Cancelada / No asistió).
- **Expediente Clínico**: nota de evolución formato **SOAP**, IMC
  automático, buscador de diagnóstico CIE-10 (con edición de notas ya
  guardadas).
- **Receta Electrónica**: buscador de medicamentos, **PDF con código QR**
  de validación (editable después de emitida, por si hubo un error).
- **Certificados médicos** (incapacidad/reposo, aislamiento, teletrabajo):
  diagnóstico (CIE-10), cuadro clínico, rango de fechas con cálculo
  automático de días, y **PDF** con el mismo formato de un certificado
  real (datos del establecimiento, datos del paciente, motivo de
  aislamiento/enfermedad, fechas escritas en letras — ej. "QUINCE DE
  JULIO DEL DOS MIL VEINTISÉIS") — también editable después de emitido.
- **Login y roles**: **Médico** (acceso total a su clínica) y
  **Secretaria** (solo agenda y contacto de su clínica; el backend le
  bloquea con 403 todo lo clínico).
- **Recordatorios automáticos** (WhatsApp/SMS vía Twilio, o modo
  simulado): confirma o cancela la cita sola cuando el paciente responde.
- **Multi-consultorio (multi-tenant)**: tú, como dueño de la plataforma,
  das de alta cada consultorio nuevo desde una página de administración
  (`/admin.html`) — no hay registro público. Cada médico solo ve lo suyo,
  y el perfil del médico queda pre-llenado desde que se crea la cuenta.
- **Número de historia clínica automático**: 0001, 0002... por
  consultorio, editable si el médico prefiere otra numeración.

## Estructura

```
ece-agenda/
  backend/    API REST (Node.js + Express + PostgreSQL + JWT + pdfkit + qrcode + twilio)
  frontend/   Interfaz web (React + Vite)
```

## Base de datos (PostgreSQL / Neon)

La app usa **PostgreSQL**, no un archivo local — esto es intencional y
resuelve un problema real: los planes gratis de hosting (Render incluido)
borran el disco del servidor en cada despliegue, así que una base de
datos en archivo local (como SQLite) pierde todo cada vez que se
actualiza el código. Postgres administrado vive fuera del servidor web y
sobrevive a cualquier despliegue, reinicio, o "dormida" del servicio.

Recomendamos **[Neon](https://neon.tech)**: tiene un plan gratis
permanente (no es una prueba de 30 días), no pide tarjeta, y da hasta 10
proyectos con 0.5 GB cada uno — de sobra para este MVP.

**Crear la base de datos (una sola vez):**
1. Ve a [neon.tech](https://neon.tech) y crea una cuenta gratis.
2. Crea un proyecto nuevo (cualquier nombre, ej. "medicos").
3. En el dashboard del proyecto, copia la **cadena de conexión**
   ("Connection string") — se ve algo así:
   `postgresql://usuario:contraseña@ep-algo.neon.tech/neondb?sslmode=require`
4. Esa cadena completa es tu `DATABASE_URL`.

## Cómo correrlo

**0. Variables de entorno.** En la terminal del backend, antes de
`npm run dev`, define:
```bash
export DATABASE_URL="postgresql://usuario:contraseña@ep-algo.neon.tech/neondb?sslmode=require"
export ADMIN_SECRET="elige-una-clave-larga-y-dificil-de-adivinar"
```
(`ADMIN_SECRET` es tuya, del dueño de la plataforma — no se la das a los
médicos. Ver más abajo cómo no tener que repetir esto en cada terminal
nueva.)

**1. Backend**
```bash
cd backend
npm install
npm run dev        # http://localhost:4000
```
La primera vez que arranca, crea automáticamente todas las tablas en tu
base de Neon (no hace falta ejecutar ningún script aparte).

**2. Frontend** (en otra terminal)
```bash
cd frontend
npm install
npm run dev         # http://localhost:5173
```

**3. Da de alta el primer consultorio.** Abre
`http://localhost:5173/admin.html` (nota: es `/admin.html`, no la app
normal). Ahí metes la `ADMIN_SECRET` que definiste en el paso 0, y llenas
el formulario: nombre del consultorio, nombre del médico, usuario,
contraseña, y opcionalmente sus datos (cédula, especialidad, dirección,
etc. — quedan pre-llenados en "Perfil del médico"). Esos son los datos
que le compartes al médico para que entre a `http://localhost:5173` con
su usuario y contraseña.

Repite el paso 3 cada vez que quieras dar de alta a un médico nuevo —
cada uno queda completamente aislado de los demás.

**Dentro de la app normal**, cada médico puede entrar a "Gestionar
usuarios" para crear cuentas de Secretaria (solo para su propia clínica),
"Perfil del médico" para completar/corregir sus datos, y "Recordatorios"
para activar los avisos automáticos — todo eso ya sin necesitar tu ayuda.

### Guardar las variables permanentemente en Codespaces (opcional)

Para no tener que escribir los `export` cada vez que abres una terminal
nueva, crea un archivo `backend/.env` con:
```
DATABASE_URL=postgresql://usuario:contraseña@ep-algo.neon.tech/neondb?sslmode=require
ADMIN_SECRET=elige-una-clave-larga-y-dificil-de-adivinar
```
y agrega `dotenv/config` al inicio de `backend/src/server.js`
(`import "dotenv/config";`) después de instalar `npm install dotenv` en
`backend/`. (No es obligatorio para el MVP — el `export` manual funciona
igual de bien mientras estés probando, solo hay que repetirlo por
terminal nueva.)

## Cómo probar los recordatorios SIN contratar nada

Por defecto el proveedor es **"Simulado"**: no manda ningún WhatsApp/SMS
real, solo lo registra en la consola del backend (`[recordatorio SIMULADO
-> tel] mensaje`) y en el historial de la cita ("✓ Recordatorio enviado").
Sirve para probar todo el flujo de la interfaz. Para probar la respuesta
automática del paciente (1 = confirmar, 2 = cancelar) sin un teléfono
real, simula la llamada que haría el paciente con curl:

```bash
curl -X POST http://localhost:4000/api/reminders/webhook \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=+521XXXXXXXXXX&Body=1"
```
(usa el mismo teléfono que le pusiste al paciente). Verás la cita cambiar
a "Confirmada" en la agenda.

## Cómo conectar WhatsApp/SMS de verdad (Twilio)

1. Crea una cuenta en [twilio.com](https://www.twilio.com) y activa el
   **WhatsApp Sandbox** (para pruebas) o un número real (para producción).
2. En "Recordatorios" en la app, cambia el proveedor a "WhatsApp vía
   Twilio" (o SMS) y pega tu Account SID, Auth Token y número de Twilio.
3. En la consola de Twilio, configura el webhook de mensajes entrantes
   apuntando a `https://<tu-dominio-publico>/api/reminders/webhook`.
   **Importante**: mientras trabajes en Codespaces, esa URL cambia cada
   vez que recreas el Codespace, así que para producción necesitas un
   dominio estable (ver sección de despliegue).

## Decisiones técnicas del MVP

- **PostgreSQL (Neon) en vez de SQLite**: resuelve de raíz el problema de
  persistencia en hosting gratis (ver sección de arriba). El backend usa
  un pequeño "shim" de compatibilidad en `backend/src/db.js` que traduce
  la forma de escribir consultas (`db.prepare(sql).get/all/run(...)`) al
  driver de Postgres — así el resto del código no tuvo que cambiar de
  estilo, solo se volvió `async`/`await`.
- **Migraciones de base de datos**: `initDb()` en `backend/src/db.js`
  crea las tablas si no existen y agrega columnas nuevas de forma segura
  con `ALTER TABLE ADD COLUMN IF NOT EXISTS` — nunca borra datos
  existentes. Se puede correr con seguridad aunque ya haya consultorios y
  pacientes reales.
- **El "cron" de recordatorios vive dentro del proceso del backend**
  (`setInterval` cada 15 min). Limitación: solo funciona mientras el
  servidor esté corriendo. En producción conviene un worker/cron aparte
  para que corra aunque el servidor se reinicie.
- **JWT sin refresco**: el token dura 12 horas. Si `JWT_SECRET` no está
  fijado como variable de entorno, se genera uno nuevo en cada despliegue
  (cerrando la sesión de todos) — para evitarlo, fija `JWT_SECRET` como
  variable de entorno igual que `DATABASE_URL`.
- **Contraseñas con bcrypt** (`bcryptjs`, sin dependencias nativas).
- **Buscador de diagnóstico (CIE-10)**: catálogo completo en español
  (11,000+ códigos), cargado localmente desde
  `backend/data/cie10-es.json` — no depende de ninguna API externa en
  cada búsqueda. Fuente: agregado público de la clasificación CIE-10 de
  la OMS con datos administrativos del Ministerio de Salud de Chile
  (https://github.com/verasativa/CIE-10). Es un catálogo de referencia
  general; para uso clínico regulado a gran escala en un país específico,
  conviene contrastarlo contra el catálogo oficial vigente de la
  autoridad sanitaria local (en Ecuador, el MSP). La búsqueda ignora
  tildes y acepta varias palabras en cualquier orden si el proveedor de
  Postgres permite la extensión `unaccent` (Neon sí la permite); si no,
  sigue funcionando pero exige tildes exactas.
- **Vademécum de medicamentos**: catálogo de ejemplo (~20 medicamentos),
  no oficial ni exhaustivo. Antes de un uso clínico a gran escala,
  conviene sustituirlo por un catálogo completo y vigente.
- **QR de validación de recetas**: apunta a `/api/verify/:token`, público
  — funciona correctamente una vez desplegado en un dominio estable (ver
  sección de despliegue).
- **Bitácora de auditoría** (`audit_log`): registra usuario real, acción,
  entidad y momento.
- **Sin cifrado adicional en reposo**: Neon cifra los datos en tránsito
  (TLS) y ofrece cifrado en reposo a nivel de infraestructura; para
  cumplimiento normativo específico (HIPAA-like, según el país), revisar
  los requisitos exactos aplicables antes de manejar pacientes reales.

## Desplegar en internet (gratis, sin instalar nada)

Codespaces es genial para desarrollar, pero su URL cambia cada vez que
recreas el Codespace — no sirve para dejar la app corriendo de forma
permanente. Para eso, despliega en **Render** (plan gratuito, todo desde
el navegador):

1. Ve a [render.com](https://render.com) y entra con tu cuenta de GitHub.
2. Clic en **"New +" → "Web Service"**.
3. Conecta tu repositorio de GitHub (el mismo de Codespaces).
4. En el formulario de configuración, llena:
   - **Build Command**: `cd frontend && npm install && npm run build && cd ../backend && npm install`
   - **Start Command**: `cd backend && npm start`
   - **Instance Type**: Free
5. Antes de crear, abre la sección **"Advanced"** y agrega estas variables
   de entorno:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = tu cadena de conexión de Neon (la misma que usas en Codespaces)
   - `ADMIN_SECRET` = una clave larga que tú inventes
   - `JWT_SECRET` = otra clave larga cualquiera (evita que un despliegue cierre la sesión de todos)
6. Clic en **"Create Web Service"**. Espera unos minutos mientras
   instala y compila (verás los logs en vivo).
7. Cuando termine, Render te da una URL pública fija, tipo
   `https://ece-agenda.onrender.com`. Ve a
   `https://ece-agenda.onrender.com/admin.html` para dar de alta
   consultorios usando tu `ADMIN_SECRET`.

**Nota sobre el plan gratis de Render**: el servicio "se duerme" tras
~15 min sin uso y tarda unos segundos en despertar con la siguiente
visita — normal, no afecta los datos (que ahora viven en Neon, no en el
servidor). Con el volumen de un consultorio real, para producción
conviene un plan de pago que no se duerma (así el webhook de Twilio y
los recordatorios automáticos responden siempre al instante).

Una vez desplegado ahí, esa es la URL que le das a Twilio como webhook
(`https://tu-app.onrender.com/api/reminders/webhook`) y la que queda
codificada en el QR de las recetas — a diferencia de Codespaces, no
cambia.

## Siguientes pasos sugeridos

1. Contrastar el catálogo CIE-10 contra el oficial vigente de la
   autoridad sanitaria local (si se requiere para cumplimiento
   normativo), y el vademécum contra un catálogo de medicamentos vigente.
2. Mover el envío de recordatorios a un worker/cron independiente del
   proceso web (para que no dependa de que el servicio esté "despierto").
3. Firma digital real del médico en la receta y el certificado.
4. Plan de pago en Render (o similar) para producción real, evitando la
   "dormida" del servicio en el plan gratis.
