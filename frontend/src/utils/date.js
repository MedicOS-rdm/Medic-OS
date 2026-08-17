// Devuelve la fecha de HOY (o de cualquier Date) como texto "YYYY-MM-DD"
// usando la hora LOCAL del navegador — nunca .toISOString(), que primero
// convierte a UTC. Ecuador está detrás de UTC (UTC-5), así que cerca de
// la noche (después de las 19:00 aprox.) .toISOString() ya cae en el día
// siguiente en UTC, y la app terminaba mostrando "mañana" en vez de "hoy"
// (mismo tipo de bug que el de las horas en los certificados/recetas,
// pero aquí afectando la fecha del calendario).
export function localISODate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
