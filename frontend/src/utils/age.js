// Calcula la edad en años cumplidos a partir de una fecha de nacimiento
// en formato "YYYY-MM-DD". Regresa null si la fecha no es válida o está
// vacía, para que los componentes puedan decidir si mostrarla o no.
export function calculateAge(birthDateStr) {
  if (!birthDateStr) return null;
  const birth = new Date(`${birthDateStr}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return age >= 0 ? age : null;
}

// Texto listo para mostrar, ej. "21 años" o "8 meses" para bebés.
export function formatAge(birthDateStr) {
  const years = calculateAge(birthDateStr);
  if (years === null) return null;
  if (years >= 1) return `${years} año${years === 1 ? "" : "s"}`;

  // Menores de 1 año: mostramos la edad en meses para que sea útil.
  const birth = new Date(`${birthDateStr}T00:00:00`);
  const today = new Date();
  let months = (today.getFullYear() - birth.getFullYear()) * 12 + (today.getMonth() - birth.getMonth());
  if (today.getDate() < birth.getDate()) months--;
  months = Math.max(months, 0);
  return `${months} mes${months === 1 ? "" : "es"}`;
}
